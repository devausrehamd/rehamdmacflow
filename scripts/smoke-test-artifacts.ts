// scripts/smoke-test-artifacts.ts
//
// The content-addressed artifact store (Phase 1 of the agent-topology /
// custody-DAG spec). Proves the properties the provenance DAG depends on:
//
//   - content-addressing is deterministic: same content -> same id
//   - canonicalisation: key-order / structural reordering -> SAME id
//   - collision-freedom: one differing byte -> different id
//   - sourceRef is optional and omitted-vs-undefined hash identically
//   - putArtifact is idempotent: writing the same content twice -> one row
//   - getArtifact round-trips exactly (the stored body recomputes to its id)
//   - getArtifact of an unknown id -> null
//
// Needs Postgres. No LLM, no Qdrant.
//
// Usage: npm run smoke:artifacts

import { sql } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { custody_artifacts } from "../src/db/schema.js";
import { artifactId, putArtifact, getArtifact, type Artifact } from "../src/custody/artifacts.js";
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

const AT = "2026-01-01T00:00:00.000Z"; // fixed clock: the hashed core reads no wall clock

async function main(): Promise<void> {
  console.log("=== Content-addressed artifact store smoke test ===\n");
  const created = new Set<string>();

  try {
    // --- A base artifact ---
    const a: Artifact = {
      producer: "inproc:qms",
      capability: "research:qms",
      query: { question: "labor rate for EVT", subject: "singh" },
      result: { rate: 185, currency: "USD", per: "hour" },
      producedAt: AT,
      sourceRef: "corpus@v42",
    };

    // 1. Deterministic: a structurally-identical rebuild hashes the same.
    const aClone: Artifact = {
      producer: "inproc:qms",
      capability: "research:qms",
      query: { question: "labor rate for EVT", subject: "singh" },
      result: { rate: 185, currency: "USD", per: "hour" },
      producedAt: AT,
      sourceRef: "corpus@v42",
    };
    check("same content -> same id", artifactId(a) === artifactId(aClone));

    // 2. Canonicalisation: reorder keys in nested objects -> SAME id.
    const aReordered: Artifact = {
      sourceRef: "corpus@v42",
      producedAt: AT,
      result: { per: "hour", currency: "USD", rate: 185 },
      query: { subject: "singh", question: "labor rate for EVT" },
      capability: "research:qms",
      producer: "inproc:qms",
    };
    check("key-order variation -> same id (canonical)", artifactId(a) === artifactId(aReordered));

    // 3. Collision-freedom: one differing byte -> different id.
    const aTampered: Artifact = { ...a, result: { rate: 186, currency: "USD", per: "hour" } };
    check("one differing byte -> different id", artifactId(a) !== artifactId(aTampered));

    // 4. sourceRef optional: omitted key vs explicit-undefined hash identically,
    //    and both differ from an artifact that actually carries a sourceRef.
    const noRef: Artifact = { producer: "inproc:web", capability: "research:web", query: { q: 1 }, result: { r: 2 }, producedAt: AT };
    const undefRef: Artifact = { ...noRef, sourceRef: undefined };
    check("omitted sourceRef == explicit-undefined sourceRef", artifactId(noRef) === artifactId(undefRef));
    check("presence of sourceRef changes the id", artifactId(noRef) !== artifactId({ ...noRef, sourceRef: "etag:abc" }));

    // 5. putArtifact idempotent: same content twice -> one row.
    const id1 = await putArtifact(a);
    created.add(id1);
    const id2 = await putArtifact(a);
    check("putArtifact returns the content id", id1 === artifactId(a));
    check("putArtifact is idempotent (id stable)", id1 === id2);
    const rows = await db.select({ hash: custody_artifacts.hash }).from(custody_artifacts).where(sql`${custody_artifacts.hash} = ${id1}`);
    check("idempotent write -> exactly one row", rows.length === 1, `saw ${rows.length}`);

    // 6. getArtifact round-trips exactly (stored body recomputes to its id).
    const got = await getArtifact(id1);
    check("getArtifact returns the artifact", got !== null);
    check("round-trip is byte-exact (canonical)", got !== null && canonicalJson(got) === canonicalJson(a));
    check("retrieved body recomputes to its id", got !== null && artifactId(got) === id1);

    // 7. Unknown id -> null.
    const missing = await getArtifact("f".repeat(64));
    check("unknown id -> null", missing === null);

    // Store the no-ref artifact too so cleanup removes it.
    created.add(await putArtifact(noRef));
  } finally {
    for (const h of created) {
      await db.execute(sql`DELETE FROM custody_artifacts WHERE hash = ${h}`).catch(() => {});
    }
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Artifact store is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
