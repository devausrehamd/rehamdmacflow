// scripts/smoke-test-section.ts
//
// The section validator - the deterministic gate before the LLM is trusted.
//
// Pure. No LLM, no Postgres, no Qdrant. Feeds the validator:
//   - a COMPLETE, correct DFMEA section         -> passes, RPN computed
//   - a section with a MISSING required field   -> gap, insufficient_evidence
//   - a fabricated RPN                          -> recomputed, mismatch recorded
//   - an out-of-scale severity                  -> range error
//   - a retrieved field with no source          -> ungrounded (fabrication)
//   - a cross-reference not in the risk register-> reference_not_found
//
// This is what proves "what goes in a DFMEA" is enforced deterministically,
// before a single token is generated.
//
// Usage: npm run smoke:section

import { getRubric } from "../src/drafting/rubric-loader.js";
import { sectionSchema } from "../src/drafting/section-schema.js";
import {
  validateSection,
  renderSectionCoverage,
  INSUFFICIENT_EVIDENCE,
  type ProducedRow,
} from "../src/drafting/section-validator.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`); }
}

// The valid risk ids the DFMEA may cross-reference (from an approved register).
const riskIds = new Set(["R-001", "R-014", "R-022"]);
const refSets = { "risk-register.riskItems.id": riskIds };

function cell(value: unknown, sourceRef?: string): { value: unknown; sourceRef?: string } {
  return sourceRef !== undefined ? { value, sourceRef } : { value };
}

function main(): void {
  console.log("=== Section validator smoke test ===\n");

  // Load the DFMEA section straight from the rubric - proves the declared
  // schema itself is well-formed.
  const { rubric } = getRubric("dfmea");
  check("dfmea declares a failure_modes section", rubric.sections.some((s) => s.id === "failure_modes"));
  const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === "failure_modes"));
  check("section schema validates", spec.fields.length === 8, `${spec.fields.length} fields`);
  check("rpn is a computed field with a formula",
    spec.fields.find((f) => f.name === "rpn")?.provenance === "computed");

  // --- A complete, correct row ---
  const good: ProducedRow = {
    item: cell("Battery pack", "chunk-a1"),
    failure_mode: cell("Thermal runaway"),
    effect: cell("Cell venting, fire risk"),
    risk_ref: cell("R-014", "chunk-a1"),
    severity: cell(9, "chunk-b2"),
    occurrence: cell(3, "chunk-b2"),
    detection: cell(4, "chunk-b2"),
    rpn: cell(108), // model's attempt - should be RECOMPUTED to 9*3*4=108
  };
  const v1 = validateSection(spec, [good], refSets);
  check("complete row: no gaps", !v1.hasGaps);
  check("complete row: no errors", !v1.hasErrors, JSON.stringify(v1.findings));
  check("complete row: RPN computed to 108", v1.rows[0].values.rpn === 108, String(v1.rows[0].values.rpn));

  // --- Model fabricates a wrong RPN: code overrides, records mismatch ---
  const wrongRpn: ProducedRow = { ...good, rpn: cell(999) };
  const v2 = validateSection(spec, [wrongRpn], refSets);
  check("fabricated RPN overridden with computed value", v2.rows[0].values.rpn === 108);
  check("  mismatch is recorded", v2.findings.some((f) => f.kind === "computed_mismatch"));

  // --- Missing required field: GAP, not invention ---
  const gappy: ProducedRow = { ...good };
  delete gappy.detection;
  const v3 = validateSection(spec, [gappy], refSets);
  check("missing detection -> gap", v3.hasGaps);
  check("  detection marked insufficient_evidence", v3.rows[0].values.detection === INSUFFICIENT_EVIDENCE);
  check("  detection listed in row gaps", v3.rows[0].gaps.includes("detection"));
  check("  RPN could not compute (dependency gap)", v3.rows[0].values.rpn === INSUFFICIENT_EVIDENCE);

  // --- Out-of-scale rating ---
  const badScale: ProducedRow = { ...good, severity: cell(15, "chunk-b2") };
  const v4 = validateSection(spec, [badScale], refSets);
  check("severity 15 (scale is 1-10) -> range error",
    v4.findings.some((f) => f.field === "severity" && f.kind === "range_error"));
  check("  and hasErrors is set", v4.hasErrors);

  // --- Retrieved field with no source: fabrication ---
  const ungrounded: ProducedRow = { ...good, severity: cell(9) }; // no sourceRef
  const v5 = validateSection(spec, [ungrounded], refSets);
  check("retrieved severity with no source -> ungrounded",
    v5.findings.some((f) => f.field === "severity" && f.kind === "ungrounded_retrieved"));

  // --- Cross-reference not in the approved register ---
  const badRef: ProducedRow = { ...good, risk_ref: cell("R-999", "chunk-a1") };
  const v6 = validateSection(spec, [badRef], refSets);
  check("risk_ref R-999 not in register -> reference_not_found",
    v6.findings.some((f) => f.field === "risk_ref" && f.kind === "reference_not_found"));
  check("  a fabricated cross-reference cannot pass", v6.hasErrors);

  // --- The coverage statement ---
  console.log("\n--- renderSectionCoverage (the gappy row) ---");
  console.log(renderSectionCoverage(v3));
  console.log("---\n");
  check("coverage declares INCOMPLETE on a gap", /INCOMPLETE/.test(renderSectionCoverage(v3)));
  check("coverage requires human review", /Human review required/.test(renderSectionCoverage(v3)));
  check("complete section reads 'complete'", /complete/.test(renderSectionCoverage(v1)));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Section validator is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();