// scripts/smoke-test-executor.ts
//
// The recipe interpreter, end to end, with STUB handlers - proving the
// deterministic machinery before the LLM is involved:
//
//   - the DFMEA recipe validates (no forward refs, targets real sections)
//   - steps execute in order, outputs thread forward through the bag
//   - a custody event is emitted per step (references only)
//   - a gap in a generated section forces reviewRequired
//   - a failed critical gate forces reviewRequired
//   - execution HALTS at require_human and reports haltedForHuman
//
// The stubs stand in for the LLM so this runs with Postgres only - no Ollama.
// The real handlers (handlers.ts) slot into the same interface.
//
// Usage: npm run smoke:executor

import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { getRubric } from "../src/drafting/rubric-loader.js";
import { recipeSchema } from "../src/drafting/recipe.js";
import { executeRecipe, type StepHandlers } from "../src/drafting/executor.js";
import { validateSection, type ProducedRow } from "../src/drafting/section-validator.js";
import { sectionSchema } from "../src/drafting/section-schema.js";
import { scoreRubric, type CriterionVerdict } from "../src/drafting/scoring.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
const custody = { correlationId, runId: `run_exec`, userId: "u-test", decisionId: "d", policyHash: "p" };

// Stub handlers: deterministic stand-ins. generate_section produces a section
// with one deliberate GAP (missing detection) to exercise the gap path.
function makeStubs(rubric: ReturnType<typeof getRubric>["rubric"], opts: { gap: boolean; critFail: boolean }): StepHandlers {
  return {
    async retrieve_sections(step) {
      return { source: step.source, sections: step.sections.map((id) => ({ id, text: `SOP ${id} text` })) };
    },
    async query_table(step) {
      return { collection: step.collection, rows: [{ risk_id: "R-014", subsystem: "Battery" }], coverage: "Covered 1 of 1." };
    },
    async recall_prior(step) {
      return { documentType: step.documentType, export: step.export, ids: new Set(["R-014", "R-022"]) };
    },
    async generate_section(step) {
      const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === step.sectionId));
      const row: ProducedRow = {
        item: { value: "Battery pack", sourceRef: "R-014" },
        failure_mode: { value: "Thermal runaway" },
        effect: { value: "Venting" },
        risk_ref: { value: "R-014", sourceRef: "R-014" },
        severity: { value: 9, sourceRef: "sop" },
        occurrence: { value: 3, sourceRef: "sop" },
        detection: opts.gap ? { value: null } : { value: 4, sourceRef: "sop" },
        rpn: { value: null },
      };
      const validation = validateSection(spec, [row], { "risk-register.riskItems.id": new Set(["R-014", "R-022"]) });
      return { sectionId: step.sectionId, validation };
    },
    async validate_section(step, bag) {
      const prior = bag["gen_fm"] as { validation: ReturnType<typeof validateSection> };
      return { sectionId: step.sectionId, validation: prior.validation };
    },
    async judge(step, bag, rb) {
      // Stub verdicts: all pass, unless critFail flips a critical criterion.
      const verdicts: CriterionVerdict[] = rb.criteria.map((c) => ({
        id: c.id,
        verdict: opts.critFail && c.gate === "critical" ? "fail" : "pass",
        source: "llm_judge",
        rationale: "",
      }));
      return { result: scoreRubric(rb, verdicts) };
    },
    async require_human(step) {
      return { disposition: "pending" };
    },
  };
}

async function main(): Promise<void> {
  console.log("=== Recipe executor smoke test (stub handlers) ===\n");
  process.env.QMS_DOMAIN = "engineering";

  const { rubric } = getRubric("dfmea");
  const recipe = recipeSchema.parse(rubric.recipe);
  check("dfmea has a recipe", recipe.steps.length === 7, `${recipe.steps.length} steps`);
  check("recipe ends at a human gate", recipe.steps[recipe.steps.length - 1].kind === "require_human");

  try {
    // --- Clean run: no gap, gate passes, halts at human ---
    const clean = await executeRecipe(rubric, recipe.steps, makeStubs(rubric, { gap: false, critFail: false }), custody);
    check("clean run halts for human", clean.haltedForHuman);
    check("clean run threaded all prior outputs", Boolean(clean.bag["gen_fm"] && clean.bag["score"]));
    check("clean run: RPN was computed (9*3*4=108)",
      (clean.bag["gen_fm"] as any).validation.rows[0].values.rpn === 108);
    check("clean run: judge scored, gate passed", clean.rubricResult?.gatePassed === true);
    check("clean run: no review forced by content", !((clean.bag["gen_fm"] as any).validation.hasGaps));

    // --- Gap run: missing detection -> reviewRequired ---
    const gapCustody = { ...custody, runId: "run_gap" };
    const gappy = await executeRecipe(rubric, recipe.steps, makeStubs(rubric, { gap: true, critFail: false }), gapCustody);
    check("gap run forces reviewRequired", gappy.reviewRequired);
    check("  detection marked insufficient_evidence",
      (gappy.bag["gen_fm"] as any).validation.rows[0].values.detection === "insufficient_evidence");
    check("  RPN could not compute either", (gappy.bag["gen_fm"] as any).validation.rows[0].values.rpn === "insufficient_evidence");

    // --- Critical-fail run: gate blocks ---
    const critCustody = { ...custody, runId: "run_crit" };
    const crit = await executeRecipe(rubric, recipe.steps, makeStubs(rubric, { gap: false, critFail: true }), critCustody);
    check("critical fail: gate FAILED", crit.rubricResult?.gatePassed === false);
    check("  review required", crit.reviewRequired);

    // --- Custody: a full chain was written for the clean run ---
    const events = await db.execute(sql`
      SELECT event_type FROM custody_events WHERE run_id = 'run_exec' ORDER BY seq ASC
    `);
    const types = (events.rows as { event_type: string }[]).map((r) => r.event_type);
    check("custody: one event per executed step",
      types.length === 7, `${types.length} events: ${types.join(",")}`);
    check("custody: generation event present", types.includes("generation"));
    check("custody: judge event present", types.includes("judge"));
    check("custody: ends at human_decision", types[types.length - 1] === "human_decision");

  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} crashed - ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Recipe executor is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();