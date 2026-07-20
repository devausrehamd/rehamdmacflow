// scripts/smoke-test-dag-history.ts
//
// The DAG History store (Stage 3 of the agent-platform spec). Proves the durable,
// write-ahead, per-agent trajectory - the record that survives an agent VM being
// destroyed. Checks:
//
//   - write-ahead append: each step is durable immediately; readback in order
//   - IDEMPOTENT on (correlationId, agentGuid, seq): a duplicate is a no-op and
//     does NOT overwrite the original
//   - terminal marker closes a run (success or failure)
//   - reconciliation: whereDidItStop finds a mid-operation stop (no terminal) vs
//     a completed run, per agent lane
//   - resumePoint returns the last ok step with an artifact
//   - the mirrorRunStep adapter writes a run step into the trajectory
//
// Needs Postgres. No LLM, no Qdrant.
//
// Usage: npm run smoke:dag-history

import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { agent_trajectory } from "../src/db/schema.js";
import {
  recordTrajectoryStep,
  recordTerminal,
  mirrorRunStep,
  readTrajectory,
  whereDidItStop,
  resumePoint,
} from "../src/platform/trajectory-history.js";

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

const cor = `cor_${Date.now().toString(16).padStart(24, "0")}`;
const A = "agent-a";
const B = "agent-b";
const C = "agent-c";

async function main(): Promise<void> {
  console.log("=== DAG History (trajectory) smoke test ===\n");

  try {
    // --- Agent A: three write-ahead steps, the last two producing artifacts ---
    await recordTrajectoryStep({ correlationId: cor, agentGuid: A, seq: 0, capability: "research:qms", kind: "retrieve", input: { q: "defect" }, status: "ok" });
    await recordTrajectoryStep({ correlationId: cor, agentGuid: A, seq: 1, capability: "research:qms", kind: "query_table", input: { table: "risks" }, outputRef: "hashA1", status: "ok" });
    await recordTrajectoryStep({ correlationId: cor, agentGuid: A, seq: 2, capability: "research:qms", kind: "assemble", outputRef: "hashA2", status: "ok" });

    const aRows = (await readTrajectory(cor)).filter((r) => r.agent_guid === A);
    check("write-ahead append: three steps readable in order", aRows.length === 3 && aRows[0]?.seq === 0 && aRows[2]?.seq === 2);

    // --- Idempotency: re-post seq 1 with different content -> no-op, original kept ---
    await recordTrajectoryStep({ correlationId: cor, agentGuid: A, seq: 1, kind: "TAMPERED", status: "error" });
    const aAgain = (await readTrajectory(cor)).filter((r) => r.agent_guid === A);
    check("duplicate (cor,guid,seq) is a no-op (still three rows)", aAgain.length === 3);
    check("  the original row is preserved, not overwritten", aAgain.find((r) => r.seq === 1)?.kind === "query_table");

    // --- Reconciliation before terminal: A stopped at seq 2, no terminal marker ---
    let stops = await whereDidItStop(cor);
    const aStop = stops.find((s) => s.agentGuid === A);
    check("whereDidItStop: A at last seq 2, not terminated", aStop?.lastSeq === 2 && aStop?.terminated === false);

    // --- Resume point: last ok step with an artifact ---
    const rp = await resumePoint(cor, A);
    check("resumePoint is the last ok step with an artifact (seq 2, hashA2)", rp?.seq === 2 && rp.outputRef === "hashA2");

    // --- Terminal marker closes A's run ---
    await recordTerminal({ correlationId: cor, agentGuid: A, seq: 3, outcome: "completed", finalRef: "docHash" });
    stops = await whereDidItStop(cor);
    check("after terminal: A is terminated with outcome completed",
      stops.find((s) => s.agentGuid === A)?.terminated === true && stops.find((s) => s.agentGuid === A)?.outcome === "completed");

    // --- Agent B: steps but NO terminal -> died mid-operation ---
    await recordTrajectoryStep({ correlationId: cor, agentGuid: B, seq: 0, kind: "retrieve", status: "ok" });
    await recordTrajectoryStep({ correlationId: cor, agentGuid: B, seq: 1, kind: "fetch", status: "ok", outputRef: "hashB1" });
    const bStop = (await whereDidItStop(cor)).find((s) => s.agentGuid === B);
    check("agent with no terminal reads as stopped mid-operation (B at seq 1)", bStop?.terminated === false && bStop?.lastSeq === 1);

    // --- mirrorRunStep adapter writes a run step into the trajectory ---
    await mirrorRunStep({ correlationId: cor, agentGuid: C, seq: 0, node: "understand", capability: "think:capa", input: { question: "x" }, status: "ok" });
    const cRows = (await readTrajectory(cor)).filter((r) => r.agent_guid === C);
    check("mirrorRunStep records a run step (node -> kind)", cRows.length === 1 && cRows[0]?.kind === "understand");
  } finally {
    await db.execute(sql`DELETE FROM agent_trajectory WHERE correlation_id = ${cor}`).catch(() => {});
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}DAG History is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
