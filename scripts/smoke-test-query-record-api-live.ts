// scripts/smoke-test-query-record-api-live.ts
//
// The query-record store behind the Data Access API (decision-13 refactor R4),
// end to end over HTTP. QueryRecord (the per-request run state) used to reach the
// caller's tier Redis directly; it now GET/PUTs here. Proves:
//
//   - a record is written and read back THROUGH the API (no Redis client),
//     byte-identical
//   - an unknown id reads as 404 (null to the client)
//   - the API is the gate: an unauthenticated read or write is rejected (401)
//
// Starts the API server in-process, logs into the ID Server as dmaher (override
// with QMS_SMOKE_USER / QMS_SMOKE_PASSWORD). Needs Redis + ID Server. No LLM.
//
// Usage: npm run integration:query-record-api

import type { Server } from "node:http";
import { createServer } from "../src/api/server.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
import { queryRecordApi } from "../src/data/query-record-client.js";
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

const TEST_PORT = 4120;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

const ID = `qry_r4test_${Date.now()}`;

async function main(): Promise<void> {
  console.log("=== Query-record behind-the-API (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    // --- Gate: no token -> 401 on both read and write ---
    const unauthGet = await fetch(`${BASE}/api/v1/data/query-records/${ID}`);
    check("unauthenticated read is rejected (401)", unauthGet.status === 401, `got ${unauthGet.status}`);
    const unauthPut = await fetch(`${BASE}/api/v1/data/query-records/${ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: {}, ttlSeconds: 60 }),
    });
    check("unauthenticated write is rejected (401)", unauthPut.status === 401, `got ${unauthPut.status}`);

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    const api = queryRecordApi(BASE, token);

    // --- Unknown id reads as null (404) ---
    check("unknown id reads as null", (await api.get(ID)) === null);

    // --- Write, then read back byte-identical ---
    const record = { id: ID, status: "created", question: "how many risks?", tiers: { operations: {} } };
    await api.put(ID, record, 120);
    const back = await api.get(ID);
    check("record reads back through the API, byte-identical", JSON.stringify(back) === JSON.stringify(record));
  } finally {
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Query records are API-mediated.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
