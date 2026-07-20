// scripts/smoke-test-data-access-live.ts
//
// The Data Access API (Stage 0), end to end over HTTP. Proves the rule "all
// database access is API-mediated" on the artifact store:
//
//   - an agent writes an artifact THROUGH the API (no DB client) and gets its hash
//   - the write actually reached the DB (verified server-side)
//   - the artifact reads back through the API, byte-identical
//   - the API is the gate: an UNAUTHENTICATED write is rejected (401), and
//     nothing is written
//
// Starts the API server in-process, logs into the ID Server as dmaher for a
// bearer token. Needs Postgres + ID Server. No LLM.
//
// Usage: npm run integration:data-access

import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { createServer } from "../src/api/server.js";
import { db, closeDb } from "../src/db/client.js";
import { custody_artifacts } from "../src/db/schema.js";
import { artifactId, getArtifact, type Artifact } from "../src/custody/artifacts.js";
import { artifactApi } from "../src/data/artifact-client.js";
import { idServerLogin } from "./_login.js";
import { canonicalJson } from "../src/custody/ledger.js";

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

const TEST_PORT = 4115;
const BASE = `http://localhost:${TEST_PORT}`;
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

const artifact: Artifact = {
  producer: "inproc:test",
  capability: "research:qms",
  query: { q: "labor rate" },
  result: { rate: 185 },
  producedAt: "2026-01-01T00:00:00.000Z",
};
const expectedHash = artifactId(artifact);

async function main(): Promise<void> {
  console.log("=== Data Access API (live) integration test ===\n");
  let server: Server | null = null;

  try {
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    const api = artifactApi(BASE, token);

    // --- Write through the API ---
    const hash = await api.put(artifact);
    check("write through the API returns the content hash", hash === expectedHash, `${hash} != ${expectedHash}`);

    // --- The write reached the DB (verified server-side) ---
    const stored = await getArtifact(hash);
    check("the write actually reached the database", stored !== null);
    check("  stored bytes match what was sent", stored !== null && canonicalJson(stored) === canonicalJson(artifact));

    // --- Read back through the API ---
    const fetched = await api.get(hash);
    check("read back through the API, byte-identical", fetched !== null && canonicalJson(fetched) === canonicalJson(artifact));

    // --- Unknown hash reads as null ---
    check("unknown hash -> null", (await api.get("f".repeat(64))) === null);

    // --- The API is the gate: no token -> 401, and nothing written ---
    const gateArtifact = { ...artifact, result: { rate: 999 } };
    const gateHash = artifactId(gateArtifact);
    const res = await fetch(`${BASE}/api/v1/data/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gateArtifact),
    });
    check("unauthenticated write is rejected (401)", res.status === 401, `got ${res.status}`);
    check("  and nothing was written for it", (await getArtifact(gateHash)) === null);
  } finally {
    await db.execute(sql`DELETE FROM custody_artifacts WHERE hash = ${expectedHash}`).catch(() => {});
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Data Access API is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
