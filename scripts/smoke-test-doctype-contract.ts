// scripts/smoke-test-doctype-contract.ts
//
// The DocumentType contract (Phase 3 of the agent-topology / custody-DAG spec).
// Proves the rubric + recipe now carry — and validate — the pipeline contract:
//
//   - `requiredInputs` (gathered research inputs) is accepted and stays DISTINCT
//     from `requires` (upstream generated documents) and `exportFormats` stays
//     distinct from `exports` (typed data artifacts)
//   - new step kinds (gather / check_readiness / export / act) parse
//   - capability PRE-FLIGHT: a gather's `requires` must be advertised, else bad_target
//   - a gather's `produces` must be a declared requiredInput, else bad_target
//   - an export step's `format` must be an allowed exportFormat, else bad_target
//
// Pure: no Postgres, no LLM, no Qdrant.
//
// Usage: npm run smoke:doctype-contract

import { rubricSchema } from "../src/drafting/rubric-schema.js";
import { recipeSchema, validateRecipe, RecipeError, type Step } from "../src/drafting/recipe.js";

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

/** Assert fn throws a RecipeError with the expected code. */
function expectBadTarget(name: string, fn: () => void, code = "bad_target"): void {
  try {
    fn();
    check(name, false, "expected a RecipeError, none thrown");
  } catch (e) {
    check(name, e instanceof RecipeError && e.code === code, e instanceof RecipeError ? `code=${e.code}` : String(e));
  }
}

/** Parse plain step objects into typed Steps via the recipe schema. */
function steps(...raw: unknown[]): Step[] {
  return recipeSchema.parse({ steps: raw }).steps;
}

function main(): void {
  console.log("=== DocumentType contract smoke test ===\n");

  // --- 1. The rubric schema accepts requiredInputs + exportFormats, and keeps
  //        them distinct from requires + exports. ---
  const parsed = rubricSchema.safeParse({
    documentType: "engineering-hours-budget",
    displayName: "Engineering Hours & Budget",
    version: "1.0.0",
    reviewThreshold: 0.8,
    criteria: [{ id: "c1", criterion: "PASS if the labor rate is cited from an approved source. FAIL otherwise.", weight: 1 }],
    // upstream GENERATED document dependency (existing field)
    requires: [{ documentType: "project-charter", domain: "engineering", consume: ["scope"], reason: "scope drives hours" }],
    // gathered RESEARCH inputs (new field) — a different concept
    requiredInputs: [
      { id: "labor_rate", description: "approved blended labor rate", capability: "research:sales" },
      { id: "headcount", description: "planned headcount", capability: "research:qms" },
    ],
    // typed DATA artifacts downstream docs consume (existing field)
    exports: { hoursTable: { description: "hours by role", schema: "HoursRow[]" } },
    // allowed OUTPUT formats (new field) — a different concept
    exportFormats: ["md", "docx"],
  });
  check("rubric with requiredInputs + exportFormats parses", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
  if (parsed.success) {
    check("requiredInputs kept distinct from requires",
      parsed.data.requiredInputs.length === 2 && parsed.data.requires.length === 1);
    check("exportFormats kept distinct from exports (data artifacts)",
      parsed.data.exportFormats.length === 2 && Object.keys(parsed.data.exports).length === 1);
  }

  // --- 2. New step kinds parse. ---
  const pipeline = steps(
    { id: "g", kind: "gather", requests: [
      { requires: "research:sales", produces: "labor_rate" },
      { requires: "research:qms", produces: "headcount" },
    ] },
    { id: "ready", kind: "check_readiness", inputs: ["g"] },
    { id: "write", kind: "export", format: "md", inputs: ["ready"] },
    { id: "send", kind: "act", channel: "email", inputs: ["write"] },
  );
  check("gather (fan-out) / check_readiness / export / act all parse", pipeline.length === 4);

  const inputIds = new Set(["labor_rate", "headcount"]);
  const exportFormats = new Set(["md", "docx"]);
  const noSections = new Set<string>();

  // --- 3. Capability pre-flight: passes when advertised, fails when not. ---
  validateRecipe(pipeline, noSections, {
    capabilities: new Set(["research:sales", "research:qms"]),
    inputIds,
    exportFormats,
  });
  check("validates when every required capability is advertised", true);

  expectBadTarget("unadvertised capability -> bad_target", () =>
    validateRecipe(pipeline, noSections, {
      capabilities: new Set(["research:qms"]), // research:sales missing
      inputIds,
      exportFormats,
    }),
  );

  // --- 4. gather.produces must be a declared requiredInput. ---
  expectBadTarget("gather produces an undeclared input -> bad_target", () =>
    validateRecipe(
      steps({ id: "g", kind: "gather", requests: [{ requires: "research:sales", produces: "not_declared" }] }),
      noSections,
      { inputIds },
    ),
  );

  // --- 5. export.format must be an allowed exportFormat. ---
  expectBadTarget("export to a disallowed format -> bad_target", () =>
    validateRecipe(
      steps({ id: "w", kind: "export", format: "pdf" }),
      noSections,
      { exportFormats }, // only md/docx allowed
    ),
  );
  // ...and the allowed format passes.
  validateRecipe(steps({ id: "w", kind: "export", format: "docx" }), noSections, { exportFormats });
  check("export to an allowed format validates", true);

  // --- 6. Pre-flight is skipped when no sets are supplied (load before Discovery). ---
  validateRecipe(pipeline, noSections);
  check("shape-only validation (no capability set) still passes", true);

  console.log("");
  if (failed === 0) console.log(`${GREEN}DocumentType contract is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
