// scripts/smoke-test-subject.ts
//
// Project scoping and collection enumeration.
//
// Two halves:
//
//   PURE  - subject resolution from a document's declared metadata. No I/O.
//           Exact alias match, ambiguity throws, unresolved fails closed.
//
//   DB    - enumerateCollection against real table_registry rows. This is the
//           fix for a live bug: the table lane's TOP_K vector search silently
//           under-covers any "across all X" question. Enumeration is set
//           membership over the registry, and it RECORDS what it excluded.
//
// Needs Postgres. Needs no LLM, no Qdrant, no Ollama.
//
// Usage: npm run smoke:subject

import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { db, closeDb } from "../src/db/client.js";
import { table_registry } from "../src/db/schema.js";
import {
  loadSubjectRegistry,
  resolveSubject,
  schemaContractFor,
  projectDisplayName,
  SubjectError,
} from "../src/data/subject.js";
import { enumerateCollection, renderCoverage } from "../src/data/enumerate.js";

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
const REVIEWER = ["engineering:internal", "engineering:restricted"];

/** Column schema shaped like the real thing, so the contract check is meaningful. */
function cols(names: string[]) {
  return {
    columns: names.map((n) => ({
      original: n,
      sql_name: n,
      type: "text",
      nullable: false,
      sample_values: [],
    })),
  };
}

const CONTRACT = ["risk_id", "subsystem", "owner", "status", "score"];

