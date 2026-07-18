// scripts/smoke-test-custody-e2e.ts
//
// End-to-end custody over REAL HTTP:
//
//   1. start the API server in-process
//   2. log in, POST /api/v1/ask (SSE), drain the stream
//   3. read the x-qms-correlation-id the server echoed back
//   4. GET /api/v1/custody/:correlationId  (JSON, then Markdown)
//   5. assert the chain contains run_started -> retrieval -> ... -> run_completed
//   6. assert the export self-verifies (chain intact)
//   7. assert a SUPPLIED correlation id is INHERITED, not replaced
//
// This is the auditor's actual workflow: ask produces a document, the caller
// gets a correlation id, that id retrieves a self-verifying custody record.
//
// Needs Postgres, Qdrant, Ollama, Redis - the full stack, like integration:hybrid.
// It reuses the hybrid fixture (one embedded blurb) so the agent has something
// to retrieve and a table to query.
//
// Usage: npm run integration:custody-e2e

import type { Server } from "node:http";
import { createServer } from "../src/api/server.js";
import { hashPassword } from "../src/api/auth/passwords.js";
import { createUser } from "../src/api/auth/store.js";
import { users } from "../src/db/schema.js";
import { db, closeDb } from "../src/db/client.js";
import { sql } from "drizzle-orm";
import { QdrantWriter } from "../src/ingestion/qdrant-writer.js";
import { getTierServices } from "../src/services.js";
import { loadTable } from "../src/data/table-loader.js";
import { CORRELATION_HEADER } from "../src/custody/correlation.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`); }
}

const TEST_PORT = 4113;
const COLLECTION = "qms_custody_e2e";
const testEmail = `custody-e2e-${Date.now()}@qms-agent.test`;
const password = "custody-e2e-password-12345";

let server: Server | null = null;
let userId: string | null = null;
const seenCorrelations: string[] = [];

