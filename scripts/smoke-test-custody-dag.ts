// scripts/smoke-test-custody-dag.ts
//
// The provenance DAG on top of the linear custody chain (Phase 2 of the
// agent-topology / custody-DAG spec). Proves the two complementary
// tamper-evidence guarantees that let a PARALLEL gather phase keep a valid
// record with a single writer:
//
//   - a fan-in gather_complete + a generation event reference their artifacts by
//     hash (payload.inputs); the chain and the DAG both verify clean
//   - tampering an ARTIFACT's stored body is caught by verifyDagReferences /
//     verifyArtifact (content side) while the chain still verifies — showing the
//     two mechanisms are complementary, not redundant
//   - tampering an EVENT's recorded inputs list is caught by verifyChain,
//     because payload.inputs is inside the hashed material
//   - the artifact store never writes custody (single-writer invariant)
//
// Needs Postgres. No LLM, no Qdrant.
//
// Usage: npm run smoke:custody-dag

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { custody_events, custody_artifacts } from "../src/db/schema.js";
import { putArtifact, artifactId, verifyArtifact, type Artifact } from "../src/custody/artifacts.js";
import { appendEvent, verifyChain } from "../src/custody/ledger.js";
import { recordGather, verifyDagReferences, DAG_INPUTS_KEY } from "../src/custody/dag.js";
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

const AT = "2026-01-01T00:00:00.000Z";
function artifact(capability: string, result: unknown): Artifact {
  return { producer: `inproc:${capability.split(":")[1]}`, capability, query: { for: "eng-hours-budget" }, result, producedAt: AT };
}

async function main(): Promise<void> {
  console.log("=== Custody DAG smoke test ===\n");
  process.env.QMS_DOMAIN = "engineering";

  const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
  const ctx = { correlationId, runId: newRunId(), userId: "u-eng-lead" };
  const artifactHashes: string[] = [];

  try {
    // --- Three researchers ran in parallel; each produced a content-addressed
    //     artifact. (Here we just build them; parallelism is proven in Phase 5.)
    const web = artifact("research:web", { marketRate: 190 });
    const qms = artifact("research:qms", { approvedRate: 185, sop: "labor-standards" });
    const sales = artifact("research:sales", { budgetCeiling: 240000 });
    const idWeb = await putArtifact(web);
    const idQms = await putArtifact(qms);
    const idSales = await putArtifact(sales);
    artifactHashes.push(idWeb, idQms, idSales);

    // --- Orchestrator fan-in: ONE gather_complete referencing all three ---
    const gather = await recordGather(ctx, [idWeb, idQms, idSales]);
    // --- Thinker consumed them: a generation event referencing the same hashes.
    const gen = await appendEvent(ctx, "generation", {
      kind: "generation",
      sectionId: "engineering_hours_budget",
      [DAG_INPUTS_KEY]: [idWeb, idQms, idSales],
    });
    check("gather_complete then generation appended in order", gather.seq < gen.seq);

    // --- Clean state: both the chain and the DAG verify ---
    const chain0 = await verifyChain({ correlationId });
    check("chain verifies clean", chain0.ok, chain0.detail);
    const dag0 = await verifyDagReferences({ correlationId });
    check("DAG verifies clean", dag0.ok);
    check("DAG checked both referencing events", dag0.eventsWithRefs === 2, `saw ${dag0.eventsWithRefs}`);
    check("DAG checked all six artifact references", dag0.artifactsChecked === 6, `saw ${dag0.artifactsChecked}`);

    // --- Tamper an ARTIFACT's stored body (id unchanged in the row) ---
    const tampered = { ...qms, result: { approvedRate: 999999, sop: "labor-standards" } };
    await db.execute(sql`UPDATE custody_artifacts SET body = ${JSON.stringify(tampered)}::jsonb WHERE hash = ${idQms}`);

    check("tampered artifact fails content check", (await verifyArtifact(idQms)) === false);
    check("untouched artifact still passes", (await verifyArtifact(idWeb)) === true);

    const dag1 = await verifyDagReferences({ correlationId });
    check("DAG now reports broken references", !dag1.ok);
    check(
      "both events citing the tampered artifact are flagged",
      dag1.broken.length === 2 && dag1.broken.every((b) => b.artifactId === idQms),
      `broken=${JSON.stringify(dag1.broken.map((b) => b.eventType))}`,
    );

    // The chain is STILL intact — an artifact swap does not touch the events.
    // This is the point: the two verifiers cover different attacks.
    const chain1 = await verifyChain({ correlationId });
    check("chain still verifies (artifact tamper is content-side only)", chain1.ok);

    // --- Tamper the EVENT's recorded inputs list ---
    // payload.inputs is inside the hashed material, so editing it must break the
    // chain at that entry.
    await db.execute(
      sql`UPDATE custody_events SET payload = jsonb_set(payload, '{inputs,0}', to_jsonb(${"f".repeat(64)}::text)) WHERE seq = ${gather.seq}`,
    );
    const chain2 = await verifyChain({ correlationId });
    check("editing an event's inputs breaks the chain", !chain2.ok);
    check("chain break points at the tampered event", chain2.brokenAt === gather.seq, `brokenAt=${chain2.brokenAt}`);

    // --- Single-writer invariant: the artifact store never writes custody ---
    const artifactsSrc = readFileSync(new URL("../src/custody/artifacts.ts", import.meta.url), "utf8");
    check("artifact store never imports appendEvent (dumb, custody-free)", !/appendEvent/.test(artifactsSrc));
  } finally {
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
    for (const h of artifactHashes) {
      await db.execute(sql`DELETE FROM custody_artifacts WHERE hash = ${h}`).catch(() => {});
    }
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Custody DAG is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
