// scripts/smoke-test-readiness.ts
//
// The readiness gate (Phase 4 of the agent-topology / custody-DAG spec). A
// DETERMINISTIC input gate before the thinker. Proves:
//
//   - a complete bundle is ready; the thinker would proceed
//   - a missing required input -> not ready, and the gap NAMES the input and the
//     capability that should have supplied it
//   - a present-but-out-of-range value -> a gap with a reason (no LLM involved)
//   - an optional input missing is fine
//   - through the executor: a required-but-empty bundle HALTS before any
//     generate step (the generate stub is never called), sets reviewRequired,
//     and writes a readiness_gate custody event; a rubric with no required
//     inputs proceeds past the gate
//
// The pure checks need nothing; the executor checks need Postgres. No LLM.
//
// Usage: npm run smoke:readiness

import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { custody_events } from "../src/db/schema.js";
import { rubricSchema, type Rubric } from "../src/drafting/rubric-schema.js";
import { evaluateReadiness, bundleFromBag, type InputBundle } from "../src/drafting/readiness.js";
import { executeRecipe, type StepHandlers, type StepOutputs } from "../src/drafting/executor.js";
import { newRunId } from "../src/custody/correlation.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

// A budget-and-hours doc type: needs a labor rate (from sales) and a duration
// bounded to 1-260 weeks (from qms), plus an optional stretch note.
function buildRubric(steps: unknown[]): Rubric {
  return rubricSchema.parse({
    documentType: "engineering-hours-budget",
    displayName: "Engineering Hours & Budget",
    version: "1.0.0",
    reviewThreshold: 0.8,
    sections: [
      { id: "s1", title: "Estimate", cardinality: "single", groundedIn: [], fields: [{ name: "f1", type: "string", provenance: "generated", required: true }] },
    ],
    criteria: [{ id: "c1", criterion: "PASS if the estimate is grounded in the gathered inputs. FAIL otherwise.", weight: 1 }],
    requiredInputs: [
      { id: "labor_rate", description: "approved blended labor rate", capability: "research:sales" },
      { id: "duration_weeks", description: "planned duration", capability: "research:qms", min: 1, max: 260 },
      { id: "stretch_note", description: "optional stretch-goal note", capability: "research:web", required: false },
    ],
    recipe: { steps },
  });
}

function bundle(entries: Record<string, { value: unknown; capability?: string }>): InputBundle {
  const b: InputBundle = {};
  for (const [id, v] of Object.entries(entries)) b[id] = v;
  return b;
}

/** Stub handlers. Only generate_section should ever matter here; it counts its
 *  calls so we can prove the gate halts BEFORE it. */
function makeStubs(counter: { gen: number }): StepHandlers {
  const nope = (k: string) => async (): Promise<never> => { throw new Error(`unexpected handler call: ${k}`); };
  return {
    retrieve_sections: nope("retrieve_sections") as StepHandlers["retrieve_sections"],
    query_table: nope("query_table") as StepHandlers["query_table"],
    recall_prior: nope("recall_prior") as StepHandlers["recall_prior"],
    async generate_section() {
      counter.gen++;
      return { sectionId: "s1", validation: { rows: [], findings: [], hasGaps: false, hasErrors: false } } as unknown as StepOutputs["generate_section"];
    },
    validate_section: nope("validate_section") as StepHandlers["validate_section"],
    judge: nope("judge") as StepHandlers["judge"],
    require_human: nope("require_human") as StepHandlers["require_human"],
  };
}

async function main(): Promise<void> {
  console.log("=== Readiness gate smoke test ===\n");
  process.env.QMS_DOMAIN = "engineering";
  const rubric = buildRubric([]);

  // ---------- Pure evaluator (no DB, no LLM) ----------
  const complete = bundle({
    labor_rate: { value: 185, capability: "research:sales" },
    duration_weeks: { value: 30, capability: "research:qms" },
  });
  const r1 = evaluateReadiness(rubric, complete);
  check("complete bundle is ready", r1.ready && r1.gaps.length === 0);

  const r2 = evaluateReadiness(rubric, bundle({ duration_weeks: { value: 30 } }));
  check("missing required input -> not ready", !r2.ready);
  check("gap names the missing input and its capability",
    r2.gaps.some((g) => g.inputId === "labor_rate" && g.capability === "research:sales"),
    JSON.stringify(r2.gaps));

  const r3 = evaluateReadiness(rubric, bundle({
    labor_rate: { value: 185 },
    duration_weeks: { value: 300 }, // exceeds max 260
  }));
  check("out-of-range value -> not ready with a reason",
    !r3.ready && r3.gaps.some((g) => g.inputId === "duration_weeks" && /exceeds the maximum/.test(g.reason)),
    JSON.stringify(r3.gaps));

  check("optional input missing is fine", evaluateReadiness(rubric, complete).ready);

  // bundleFromBag: extracts gather-style entries, ignores others.
  const extracted = bundleFromBag({
    g1: { produces: "labor_rate", value: 185, capability: "research:sales" },
    other: { source: "sop", sections: [] },
  });
  check("bundleFromBag extracts gathered inputs, ignores non-gather entries",
    extracted.labor_rate?.value === 185 && Object.keys(extracted).length === 1);

  // ---------- Through the executor (needs Postgres) ----------
  const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
  const custody = { correlationId, runId: newRunId(), userId: "u-eng-lead" };

  try {
    // (a) required inputs, but nothing gathered -> HALT before generate.
    const counterA = { gen: 0 };
    const gated = buildRubric([
      { id: "ready", kind: "check_readiness" },
      { id: "gen", kind: "generate_section", sectionId: "s1", inputs: ["ready"] },
    ]);
    const resA = await executeRecipe(gated, gated.recipe.steps, makeStubs(counterA), custody);
    check("gate HALTS before the thinker (generate never called)", counterA.gen === 0);
    check("halt sets reviewRequired", resA.reviewRequired === true);
    check("halt surfaces the gaps", (resA.readiness?.gaps.length ?? 0) >= 1 && resA.readiness?.ready === false);
    check("halt did NOT proceed to a human gate", resA.haltedForHuman === false);

    const evated = await db
      .select({ payload: custody_events.payload })
      .from(custody_events)
      .where(sql`${custody_events.correlation_id} = ${correlationId} AND ${custody_events.event_type} = 'readiness_gate'`);
    check("a readiness_gate custody event was written", evated.length === 1);
    check("the event records ready:false", (evated[0]?.payload as { ready?: boolean })?.ready === false);

    // (b) no required inputs -> gate passes -> proceeds past it.
    const counterB = { gen: 0 };
    const open = rubricSchema.parse({
      ...JSON.parse(JSON.stringify(gated)),
      requiredInputs: [],
      recipe: { steps: [{ id: "ready", kind: "check_readiness" }] },
    });
    const resB = await executeRecipe(open, open.recipe.steps, makeStubs(counterB), { ...custody, runId: newRunId() });
    check("no required inputs -> gate is ready", resB.readiness?.ready === true);
    check("ready gate does not halt or force review", resB.haltedForHuman === false && resB.reviewRequired === false);
  } finally {
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Readiness gate is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