/** Drain an SSE ask response; return the correlation header and whether it completed. */
async function askOverHttp(
  token: string,
  question: string,
  suppliedCorrelation?: string,
): Promise<{ correlationId: string | null; done: boolean }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (suppliedCorrelation) headers[CORRELATION_HEADER] = suppliedCorrelation;

  const res = await fetch(`http://localhost:${TEST_PORT}/api/v1/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });

  const correlationId = res.headers.get(CORRELATION_HEADER);

  // Drain the SSE body to completion so all custody events are written.
  let done = false;
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("event: done")) done = true;
  }
  return { correlationId, done };
}

async function main(): Promise<void> {
  console.log("=== Custody end-to-end (HTTP /ask -> /custody) ===\n");
  process.env.QMS_QDRANT_COLLECTION_OVERRIDE = COLLECTION;

  try {
    // --- Fixture: one table + embedded blurb, labelled so retrieval works ---
    const svc = getTierServices("operations");
    const writer = new QdrantWriter(svc.qdrant, { collection: COLLECTION, recreateOnIngest: true });
    await writer.ensureCollection();

    const loaded = await loadTable({
      sourcePath: "data/custody_e2e.xlsx",
      sourceSha256: "e".repeat(64),
      sheetName: "Risk Register",
      tableIndex: 0,
      displayName: "Custody E2E Register",
      tier: "operations",
      headers: ["Risk ID", "Owner", "Status"],
      rows: [["R-1", "Singh", "Open"], ["R-2", "Singh", "Open"], ["R-3", "Tang", "Closed"]],
      accessLabels: ["engineering:internal"],
      project: "summit",
      collection: "risk-register",
      projectDisplayName: "Project Summit",
    });
    await writer.writeTableBlurb({
      tableId: loaded.tableId,
      blurb: loaded.blurb,
      sourcePath: "data/custody_e2e.xlsx",
      sourceSha: "e".repeat(64),
      displayName: loaded.displayName,
      tier: "operations",
      accessLabels: ["engineering:internal"],
      project: "summit",
      collection: "risk-register",
    });
    check("fixture: table + blurb written", Boolean(loaded.tableId));

    // --- Server + user ---
    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    const user = await createUser({
      email: testEmail,
      password_hash: await hashPassword(password),
      role: "admin",
      display_name: "Custody E2E",
    });
    userId = user.id;

    const login = await fetch(`http://localhost:${TEST_PORT}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    check("logged in", Boolean(accessToken));

    // --- 1. Ask over HTTP; capture correlation id ---
    const ask1 = await askOverHttp(accessToken, "How many open risks does Singh own?");
    check("ask returned a correlation id header", Boolean(ask1.correlationId), String(ask1.correlationId));
    check("ask stream completed", ask1.done);
    if (ask1.correlationId) seenCorrelations.push(ask1.correlationId);

    // --- 2. Retrieve the custody dossier for that correlation id ---
    const dossierRes = await fetch(
      `http://localhost:${TEST_PORT}/api/v1/custody/${ask1.correlationId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    check("custody export returns 200", dossierRes.status === 200, String(dossierRes.status));
    const dossier = (await dossierRes.json()) as {
      events: { eventType: string; payload: Record<string, unknown> }[];
      integrity: { chainVerified: boolean; entriesChecked: number };
    };

    const types = dossier.events.map((e) => e.eventType);
    check("chain contains run_started", types.includes("run_started"));
    check("chain contains retrieval", types.includes("retrieval"));
    check("chain contains run_completed", types.includes("run_completed"));
    check("run_started is first", types[0] === "run_started", types.join(" -> "));
    check("run_completed is last", types[types.length - 1] === "run_completed", types.join(" -> "));

    // The retrieval event must reference chunk IDs, never text.
    const retrieval = dossier.events.find((e) => e.eventType === "retrieval");
    check("retrieval event references chunk ids",
      Array.isArray(retrieval?.payload.chunkIds));
    check("retrieval event carries NO chunk text",
      retrieval !== undefined && !JSON.stringify(retrieval.payload).includes("Owner"),
      "custody chain must hold references, not content");

    // run_completed must bind the answer by hash.
    const completed = dossier.events.find((e) => e.eventType === "run_completed");
    check("run_completed binds an answer hash",
      typeof completed?.payload.answerHash === "string" &&
      /^[0-9a-f]{64}$/.test(completed.payload.answerHash as string));

    // --- 3. The export self-verifies ---
    check("dossier reports the chain INTACT", dossier.integrity.chainVerified, dossier.integrity ? "" : "no integrity block");
    check("dossier checked every entry", dossier.integrity.entriesChecked === dossier.events.length,
      `${dossier.integrity.entriesChecked} vs ${dossier.events.length}`);

    // --- 4. Markdown export ---
    const mdRes = await fetch(
      `http://localhost:${TEST_PORT}/api/v1/custody/${ask1.correlationId}?format=md`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const md = await mdRes.text();
    check("markdown export renders", md.includes("# Custody record"));
    check("markdown states integrity", /Chain verified: \*\*intact\*\*/.test(md));
    check("markdown scopes its evidence honestly", /does NOT assert/.test(md));

    // --- 5. A SUPPLIED correlation id is inherited, not replaced ---
    const supplied = `cor_${"a".repeat(24)}`;
    const ask2 = await askOverHttp(accessToken, "How many open risks does Singh own?", supplied);
    check("supplied correlation id is echoed back unchanged", ask2.correlationId === supplied,
      `sent ${supplied}, got ${ask2.correlationId}`);
    if (ask2.correlationId) seenCorrelations.push(ask2.correlationId);

    const inheritedRes = await fetch(
      `http://localhost:${TEST_PORT}/api/v1/custody/${supplied}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const inherited = (await inheritedRes.json()) as { events: unknown[] };
    check("supplied correlation has its own custody chain", inherited.events.length > 0);

    // --- 6. A malformed correlation id is rejected ---
    const bad = await fetch(`http://localhost:${TEST_PORT}/api/v1/custody/not-a-correlation-id`, {
      headers: { Authorization: `Bearer ${accessToken}` } });
    check("malformed correlation id -> 400", bad.status === 400, String(bad.status));

  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} crashed - ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  } finally {
    // Cleanup: custody rows, user, table, collection, server.
    for (const cid of seenCorrelations) {
      await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${cid}`).catch(() => {});
    }
    if (userId) await db.delete(users).where(sql`id = ${userId}`).catch(() => {});
    await db.execute(sql`DELETE FROM table_registry WHERE source_path = 'data/custody_e2e.xlsx'`).catch(() => {});
    try {
      const svc = getTierServices("operations");
      await svc.qdrant.deleteCollection(COLLECTION).catch(() => {});
    } catch { /* ignore */ }
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Custody end-to-end sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main(); 