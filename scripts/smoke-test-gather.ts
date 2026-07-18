// scripts/smoke-test-gather.ts
//
// Capability dispatch + parallel gather (Phase 5 of the agent-topology /
// custody-DAG spec). This is where Phases 1-4 connect into a pipeline. Proves:
//
//   - a gather step fans out to N capabilities IN PARALLEL, each yielding one
//     content-addressed artifact
//   - ORDER-INDEPENDENCE: the same requests with a different provider completion
//     order produce identical artifact ids (content-addressed) in the same order
//   - through the executor: one gather_complete references every artifact; the
//     gathered values flow to the readiness gate (which passes); the thinker runs
//     and its generation event references the gathered artifacts (the DAG edge)
//   - SINGLE-WRITER: the gather orchestration and capability layer never write
//     the custody chain (only the executor does)
//
// Needs Postgres. No LLM (providers are stubs).
//
// Usage: npm run smoke:gather

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { custody_events, custody_artifacts } from "../src/db/schema.js";
import { inProcessRegistry, type CapabilityProvider } from "../src/orchestrator/capabilities.js";
import { runGather, type GatherRequest } from "../src/orchestrator/gather.js";
import { verifyChain } from "../src/custody/ledger.js";
import { verifyDagReferences, dagInputs } from "../src/custody/dag.js";
import { rubricSchema, type Rubric } from "../src/drafting/rubric-schema.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A dumb stub researcher: waits `delay`, then returns a fixed value. It touches
 *  no custody, no artifact store — it just returns data. */
function provider(capability: string, value: unknown, delay: number): CapabilityProvider {
  return {
    capability,
    async run() {
      await sleep(delay);
      return { result: value, sourceRef: `${capability}@snap1` };
    },
  };
}

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

function rubricWithGather(): Rubric {
  return rubricSchema.parse({
    documentType: "engineering-hours-budget",
    displayName: "Engineering Hours & Budget",
    version: "1.0.0",
    reviewThreshold: 0.8,
    sections: [{ id: "s1", title: "Estimate", cardinality: "single", groundedIn: [], fields: [{ name: "f1", type: "string", provenance: "generated", required: true }] }],
    criteria: [{ id: "c1", criterion: "PASS if the estimate is grounded in the gathered inputs. FAIL otherwise.", weight: 1 }],
    requiredInputs: [
      { id: "labor_rate", description: "approved blended labor rate", capability: "research:sales" },
      { id: "duration_weeks", description: "planned duration", capability: "research:qms", min: 1, max: 260 },
    ],
    recipe: {
      steps: [
        { id: "g", kind: "gather", requests: [
          { requires: "research:sales", produces: "labor_rate" },
          { requires: "research:qms", produces: "duration_weeks" },
        ] },
        { id: "ready", kind: "check_readiness", inputs: ["g"] },
        { id: "gen", kind: "generate_section", sectionId: "s1", inputs: ["ready"] },
      ],
    },
  });
}

async function main(): Promise<void> {
  console.log("=== Capability dispatch + parallel gather smoke test ===\n");
  process.env.QMS_DOMAIN = "engineering";
  const artifactHashes = new Set<string>();

  const requests: GatherRequest[] = [
    { requires: "research:web", produces: "market_rate" },
    { requires: "research:qms", produces: "duration_weeks" },
    { requires: "research:sales", produces: "labor_rate" },
  ];
  const ctx = { correlationId: "cor_gather_pure", runId: "run_pure", producedAt: "2026-01-01T00:00:00.000Z" };

  try {
    // ---------- 1. runGather fan-out + order-independence ----------
    // reg1: sales finishes first, web last. reg2: reversed. Same content either way.
    const reg1 = inProcessRegistry([provider("research:web", 190, 25), provider("research:qms", 30, 12), provider("research:sales", 185, 1)]);
    const reg2 = inProcessRegistry([provider("research:web", 190, 1), provider("research:qms", 30, 12), provider("research:sales", 185, 25)]);

    const out1 = await runGather(requests, reg1, ctx);
    const out2 = await runGather(requests, reg2, ctx);
    out1.artifactIds.forEach((h) => artifactHashes.add(h));
    out2.artifactIds.forEach((h) => artifactHashes.add(h));

    check("fan-out produced one artifact per request", out1.artifactIds.length === 3);
    check("gathered inputs keyed by produces, in request order",
      out1.inputs.map((i) => i.produces).join(",") === "market_rate,duration_weeks,labor_rate");
    check("artifact ids are order-independent (identical despite reversed completion order)",
      JSON.stringify(out1.artifactIds) === JSON.stringify(out2.artifactIds), JSON.stringify(out1.artifactIds));
    check("idempotent: reversed run added no new artifact ids", out1.artifactIds.every((h) => out2.artifactIds.includes(h)));

    // ---------- 2. Through the executor: the whole pipeline ----------
    const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
    const custody = { correlationId, runId: newRunId(), userId: "u-eng-lead" };
    const registry = inProcessRegistry([provider("research:sales", 185, 5), provider("research:qms", 30, 2)]);
    const counter = { gen: 0 };

    const rubric = rubricWithGather();
    const res = await executeRecipe(rubric, rubric.recipe.steps, makeStubs(counter), custody, undefined, undefined, registry);

    check("readiness passed on the gathered bundle", res.readiness?.ready === true);
    check("the thinker ran (gate did not halt)", counter.gen === 1 && res.haltedForHuman === false);

    const events = await db
      .select({ type: custody_events.event_type, payload: custody_events.payload })
      .from(custody_events)
      .where(sql`${custody_events.correlation_id} = ${correlationId}`)
      .orderBy(sql`${custody_events.seq} ASC`);
    const gatherEvents = events.filter((e) => e.type === "gather_complete");
    check("exactly ONE gather_complete event", gatherEvents.length === 1, `saw ${gatherEvents.length}`);
    const gatherRefs = dagInputs(gatherEvents[0]?.payload);
    check("gather_complete references both gathered artifacts", gatherRefs.length === 2);
    gatherRefs.forEach((h) => artifactHashes.add(h));

    const genEvent = events.find((e) => e.type === "generation");
    const genRefs = dagInputs(genEvent?.payload);
    check("the generation event references the gathered artifacts (DAG edge)",
      genRefs.length === 2 && genRefs.every((h) => gatherRefs.includes(h)));

    const chain = await verifyChain({ correlationId });
    check("the chain verifies", chain.ok, chain.detail);
    const dag = await verifyDagReferences({ correlationId });
    check("the DAG references all verify (gather + generation)", dag.ok && dag.eventsWithRefs === 2);

    // ---------- 3. Single-writer: role/orchestration code never writes the chain ----------
    const gatherSrc = readFileSync(new URL("../src/orchestrator/gather.ts", import.meta.url), "utf8");
    const capsSrc = readFileSync(new URL("../src/orchestrator/capabilities.ts", import.meta.url), "utf8");
    check("gather orchestration never writes the chain (no appendEvent)", !/appendEvent/.test(gatherSrc));
    check("capability layer never writes custody (no appendEvent, no putArtifact)",
      !/appendEvent/.test(capsSrc) && !/putArtifact/.test(capsSrc));

    // cleanup events
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
  } finally {
    for (const h of artifactHashes) {
      await db.execute(sql`DELETE FROM custody_artifacts WHERE hash = ${h}`).catch(() => {});
    }
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Capability dispatch + gather is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
