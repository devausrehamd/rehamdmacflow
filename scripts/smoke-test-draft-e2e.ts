// scripts/smoke-test-draft-e2e.ts
//
// REAL document generation. Runs the actual LLM handlers through the recipe
// interpreter and reports how well the model sewed the pre-cut panels.
//
// This is the "how well does it generate" test. Unlike the other draft smoke
// tests it needs OLLAMA running (the model is actually invoked). It produces a
// DFMEA failure-modes section grounded in the real risk register, validates it,
// judges it, and prints the quality numbers.
//
// It asserts the MACHINERY held (validation ran, custody chained, gate decided)
// - not that the model was good. Generation quality is reported for you to
// read, because a 7B's output quality is a measurement, not a pass/fail.
//
// Usage: npm run smoke:draft-e2e     (needs Postgres + Ollama)

import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { getRubric } from "../src/drafting/rubric-loader.js";
import { recipeSchema } from "../src/drafting/recipe.js";
import { executeRecipe, type StepHandlers } from "../src/drafting/executor.js";
import { llmHandlers } from "../src/drafting/handlers.js";
import { renderRubricResult } from "../src/drafting/scoring.js";
import { renderSectionCoverage, type SectionValidation } from "../src/drafting/section-validator.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const YEL = "\x1b[0;33m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
const custody = { correlationId, runId: "run_draft_e2e", userId: "u-test", decisionId: "d", policyHash: "p" };

// Deterministic handlers use fixtures for retrieval/query so the test is
// self-contained; generate_section and judge are the REAL LLM handlers.
function handlers(rubric: ReturnType<typeof getRubric>["rubric"]): StepHandlers {
  return {
    async retrieve_sections(step) {
      return { source: step.source, sections: [
        { id: "4.2", text: "Severity, occurrence, and detection are each rated 1-10 per the FMEA scale." },
        { id: "4.3", text: "RPN = severity x occurrence x detection." },
      ] };
    },
    async query_table(step) {
      // The risk register's shape, with ratings the model can ground. Each row's
      // risk_id is its citation token - the model cites "R-014" as the source.
      return { collection: step.collection, coverage: "Covered 1 of 1 risk-register.", rows: [
        { risk_id: "R-014", subsystem: "Battery", item: "Battery pack", failure_mode: "Thermal runaway under fast charge", severity: 9, occurrence: 3, detection: 4 },
        { risk_id: "R-022", subsystem: "Power", item: "Buck converter", failure_mode: "Overcurrent trip", severity: 6, occurrence: 4, detection: 5 },
      ] };
    },
    async recall_prior(step) {
      return { documentType: step.documentType, export: step.export, ids: new Set(["R-014", "R-022"]) };
    },
    generate_section: llmHandlers.generate_section, // REAL
    async validate_section(step, bag) {
      const prior = bag["gen_fm"] as { validation: SectionValidation };
      return { sectionId: step.sectionId, validation: prior.validation };
    },
    judge: llmHandlers.judge, // REAL
    async require_human() { return { disposition: "pending" as const }; },
  };
}

async function main(): Promise<void> {
  console.log("=== REAL draft generation (needs Ollama) ===\n");
  process.env.QMS_DOMAIN = "engineering";

  const { rubric } = getRubric("dfmea");
  const recipe = recipeSchema.parse(rubric.recipe);

  try {
    console.log("Generating DFMEA failure-modes section (this invokes the model)...\n");
    const result = await executeRecipe(rubric, recipe.steps, handlers(rubric), custody, {
      documentType: "dfmea",
      subject: "summit",
      originatingQueryId: "qry_draft_e2e",
    });

    // --- Machinery assertions (these MUST hold) ---
    check("execution reached the human gate", result.haltedForHuman);
    const gen = result.bag["gen_fm"] as { validation: SectionValidation } | undefined;
    check("a section was generated and validated", Boolean(gen?.validation));
    check("the draft was PERSISTED", Boolean(result.persisted?.setId));

    // --- Quality report (read, don't grade) ---
    const v = gen!.validation;
    const totalFields = v.rows.length * rubric.sections[0].fields.length;
    const gapFields = v.rows.reduce((n, r) => n + r.gaps.length, 0);
    const errs = v.findings.filter((f) => f.kind !== "missing_required");

    console.log(`\n${YEL}--- Generation quality ---${NC}`);
    console.log(`  rows generated:        ${v.rows.length}`);
    console.log(`  fields total:          ${totalFields}`);
    console.log(`  insufficient_evidence: ${gapFields}  (model correctly declined to invent)`);
    console.log(`  validation errors:     ${errs.length}  (fabrications / type / range / bad refs)`);
    for (const e of errs.slice(0, 8)) console.log(`      - [${e.kind}] row ${e.row} ${e.field}: ${e.detail}`);
    console.log(`\n  ${renderSectionCoverage(v).split("\n").join("\n  ")}`);

    // Verify RPN was computed by CODE, not the model, wherever inputs were present.
    let rpnComputedCorrectly = true;
    for (const row of v.rows) {
      const s = row.values.severity, o = row.values.occurrence, d = row.values.detection, rpn = row.values.rpn;
      if (typeof s === "number" && typeof o === "number" && typeof d === "number") {
        if (rpn !== s * o * d) rpnComputedCorrectly = false;
      }
    }
    check("RPN computed by code wherever inputs present (never trusted to model)", rpnComputedCorrectly);

    if (result.rubricResult) {
      console.log(`\n${YEL}--- Rubric evaluation ---${NC}`);
      console.log("  " + renderRubricResult(rubric, result.rubricResult).split("\n").join("\n  "));
    }

    // --- Custody chain ---
    const events = await db.execute(sql`SELECT event_type FROM custody_events WHERE run_id = 'run_draft_e2e' ORDER BY seq ASC`);
    const types = (events.rows as { event_type: string }[]).map((r) => r.event_type);
    console.log(`\n${YEL}--- Custody chain ---${NC}\n  ${types.join(" -> ")}`);
    check("custody: generation + judge + human_decision all present",
      types.includes("generation") && types.includes("judge") && types.includes("human_decision"));

    // --- READ THE PERSISTED DRAFT BACK - see the stored rows with your own eyes ---
    const stored = await db.execute(sql`
      SELECT d.section_id, d.rows, d.criterion_results, d.annotations, s.status, s.document_type
      FROM draft_documents d JOIN draft_sets s ON s.id = d.set_id
      WHERE d.correlation_id = ${correlationId}
    `);
    const row = stored.rows[0] as {
      section_id: string; rows: unknown; criterion_results: unknown; annotations: unknown;
      status: string; document_type: string;
    } | undefined;

    check("draft is queryable after the run", Boolean(row));
    check("  persisted with status pending_review", row?.status === "pending_review");
    check("  rows stored as typed JSON (not markdown text)", Array.isArray(row?.rows));

    if (row) {
      console.log(`\n${YEL}--- PERSISTED DRAFT (draft_documents, read back from Postgres) ---${NC}`);
      console.log(`  document_type: ${row.document_type}   section: ${row.section_id}   status: ${row.status}`);
      console.log(`\n  stored rows (the canonical typed artifact every renderer projects from):`);
      console.log("  " + JSON.stringify(row.rows, null, 2).split("\n").join("\n  "));
      console.log(`\n  annotations (coverage the reviewer sees):`);
      console.log("  " + JSON.stringify(row.annotations, null, 2).split("\n").join("\n  "));
    }

  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} crashed - ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message))
      console.log(`${YEL}     (is Ollama running? this test needs the model.)${NC}`);
  } finally {
    // Cleanup: draft rows (cascade from set), then custody.
    await db.execute(sql`DELETE FROM draft_sets WHERE originating_query_id = 'qry_draft_e2e'`).catch(() => {});
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Draft pipeline works end to end. Read the quality numbers above.${NC}`);
  else console.log(`${RED}${failed} machinery check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();