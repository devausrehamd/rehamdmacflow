// scripts/smoke-test-scoring.ts
//
// The deterministic rubric scorer and pattern pre-check.
//
// The LLM judge returns one bit per criterion; THIS code turns those bits into
// a score, a gate decision, and an approval outcome. The model never sees the
// weights. Tested against an INLINE rubric fixture so the scoring logic is
// exercised independently of which rubric files happen to be committed.
//
// Pure - no LLM, no DB. Usage: npm run smoke:scoring

import { rubricSchema } from "../src/drafting/rubric-schema.js";
import { checkPatterns, scoreRubric, renderRubricResult, type CriterionVerdict } from "../src/drafting/scoring.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

const allPass = (ids: string[]): CriterionVerdict[] =>
  ids.map((id) => ({ id, verdict: "pass" as const, source: "llm_judge" as const, rationale: "" }));

// An inline rubric exercising every scoring path: a critical + primary anti-
// fabrication gate (deterministic patterns), weighted objective criteria, and a
// minor criterion that lowers the score without failing the gate. Weights total
// 100, and the critical weight (10) is small enough that failing it leaves the
// score > 0.8 - so the test proves the GATE, not the score, blocks approval.
const rubric = rubricSchema.parse({
  documentType: "scoring-fixture",
  displayName: "Scoring Fixture",
  version: "1.0.0",
  reviewThreshold: 0.8,
  criteria: [
    {
      id: "no_fabricated_prior_state",
      criterion: "PASS if no fabricated prior export-control state is asserted. FAIL otherwise.",
      explanation: "Fabricating a prior classification (a claimed old ECCN, a dated review) is an auto-fail.",
      weight: 10, primary: true, gate: "critical", assessmentType: "deterministic",
      forbiddenPatterns: [
        { pattern: "was EAR99", label: "prior EAR99 claim" },
        { pattern: "prior 3A001", label: "prior ECCN claim" },
        { pattern: "\\d{4}-\\d{2} CDR", label: "dated CDR reference" },
      ],
    },
    { id: "atlas_rollup_ear99", criterion: "PASS if the Atlas roll-up classifies to EAR99 on function. FAIL otherwise.", weight: 30, primary: true, gate: "major" },
    { id: "classification_justified", criterion: "PASS if the classification is justified against the ECCN text. FAIL otherwise.", weight: 30, gate: "major" },
    { id: "reviewer_noted", criterion: "PASS if a reviewer note is present. FAIL otherwise.", weight: 20, gate: "minor" },
    { id: "format_ok", criterion: "PASS if the document follows the required section format. FAIL otherwise.", weight: 10, gate: "major" },
  ],
});

function main(): void {
  console.log("=== Rubric scoring smoke test ===\n");

  check("fixture loads with five criteria", rubric.criteria.length === 5, String(rubric.criteria.length));
  check("one criterion is a critical gate", rubric.criteria.filter((c) => c.gate === "critical").length === 1);

  // --- Pattern pre-check: the anti-fabrication criterion ---
  const antiFab = rubric.criteria.find((c) => c.id === "no_fabricated_prior_state")!;
  check("'was EAR99' caught by pattern", !checkPatterns(antiFab, "The part was EAR99 before RevC.").passed);
  check("'prior 3A001.x' caught", !checkPatterns(antiFab, "It had prior 3A001.x status.").passed);
  check("'2023-06 CDR' caught", !checkPatterns(antiFab, "Per the 2023-06 CDR ...").passed);
  check("clean text passes", checkPatterns(antiFab, "Atlas classifies to EAR99 on function.").passed);

  const ids = rubric.criteria.map((c) => c.id);

  // --- All pass -> approved ---
  let r = scoreRubric(rubric, allPass(ids));
  check("all pass -> approved, score 1.0", r.approved && r.score === 1);

  // --- One critical fails -> gate blocks despite high score ---
  const critFail = allPass(ids).map((v) =>
    v.id === "no_fabricated_prior_state" ? { ...v, verdict: "fail" as const, rationale: "asserted a prior CDR" } : v,
  );
  r = scoreRubric(rubric, critFail);
  check("critical fail -> gate FAILS", !r.gatePassed);
  check("  score still high (> 0.8)", r.score > 0.8, `${(r.score * 100).toFixed(1)}%`);
  check("  NOT approved despite the score", !r.approved);
  check("  review required", r.reviewRequired);
  check("  the critical failure is named", r.criticalFailures.includes("no_fabricated_prior_state"));
  check("  it is also a primary failure", r.primaryFailures.includes("no_fabricated_prior_state"));

  // --- Missing verdicts fail closed ---
  r = scoreRubric(rubric, allPass(["atlas_rollup_ear99"]));
  check("missing verdicts fail closed", !r.approved);

  // --- Minor fail lowers score, gate holds ---
  const minorFail = allPass(ids).map((v) => {
    const c = rubric.criteria.find((x) => x.id === v.id)!;
    return c.gate === "minor" ? { ...v, verdict: "fail" as const } : v;
  });
  r = scoreRubric(rubric, minorFail);
  check("minor fail: gate still passes", r.gatePassed);
  check("  score below 1.0", r.score < 1, `${(r.score * 100).toFixed(1)}%`);

  console.log("\n--- renderRubricResult (one critical fail) ---");
  console.log(renderRubricResult(rubric, scoreRubric(rubric, critFail)));
  console.log("---\n");

  if (failed === 0) console.log(`${GREEN}Scoring is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
