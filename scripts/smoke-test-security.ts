// scripts/smoke-test-security.ts
//
// Tests the ENFORCEMENT chain end to end, against a live Qdrant:
//
//   1. classification resolution  - declared > path default > none, strict typos
//   2. frontmatter extraction     - markdown declares its classification
//   3. labels reach the payload   - writeTableBlurb carries access_labels
//   4. THE FILTER ACTUALLY EXCLUDES - a restricted chunk is never returned to
//      a caller who lacks the label
//   5. fail-closed                - a point with no access_labels is invisible
//                                   to everyone, including an admin
//   6. the table lane is filtered - a blurb is disclosure (column names, value
//                                   domains) and must obey the same filter
//   7. preflight                  - unlabelled points are countable before you
//                                   flip QMS_ENFORCE_LABELS
//
// Every point is written with the SAME vector, so similarity is identical
// across them. Any difference in what comes back is therefore caused by the
// filter and nothing else. That is the property under test.
//
// Usage: npm run smoke:security

import { randomUUID } from "node:crypto";
import { getTierServices, closeAllServices } from "../src/services.js";
import { closeDb } from "../src/db/client.js";
import { embedBatch } from "../src/embeddings.js";
import { QdrantWriter } from "../src/ingestion/qdrant-writer.js";
import {
  resolveDocumentLabels,
  labelsIntersect,
  loadClassificationPolicy,
  ClassificationError,
} from "../src/identity/classification.js";
import { parseFrontmatter } from "../src/ingestion/frontmatter.js";

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

const INTERNAL = ["engineering:internal"];
const RESTRICTED = ["engineering:restricted"];
const REVIEWER = ["engineering:internal", "engineering:restricted"];

const COLLECTION = process.env.QMS_QDRANT_COLLECTION_OVERRIDE ?? "qms_security_smoke_test";