async function main(): Promise<void> {
  console.log("=== Subject scoping + collection enumeration ===\n");

  // -------------------------------------------------------------------
  // PURE: subject resolution
  // -------------------------------------------------------------------
  const loaded = loadSubjectRegistry();
  check("subject registry loads", Boolean(loaded.registry.registryVersion));
  check("registry hash is sha256", /^[0-9a-f]{64}$/.test(loaded.hash));
  check("hash stable across reloads", loadSubjectRegistry().hash === loaded.hash);

  // The REAL metadata sheet from Risk_Register.xlsx
  const real = resolveSubject({
    "Document ID": "Risk Register",
    Title: "Project Summit — Risk Register",
    Owner: "Sigrid Bergstrom, Program Manager",
    Classification: "Stonefield Semiconductors — Internal",
  });
  check("real file resolves project", real.project === "summit", String(real.project));
  check("real file resolves collection", real.collection === "risk-register", String(real.collection));
  check("decision carries registry hash", real.registryHash === loaded.hash);

  const denali = resolveSubject({ Title: "Project Denali — Risk Register", "Document ID": "Risk Register" });
  check("second project resolves independently", denali.project === "denali");

  // Word boundary: a substring must not match.
  check("'Summitville' does NOT match 'summit'",
    resolveSubject({ Title: "Summitville Report" }).project === null);

  // Ambiguity throws rather than picking.
  let ambiguous = false;
  try {
    resolveSubject({ Title: "Summit and Denali Combined Risk Register" });
  } catch (e) {
    ambiguous = e instanceof SubjectError && e.code === "ambiguous_project";
  }
  check("two projects in one document THROWS", ambiguous);

  // Fail closed.
  const none = resolveSubject({ Title: "Some Unrelated Sheet" });
  check("no project declared -> null (satisfies no prerequisite)", none.project === null);
  check("no collection declared -> null (joins no aggregate)", none.collection === null);

  check("schema contract is declared", schemaContractFor("risk-register").length === CONTRACT.length);
  check("projectDisplayName resolves", projectDisplayName("summit") === "Project Summit");

  // -------------------------------------------------------------------
  // DB: enumeration + coverage
  // -------------------------------------------------------------------
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const base = {
    source_sha256: "0".repeat(64),
    table_index: 0,
    tier: "operations",
    blurb: "smoke",
    status: "active",
  };

  // Isolate from any real risk-register rows already registered by corpus
  // ingestion - they would otherwise inflate the enumeration counts below.
  // Snapshot, remove, and restore in the finally, so this test neither counts
  // nor destroys real data.
  let preexisting: (typeof table_registry.$inferSelect)[] = [];

  try {
    preexisting = await db.select().from(table_registry).where(eq(table_registry.collection, "risk-register"));
    await db.delete(table_registry).where(eq(table_registry.collection, "risk-register"));

    await db.insert(table_registry).values([
      // conforming, internal, Summit
      { ...base, id: ids[0], source_path: "d/summit.xlsx", display_name: "Summit Risk Register",
        column_schema: cols(CONTRACT), access_labels: INTERNAL,
        project: "summit", collection: "risk-register" },
      // conforming, RESTRICTED, Denali
      { ...base, id: ids[1], source_path: "d/denali.xlsx", display_name: "Denali Risk Register",
        column_schema: cols(CONTRACT), access_labels: ["engineering:restricted"],
        project: "denali", collection: "risk-register" },
      // internal but BREAKS the contract (uses rpn, not score)
      { ...base, id: ids[2], source_path: "d/broken.xlsx", display_name: "Legacy Risk Register",
        column_schema: cols(["risk_id", "subsystem", "owner", "status", "rpn"]),
        access_labels: INTERNAL, project: "summit", collection: "risk-register" },
      // internal, conforming, but declares NO project
      { ...base, id: ids[3], source_path: "d/orphan.xlsx", display_name: "Unscoped Risk Register",
        column_schema: cols(CONTRACT), access_labels: INTERNAL,
        project: null, collection: "risk-register" },
    ]);

    // --- Engineer: sees internal only ---
    const eng = await enumerateCollection("risk-register", INTERNAL);
    check("enumerate finds all 4 registered members", eng.totalRegistered === 4, String(eng.totalRegistered));
    check("engineer covers 2 (summit + unscoped)", eng.members.length === 2,
      eng.members.map((m) => m.displayName).join(", "));
    check("  Denali excluded on ACCESS",
      eng.excluded.some((e) => e.reason === "access" && /Denali/.test(e.displayName)));
    check("  Legacy excluded on SCHEMA CONTRACT",
      eng.excluded.some((e) => e.reason === "schema_contract" && /score/.test(e.detail)));
    check("  coverage marked incomplete", !eng.complete);

    // --- Reviewer: sees restricted too ---
    const rev = await enumerateCollection("risk-register", REVIEWER);
    check("reviewer covers 3 (summit + denali + unscoped)", rev.members.length === 3,
      rev.members.map((m) => m.displayName).join(", "));
    check("  Denali now included", rev.members.some((m) => m.project === "denali"));

    // --- requireProject excludes the unscoped register ---
    const scoped = await enumerateCollection("risk-register", REVIEWER, { requireProject: true });
    check("requireProject excludes the unscoped member", scoped.members.length === 2,
      scoped.members.map((m) => m.displayName).join(", "));
    check("  exclusion reason is no_project",
      scoped.excluded.some((e) => e.reason === "no_project"));

    // --- The coverage sentence the answer must carry ---
    const text = renderCoverage(scoped);
    console.log("\n--- renderCoverage(reviewer, requireProject) ---");
    console.log(text);
    console.log("---\n");
    check("coverage names the projects", /Project Summit/.test(text) && /Project Denali/.test(text));
    check("excluded entries name the DOCUMENT, not just the project",
      /Legacy Risk Register/.test(renderCoverage(eng)),
      "two Summit registers exist - naming only the project makes covered and excluded indistinguishable");
    check("coverage states the ratio", /2 of 4/.test(text), text.split("\n")[0]);
    check("coverage declares INCOMPLETE", /INCOMPLETE/.test(text));

    // --- No accessible members at all ---
    const nobody = await enumerateCollection("risk-register", ["engineering:public"]);
    check("no accessible members -> empty, not silent success", nobody.members.length === 0);
    check("  renderCoverage says nothing can be aggregated",
      /Nothing can be aggregated/.test(renderCoverage(nobody)));

    // --- A collection nobody registered ---
    const absent = await enumerateCollection("dfmea", REVIEWER);
    check("unregistered collection returns zero members", absent.totalRegistered === 0);
    check("  and is NOT marked complete", !absent.complete);
  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} enumeration - ${err instanceof Error ? err.message : err}`);
    console.log("     (did you run migrations? 0006_subject_and_collection)");
  } finally {
    await db.delete(table_registry).where(inArray(table_registry.id, ids)).catch(() => {});
    // Restore the real risk-register rows we snapshotted out of the way.
    if (preexisting.length) await db.insert(table_registry).values(preexisting).catch(() => {});
  }

  await closeDb();
  console.log("");
  if (failed === 0) console.log(`${GREEN}Subject scoping + enumeration sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});