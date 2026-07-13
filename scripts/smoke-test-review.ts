// scripts/smoke-test-review.ts
//
// The review contract, pure parts: human-edit provenance and the renderer.
// No LLM, no server - the diff and the markdown are pure functions.
//
//   - a reviewer edit is a field-level delta with recorded prior provenance
//   - editing a computed field raises the auditor red flag
//   - the original rows are never mutated (append-only provenance)
//   - the renderer is a faithful projection: gaps show as INSUFFICIENT EVIDENCE,
//     status banner present, never dresses a draft as approved
//
// Usage: npm run smoke:review

import { getRubric } from "../src/drafting/rubric-loader.js";
import { sectionSchema } from "../src/drafting/section-schema.js";
import { computeHumanEdits } from "../src/drafting/human-edit.js";
import { renderMarkdown } from "../src/drafting/render-markdown.js";
import { INSUFFICIENT_EVIDENCE, type ValidatedRow } from "../src/drafting/section-validator.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

function main(): void {
  console.log("=== Review contract smoke test ===\n");
  const { rubric } = getRubric("dfmea");
  const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === "failure_modes"));

  const original: ValidatedRow[] = [
    { values: { item: "Battery pack", failure_mode: "Thermal runaway", effect: "Fire", risk_ref: "R-014", severity: 9, occurrence: 3, detection: 4, rpn: 108 }, gaps: [] },
  ];

  // --- Human edits ---
  const r1 = computeHumanEdits(spec, original, [{ severity: 7, effect: "Fire and explosion" }]);
  check("two field edits detected", r1.edits.length === 2);
  check("severity delta 9->7 with prior provenance recorded",
    r1.edits.some((e) => e.field === "severity" && e.from === 9 && e.to === 7 && e.priorProvenance === "retrieved"));
  check("edited fields flip to human_edited", r1.provenanceOverrides.severity === "human_edited");
  check("original rows NOT mutated", original[0].values.severity === 9);
  check("no computed override in this edit", !r1.hasComputedOverride);

  // --- Computed override: the red flag ---
  const r2 = computeHumanEdits(spec, original, [{ rpn: 999 }]);
  check("overriding computed RPN is flagged", r2.hasComputedOverride);
  check("  the edit records overridesComputed", r2.edits[0].overridesComputed);

  // --- Renderer: faithful projection ---
  const gappy: ValidatedRow[] = [
    { values: { item: "Buck converter", failure_mode: "Overcurrent", effect: "Shutdown", risk_ref: "R-022", severity: 6, occurrence: 4, detection: INSUFFICIENT_EVIDENCE, rpn: INSUFFICIENT_EVIDENCE }, gaps: ["detection", "rpn"] },
  ];
  const md = renderMarkdown({
    displayName: rubric.displayName, section: spec, rows: gappy,
    status: "pending_review", correlationId: "cor_test123456789012",
  });
  check("renderer shows DRAFT banner", /DRAFT — REVIEW REQUIRED/.test(md));
  check("renderer shows gap as INSUFFICIENT EVIDENCE, not blank", /INSUFFICIENT EVIDENCE/.test(md));
  check("renderer stamps the correlation id", /cor_test123456789012/.test(md));
  check("renderer notes incompleteness", /INCOMPLETE/.test(md));

  const approved = renderMarkdown({
    displayName: rubric.displayName, section: spec, rows: original,
    status: "approved", correlationId: "cor_test123456789012",
  });
  check("approved draft shows APPROVED banner", /APPROVED/.test(approved) && !/DRAFT/.test(approved));

  console.log("\n--- sample rendered draft ---");
  console.log(md);
  console.log("---\n");

  if (failed === 0) console.log(`${GREEN}Review contract sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();