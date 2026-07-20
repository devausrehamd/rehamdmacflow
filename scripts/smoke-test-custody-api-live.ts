// scripts/smoke-test-custody-api-live.ts
//
// The custody ledger behind the Data Access API (decision-13 refactor R1), end to
// end over HTTP. Proves the rule "all database access is API-mediated" now holds
// for the custody store — the store the agent role used to write directly:
//
//   - an agent appends a custody event THROUGH the API (no DB client) and gets
//     back {seq, entryHash}
//   - the write actually reached the ledger (verified server-side)
//   - the entry hash returned matches what was stored (round-trip integrity)
//   - a second append CHAINS from the first (verifyChain reports the slice intact)
//   - identity is stamped from the TOKEN, not the body: a spoofed userId in the
//     request is ignored in favour of the authenticated caller
//   - the API is the gate: an UNAUTHENTICATED append is rejected (401), and
//     nothing is written
//
// Starts the API server in-process, logs into the ID Server as dmaher for a
// bearer token. Needs Postgres + ID Server. No LLM.
//
// Usage: npm run integration:custody-api

import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { createServer } from "../src/api/server.js";
import { db, closeDb } from "../src/db/client.js";
import { custody_events } from "../src/db/schema.js";
import { verifyChain } from "../src/custody/ledger.js";
import { currentDomain } from "../src/identity/index.js";
import { custodyApi } from "../src/data/custody-client.js";
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

const TEST_PORT = 4117;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

// A correlation id unique to this run so the assertions and cleanup are scoped.
const CORRELATION = `cor_r1test_${Date.now()}`;
const RUN = `run_r1test_${Date.now()}`;

async function main(): Promise<void> {
  console.log("=== Custody-behind-the-API (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    // --- The API is the gate: no token -> 401, before anything is written ---
    const unauth = await fetch(`${BASE}/api/v1/data/custody/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ctx: { correlationId: CORRELATION, runId: RUN }, eventType: "run_started", payload: {} }),
    });
    check("unauthenticated append is rejected (401)", unauth.status === 401, `got ${unauth.status}`);

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    // The authenticated caller's id, to assert identity is stamped from the token.
    const whoami = await fetch(`${BASE}/api/v1/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    const me = (await whoami.json()) as { user: { id: string } };

    const api = custodyApi(BASE, token);

    // --- Append THROUGH the API. Spoof a userId in the body to prove it loses. ---
    const first = await api.append(
      { correlationId: CORRELATION, runId: RUN, userId: "spoofed-not-me" },
      "run_started",
      { note: "r1 test event one" },
    );
    check("append through the API returns a seq", Number.isInteger(first.seq) && first.seq > 0);
    check("  and a 64-hex entry hash", /^[0-9a-f]{64}$/.test(first.entryHash), first.entryHash);

    // --- The write reached the ledger, and identity came from the token ---
    const rows = await db
      .select()
      .from(custody_events)
      .where(sql`${custody_events.correlation_id} = ${CORRELATION} AND ${custody_events.domain} = ${currentDomain()}`)
      .orderBy(sql`${custody_events.seq} ASC`);
    check("the append actually reached the ledger", rows.length === 1);
    check("  the stored entry hash matches what the API returned", rows[0]?.entry_hash === first.entryHash);
    check("  identity is stamped from the token, not the body", rows[0]?.user_id === me.user.id, `stored ${rows[0]?.user_id}`);
    check("  the spoofed userId was ignored", rows[0]?.user_id !== "spoofed-not-me");

    // --- A second append chains from the first ---
    const second = await api.append(
      { correlationId: CORRELATION, runId: RUN, userId: me.user.id },
      "retrieval",
      { note: "r1 test event two", chunkIds: ["a", "b"] },
    );
    check("second append advances the seq", second.seq > first.seq);

    const verification = await verifyChain({ correlationId: CORRELATION });
    check("the two-event slice verifies as an intact chain", verification.ok, verification.detail);
    check("  both events were checked", verification.entriesChecked === 2, `checked ${verification.entriesChecked}`);
  } finally {
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${CORRELATION}`).catch(() => {});
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Custody is API-mediated.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
