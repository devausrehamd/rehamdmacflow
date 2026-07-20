// scripts/smoke-test-trace-api-live.ts
//
// The diagnostic trace + DAG-History write APIs behind the Data Access API
// (decision-13 refactor R2), end to end over HTTP. Proves the rule "all database
// access is API-mediated" now holds for the stores the agent role used to write
// directly — agent_run_steps, agent_llm_calls, and agent_trajectory:
//
//   - a run step / LLM call / trajectory step is written THROUGH the API (no DB
//     client) and reaches its table
//   - the per-run seq is assigned server-side
//   - identity is stamped from the TOKEN (user_id), not the caller
//   - a terminal marker closes a trajectory run (whereDidItStop reports it)
//   - the API is the gate: every unauthenticated write is rejected (401)
//
// Starts the API server in-process, logs into the ID Server as dmaher for a
// bearer token (override with QMS_SMOKE_USER / QMS_SMOKE_PASSWORD). Needs
// Postgres + ID Server. No LLM.
//
// Usage: npm run integration:trace-api

import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { createServer } from "../src/api/server.js";
import { db, closeDb } from "../src/db/client.js";
import { agent_run_steps, agent_llm_calls } from "../src/db/schema.js";
import { readTrajectory, whereDidItStop } from "../src/platform/trajectory-history.js";
import { traceApi } from "../src/data/trace-client.js";
import { idServerLogin } from "./_login.js";

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

const TEST_PORT = 4118;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

const COR = `cor_r2test_${Date.now()}`;
const RUN = `run_r2test_${Date.now()}`;
const AGENT_GUID = `agt_r2test_${Date.now()}`;

async function main(): Promise<void> {
  console.log("=== Trace + DAG-History behind-the-API (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    // --- The API is the gate: every write endpoint rejects no-token (401) ---
    for (const path of ["run-steps", "llm-calls", "trajectory/steps", "trajectory/terminal"]) {
      const res = await fetch(`${BASE}/api/v1/data/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      check(`unauthenticated ${path} is rejected (401)`, res.status === 401, `got ${res.status}`);
    }

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    const whoami = await fetch(`${BASE}/api/v1/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    const me = (await whoami.json()) as { user: { id: string } };

    const api = traceApi(BASE, token);

    // --- Run step through the API ---
    await api.runStep({
      correlationId: COR, runId: RUN, node: "retrieve",
      input: { q: "labor rate" }, output: { chunks: 3 }, status: "ok", latencyMs: 12, mode: "production",
    });
    const steps = await db.select().from(agent_run_steps).where(sql`${agent_run_steps.correlation_id} = ${COR}`);
    check("run step reached agent_run_steps", steps.length === 1);
    check("  seq assigned server-side", (steps[0]?.seq ?? 0) >= 1);
    check("  identity stamped from the token", steps[0]?.user_id === me.user.id, `stored ${steps[0]?.user_id}`);

    // --- LLM call through the API ---
    await api.llmCall({
      correlationId: COR, runId: RUN, node: "draft", model: "test-model",
      prompt: "the prompt", completion: "the completion", status: "ok", latencyMs: 34, mode: "production",
    });
    const calls = await db.select().from(agent_llm_calls).where(sql`${agent_llm_calls.correlation_id} = ${COR}`);
    check("LLM call reached agent_llm_calls", calls.length === 1);
    check("  prompt + completion stored", calls[0]?.prompt === "the prompt" && calls[0]?.completion === "the completion");
    check("  identity stamped from the token", calls[0]?.user_id === me.user.id);

    // --- Trajectory (DAG History) step + terminal through the API ---
    await api.trajectoryStep({
      correlationId: COR, agentGuid: AGENT_GUID, seq: 1, kind: "retrieve", status: "ok", outputRef: "abc123",
    });
    await api.trajectoryTerminal({
      correlationId: COR, agentGuid: AGENT_GUID, seq: 2, outcome: "completed", finalRef: "def456",
    });
    const traj = await readTrajectory(COR);
    check("trajectory step + terminal reached agent_trajectory", traj.length === 2);
    const stops = await whereDidItStop(COR);
    check("  reconciliation sees the run terminated", stops[0]?.terminated === true && stops[0]?.outcome === "completed");
  } finally {
    await db.execute(sql`DELETE FROM agent_run_steps WHERE correlation_id = ${COR}`).catch(() => {});
    await db.execute(sql`DELETE FROM agent_llm_calls WHERE correlation_id = ${COR}`).catch(() => {});
    await db.execute(sql`DELETE FROM agent_trajectory WHERE correlation_id = ${COR}`).catch(() => {});
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Trace + DAG History are API-mediated.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
