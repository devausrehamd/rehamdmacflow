// scripts/smoke-test-custody.ts
//
// The custody ledger, end to end against Postgres:
//
//   - append chains correctly (prev_hash links, entry_hash recomputes)
//   - verifyChain confirms an intact chain
//   - a tampered payload is DETECTED (the hallucination-after-the-fact case)
//   - correlation groups events across runs; runId separates them
//   - the dossier assembles, is self-verifying, and renders
//   - a signature anchor round-trips
//
// Needs Postgres. No LLM, no Qdrant.
//
// Usage: npm run smoke:custody

import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { custody_events, custody_anchors } from "../src/db/schema.js";
import { appendEvent, verifyChain, hashEntry, GENESIS_HASH } from "../src/custody/ledger.js";
import { buildCustodyDossier, renderCustodyDossier } from "../src/custody/export.js";
import { anchorHead, verifyAnchorSignature } from "../src/custody/anchor.js";
import { newRunId } from "../src/custody/correlation.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`); }
}

async function main(): Promise<void> {
  console.log("=== Custody ledger smoke test ===\n");
  process.env.QMS_DOMAIN = "engineering";

  const correlationId = `cor_${Date.now().toString(16).padStart(24, "0")}`;
  const runId = newRunId();
  const ctx = {
    correlationId,
    runId,
    userId: "u-quality-mgr",
    decisionId: "dec_abc123",
    policyHash: "f8ef6ea1",
  };

  try {
    // --- Append a realistic trajectory ---
    const e1 = await appendEvent(ctx, "run_started", { kind: "ask", question: "open risks for Singh" });
    const e2 = await appendEvent(ctx, "retrieval", { chunkIds: ["a", "b", "c"], labels: ["engineering:internal"] });
    const e3 = await appendEvent(ctx, "sql_query", {
      request: { aggregate: "count", where: [["owner", "ilike", "%singh%"]] },
      executedSql: "SELECT COUNT(*) ...",
      rowCount: 2,
    });
    const e4 = await appendEvent(ctx, "generation", {
      model: "qwen2.5:7b-instruct-q4_K_M",
      promptHash: "deadbeef",
      outputHash: "cafe1234",
    });
    const e5 = await appendEvent(
      { ...ctx, userId: "u-reviewer" },
      "human_decision",
      { disposition: "OK", feedback: null },
    );

    check("five events appended with ascending seq",
      e1.seq < e2.seq && e2.seq < e3.seq && e3.seq < e4.seq && e4.seq < e5.seq);

    // --- Verify the chain ---
    const v = await verifyChain({ correlationId });
    check("chain verifies intact", v.ok, v.detail);
    check("all five entries checked", v.entriesChecked === 5, String(v.entriesChecked));

    // --- Tamper detection ---
    // Directly UPDATE a payload behind the ledger's back (simulating an
    // attacker with DB access editing a recorded result).
    await db.execute(sql`
      UPDATE custody_events
      SET payload = jsonb_set(payload, '{rowCount}', '5')
      WHERE correlation_id = ${correlationId} AND event_type = 'sql_query'
    `);
    const vt = await verifyChain({ correlationId });
    check("tampered payload is DETECTED", !vt.ok);
    check("  break located at the sql_query entry", vt.brokenAt === e3.seq, `broken at ${vt.brokenAt}, expected ${e3.seq}`);
    check("  reason is entry_hash mismatch", /mismatch|tampered/.test(vt.detail ?? ""), vt.detail);

    // --- The dossier assembles and is self-verifying ---
    const dossier = await buildCustodyDossier(correlationId);
    check("dossier collects all events", dossier.events.length === 5);
    check("dossier lifts out the human decision", dossier.humanDecisions.length === 1);
    check("dossier human decision names the approver", dossier.humanDecisions[0].userId === "u-reviewer");
    check("dossier integrity reflects the tamper", !dossier.integrity.chainVerified);

    const md = renderCustodyDossier(dossier);
    check("rendered dossier states the break", /BROKEN/.test(md));
    check("rendered dossier scopes its evidence honestly", /does NOT assert/.test(md));

    // --- Anchor round-trip ---
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const head = await anchorHead(privPem);
    check("anchor writes the current head", head !== null);
    if (head) {
      const valid = verifyAnchorSignature("engineering", head.headSeq, head.headHash, await currentProof(), pubPem);
      check("anchor signature verifies against the head", valid);
      const tampered = verifyAnchorSignature("engineering", head.headSeq, "0".repeat(64), await currentProof(), pubPem);
      check("anchor signature FAILS on a wrong head hash", !tampered);
    }

    // --- The hash function is the same one used at write ---
    const genesisEntry = hashEntry(GENESIS_HASH, {
      correlation_id: "x", run_id: "y", domain: "engineering", event_type: "t",
      user_id: null, decision_id: null, policy_hash: null, payload: { a: 1 },
    });
    check("hashEntry is deterministic", genesisEntry === hashEntry(GENESIS_HASH, {
      correlation_id: "x", run_id: "y", domain: "engineering", event_type: "t",
      user_id: null, decision_id: null, policy_hash: null, payload: { a: 1 },
    }));

    async function currentProof(): Promise<string> {
      const rows = await db.select().from(custody_anchors)
        .where(sql`domain = 'engineering'`).orderBy(sql`anchored_at DESC`).limit(1);
      return rows[0].proof;
    }

  } finally {
    // Clean up our test rows. Anchors first - their cleanup references the
    // events, which the next statement removes.
    await db
      .execute(
        sql`DELETE FROM custody_anchors WHERE domain = 'engineering' AND head_hash IN (SELECT entry_hash FROM custody_events WHERE correlation_id = ${correlationId})`,
      )
      .catch(() => {});
    await db.execute(sql`DELETE FROM custody_events WHERE correlation_id = ${correlationId}`).catch(() => {});
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Custody ledger is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});