async function main(): Promise<void> {
  console.log("=== Security / label-enforcement smoke test ===\n");

  // ---------------------------------------------------------------------
  // 1. Classification resolution
  // ---------------------------------------------------------------------
  const policy = loadClassificationPolicy();
  check("classification policy loads", Boolean(policy.policy.policyVersion));
  check("policy hash is sha256", /^[0-9a-f]{64}$/.test(policy.hash));

  // The real string from Risk_Register.xlsx - em dash and all.
  const real = resolveDocumentLabels("data/Risk_Register.xlsx", "Stonefield Semiconductors — Internal");
  check("real declared classification resolves", real.classification === "internal", JSON.stringify(real.labels));
  check("  rule = declared", real.rule === "declared");

  const byPath = resolveDocumentLabels("procedures/CAPA.md", null);
  check("path default applies when nothing declared", byPath.rule === "path_default");

  const nothing = resolveDocumentLabels("scratch/notes.md", null);
  check("unclassified -> NO labels (invisible)", nothing.labels.length === 0 && nothing.rule === "none");

  let threw = false;
  try {
    resolveDocumentLabels("procedures/x.md", "Internnal");
  } catch (e) {
    threw = e instanceof ClassificationError && e.code === "unmapped";
  }
  check("strict mode: unrecognised classification THROWS", threw, "a typo must not silently hide a document");

  // ---------------------------------------------------------------------
  // 2. Frontmatter
  // ---------------------------------------------------------------------
  const fm = parseFrontmatter('---\nclassification: "Stonefield Semiconductors — Internal"\n---\n\n# Body');
  check("frontmatter extracts classification", fm.declaredClassification === "Stonefield Semiconductors — Internal");
  check("frontmatter strips the block from the body", fm.body.startsWith("# Body"));

  // ---------------------------------------------------------------------
  // 3-7. Live Qdrant
  // ---------------------------------------------------------------------
  const svc = getTierServices("operations");
  const writer = new QdrantWriter(svc.qdrant, {
    collection: COLLECTION,
    recreateOnIngest: true,
  });
  await writer.ensureCollection();
  console.log(`     [diag] isolated collection: ${COLLECTION}`);

  // One vector, reused. Similarity is identical for every point, so the ONLY
  // thing that can change the result set is the filter.
  const [vector] = await embedBatch(["security smoke test content"]);

  const idInternal = randomUUID();
  const idRestricted = randomUUID();
  const idLegacy = randomUUID();

  await svc.qdrant.upsert(COLLECTION, {
    points: [
      { id: idInternal, vector, payload: { text: "internal doc", access_labels: INTERNAL } },
      { id: idRestricted, vector, payload: { text: "restricted doc", access_labels: RESTRICTED } },
      // No access_labels key at all - a point ingested before labelling existed.
      { id: idLegacy, vector, payload: { text: "legacy doc" } },
    ],
  });

  // A table blurb, written through the REAL writer, so we test that the
  // writer carries labels rather than assuming it.
  const tableId = randomUUID();
  await writer.writeTableBlurb({
    tableId,
    blurb: "[Restricted Register]\n\nA data table of restricted figures.",
    sourcePath: "finance/pl.xlsx",
    sourceSha: "deadbeef",
    displayName: "Restricted Register",
    tier: "operations",
    accessLabels: RESTRICTED,
  });

  const search = async (callerLabels: string[] | null, tableLaneOnly = false) => {
    const must: Record<string, unknown>[] = [];
    if (tableLaneOnly) must.push({ key: "has_structured_table", match: { value: true } });
    if (callerLabels) must.push({ key: "access_labels", match: { any: callerLabels } });
    const hits = await svc.qdrant.search(COLLECTION, {
      vector,
      limit: 20,
      with_payload: true,
      ...(must.length > 0 ? { filter: { must } } : {}),
    });
    return hits.map((h) => String(h.id));
  };

  // --- 3. labels reached the payload ---
  const blurbPoints = await search(RESTRICTED, true);
  check("writeTableBlurb persisted access_labels", blurbPoints.length === 1, `${blurbPoints.length} hit(s)`);

  // --- Baseline: with no filter, everything is reachable ---
  const unfiltered = await search(null);
  check("unfiltered search sees all 4 points", unfiltered.length === 4, `${unfiltered.length}`);

  // --- 4. THE FILTER EXCLUDES ---
  // The engineer must see exactly ONE point: the internal doc. That single
  // assertion covers the restricted doc, the restricted blurb, and the
  // unlabelled legacy point in one claim.
  const asEngineer = await search(INTERNAL);
  check(
    "engineer sees EXACTLY the internal doc, nothing else",
    asEngineer.length === 1 && asEngineer[0] === idInternal,
    `got ${asEngineer.length} hit(s)`,
  );
  check("  restricted doc excluded", !asEngineer.includes(idRestricted));

  const asReviewer = await search(REVIEWER);
  check("reviewer sees both internal and restricted", asReviewer.includes(idInternal) && asReviewer.includes(idRestricted));
  check("reviewer also sees the restricted blurb", asReviewer.length === 3, `got ${asReviewer.length}`);

  // --- 5. FAIL CLOSED ---
  check("legacy unlabelled point invisible to engineer", !asEngineer.includes(idLegacy));
  check("legacy unlabelled point invisible to reviewer", !asReviewer.includes(idLegacy));
  const asEverything = await search(["engineering:internal", "engineering:restricted", "engineering:public"]);
  check("legacy unlabelled point invisible even with ALL labels", !asEverything.includes(idLegacy));

  // --- 6. Table lane obeys the filter ---
  const tableLaneEngineer = await search(INTERNAL, true);
  check("table lane hides the restricted blurb from an engineer", tableLaneEngineer.length === 0, `${tableLaneEngineer.length} hit(s)`);
  const tableLaneReviewer = await search(RESTRICTED, true);
  check("table lane shows it to a reviewer", tableLaneReviewer.length === 1);

  // --- 7. Preflight: unlabelled points are countable ---
  try {
    const empty = await svc.qdrant.scroll(COLLECTION, {
      filter: { must: [{ is_empty: { key: "access_labels" } }] },
      limit: 100,
      with_payload: false,
    });
    const unlabelled = empty.points.length;
    check("preflight finds exactly 1 unlabelled point", unlabelled === 1, `${unlabelled}`);
  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} preflight is_empty query - ${err instanceof Error ? err.message : err}`);
  }

  // --- labelsIntersect unit semantics ---
  check("labelsIntersect: overlap grants", labelsIntersect(RESTRICTED, REVIEWER));
  check("labelsIntersect: no overlap denies", !labelsIntersect(RESTRICTED, INTERNAL));
  check("labelsIntersect: empty artifact labels deny", !labelsIntersect([], REVIEWER));
  check("labelsIntersect: empty caller labels deny", !labelsIntersect(RESTRICTED, []));

  // Cleanup
  console.log("Cleaning up...");
  await svc.qdrant.deleteCollection(COLLECTION).catch(() => {});
  await closeAllServices();
  await closeDb();

  console.log("");
  if (failed === 0) console.log(`${GREEN}Security enforcement is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});