// scripts/smoke-test-vector-api-live.ts
//
// Vector retrieval behind the Data Access API (decision-13 refactor R3), end to
// end over HTTP. Proves the rule "all database access is API-mediated" now holds
// for the vector store — the last store the agent's retrieval node reached
// directly with a Qdrant client:
//
//   - a query is embedded and searched THROUGH the API (no Qdrant client), and
//     hits come back
//   - the table lane (tableOnly) returns only points that carry a structured table
//   - ACCESS IS DECIDED FROM THE TOKEN: a tier the caller cannot access is
//     rejected (403) before any search runs — a caller cannot widen its own access
//   - the API is the gate: an unauthenticated search is rejected (401)
//
// Starts the API server in-process, logs into the ID Server as dmaher (override
// with QMS_SMOKE_USER / QMS_SMOKE_PASSWORD). Needs Qdrant + Ollama (embeddings) +
// ID Server + the ingested corpus.
//
// Usage: npm run integration:vector-api

import type { Server } from "node:http";
import { createServer } from "../src/api/server.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
import { embedBatch } from "../src/embeddings.js";
import { vectorApi } from "../src/data/vector-client.js";
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

const TEST_PORT = 4119;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

async function main(): Promise<void> {
  console.log("=== Vector-search behind-the-API (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    const vectors = await embedBatch(["risk register"]);
    const vector = vectors[0]!;

    // --- Gate: no token -> 401 ---
    const unauth = await fetch(`${BASE}/api/v1/data/vector-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "operations", vector, limit: 3 }),
    });
    check("unauthenticated search is rejected (401)", unauth.status === 401, `got ${unauth.status}`);

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    const whoami = await fetch(`${BASE}/api/v1/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    const me = (await whoami.json()) as { user: { accessibleTiers: string[] } };
    const tier = me.user.accessibleTiers[0]!;
    check("caller has at least one accessible tier", Boolean(tier), JSON.stringify(me.user.accessibleTiers));

    const api = vectorApi(BASE, token);

    // --- Prose lane: search an accessible tier through the API ---
    const hits = await api.search({ tier, vector, limit: 5 });
    check("search through the API returns hits", Array.isArray(hits) && hits.length > 0, `got ${hits.length}`);
    check("  hits carry a payload", hits.every((h) => h.payload !== undefined));

    // --- Table lane: tableOnly returns only structured-table points ---
    const tableHits = await api.search({ tier, vector, limit: 5, tableOnly: true });
    check(
      "tableOnly returns only points with a structured table",
      tableHits.every((h) => h.payload?.has_structured_table === true),
      `got ${tableHits.length} hits`,
    );

    // --- Access is decided from the token: an inaccessible tier -> 403 ---
    const denied = await fetch(`${BASE}/api/v1/data/vector-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tier: "__no_such_tier__", vector, limit: 3 }),
    });
    check("a tier the caller cannot access is rejected (403)", denied.status === 403, `got ${denied.status}`);
  } finally {
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Vector search is API-mediated.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
