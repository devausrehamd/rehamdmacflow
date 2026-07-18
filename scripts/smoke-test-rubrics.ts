// scripts/smoke-test-rubrics.ts
//
// Validates the rubric loader and the draft/review schema foundation:
//   - all rubric JSON files load and validate
//   - each has the three categories with sensible content
//   - content hashing is stable
//   - the objective weights sum correctly
//   - the draft_sets/documents/rounds/issues tables exist and accept a row
//
// Usage: npm run smoke:rubrics

import { eq } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { draft_sets, draft_documents, review_rounds, issue_items } from "../src/db/schema.js";
import {
  loadRubrics,
  getRubric,
  listRubricTypes,
  totalObjectiveWeight,
} from "../src/drafting/rubric-loader.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`${GREEN}OK${NC}   ${name}`);
  } else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Rubric + draft-schema smoke test ===\n");

  // --- Rubric loading ---
  const map = loadRubrics();
  check("at least one rubric loaded", map.size >= 1, `loaded ${map.size}`);
  check("capa rubric present", listRubricTypes().includes("capa"));

  const capa = getRubric("capa");
  check("capa has a content hash", capa.contentHash.length === 64);
  check("capa has criteria", capa.rubric.criteria.length >= 1);
  check("capa has critical gate criteria", capa.rubric.criteria.some((c) => c.gate === "critical"));
  check(
    "capa objective weights are positive",
    totalObjectiveWeight(capa.rubric) > 0,
    `got ${totalObjectiveWeight(capa.rubric)}`,
  );
  check("capa has a review threshold in [0,1]", capa.rubric.reviewThreshold > 0 && capa.rubric.reviewThreshold <= 1);
  check("capa trajectory has a required rule", capa.rubric.trajectory.required.length >= 1);

  // Hash stability: reloading yields the same hash
  const reload = loadRubrics().get("capa")!;
  check("content hash is stable across reloads", reload.contentHash === capa.contentHash);

  // Unknown type throws
  let threw = false;
  try {
    getRubric("does-not-exist");
  } catch {
    threw = true;
  }
  check("unknown document type throws", threw);

  // --- Schema round-trip: insert a set -> document -> round -> issue ---
  let setId: string | null = null;
  try {
    const [set] = await db
      .insert(draft_sets)
      .values({
        originating_query_id: "smoke-query-1",
        document_type: "capa",
        rubric_version: capa.rubric.version,
        rubric_hash: capa.contentHash,
        status: "pending_review",
      })
      .returning();
    setId = set.id;
    check("draft_sets insert", Boolean(set.id));

    const [doc] = await db
      .insert(draft_documents)
      .values({
        set_id: set.id,
        title: "Smoke CAPA",
        content: "# CAPA\nsmoke content",
        objective_fraction: 87,
        objective_scores: { completeness: 30, grounding: 27, clarity: 18, citations: 12 },
      })
      .returning();
    check("draft_documents insert", Boolean(doc.id));

    const [round] = await db
      .insert(review_rounds)
      .values({
        set_id: set.id,
        round_number: 1,
        rubric_version: capa.rubric.version,
        rubric_hash: capa.contentHash,
      })
      .returning();
    check("review_rounds insert", Boolean(round.id));

    const [issue] = await db
      .insert(issue_items)
      .values({
        round_id: round.id,
        document_id: doc.id,
        section: "Root Cause",
        criterion_id: "root_cause_substantive",
        category: "missing",
        detail: "Root cause restates the problem without analysis.",
      })
      .returning();
    check("issue_items insert", Boolean(issue.id));
  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} schema round-trip - ${err instanceof Error ? err.message : err}`);
    console.log("     (did you run migrations? npm run db:migrate)");
  } finally {
    // Cleanup - cascade deletes documents/rounds/issues
    if (setId) {
      await db.delete(draft_sets).where(eq(draft_sets.id, setId)).catch(() => {});
    }
  }

  await closeDb();
  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}Rubric + draft-schema foundation is sound.${NC}`);
  } else {
    console.log(`${RED}${failed} check(s) failed.${NC}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});