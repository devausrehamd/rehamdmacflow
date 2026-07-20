// scripts/smoke-test-orchestrator-live.ts
//
// The Talk Agent / orchestrator /ask, end to end over HTTP (Stage 5). This is the
// working /ask the GUI drives. Proves:
//
//   - POST /api/v1/orchestrator/ask selects a capability and returns it
//   - a research question is orchestrated to a real answer (the graph runs under
//     the caller's entitlements: SQL retrieval reaches the exact data)
//   - a new session correlation id is returned
//   - the endpoint is gated: an unauthenticated ask is rejected (401)
//
// Starts the API server in-process, logs into the ID Server as dmaher. Needs
// Postgres, Qdrant, Ollama, ID Server (the full stack). Real LLM -> minutes.
//
// Usage: npm run integration:orchestrator

import type { Server } from "node:http";
import { createServer } from "../src/api/server.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
import { flushLangfuse } from "../src/observability/langfuse.js";
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

const TEST_PORT = 4116;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

interface AskResponse {
  correlationId?: string;
  selection?: { capability?: string; kind?: string };
  answer?: string | null;
  needsClarification?: boolean;
}

async function ask(token: string | null, question: string): Promise<{ status: number; body: AskResponse }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/v1/orchestrator/ask`, { method: "POST", headers, body: JSON.stringify({ question }) });
  const body = res.ok ? ((await res.json()) as AskResponse) : {};
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log("=== Orchestrator /ask (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    // Gate first: no token -> 401.
    const unauth = await fetch(`${BASE}/api/v1/orchestrator/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "how many risks are there?" }),
    });
    check("unauthenticated ask is rejected (401)", unauth.status === 401, `got ${unauth.status}`);

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    console.log("  asking the orchestrator a research question (real LLM, ~15s) ...");
    const { status, body } = await ask(token, "How many risks are in the risk register?");
    check("orchestrator /ask returns 200", status === 200, `got ${status}`);
    check("it selected the research capability", body.selection?.capability === "research:qms");
    check("it opened a session (correlation id)", Boolean(body.correlationId));
    check("it orchestrated a real answer", typeof body.answer === "string" && (body.answer?.length ?? 0) > 0);
    console.log(`\n  --- selection: ${body.selection?.capability} ---\n  --- answer ---\n  ${(body.answer ?? "").replace(/\n/g, "\n  ")}\n`);
  } finally {
    await flushLangfuse().catch(() => {});
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Orchestrator /ask is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
