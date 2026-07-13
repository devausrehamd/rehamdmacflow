// scripts/smoke-test-scoring.ts
//
// The deterministic rubric scorer and pattern pre-check.
//
// The LLM judge returns one bit per criterion; THIS code turns those bits into
// a score, a gate decision, and an approval outcome. The model never sees the
// weights. Tested against the real export-control rubric and its real weights.
//
// Pure - no LLM, no DB. Usage: npm run smoke:scoring

import { getRubric } from "../src/drafting/rubric-loader.js";
import { checkPatterns, scoreRubric, renderRubricResult, type CriterionVerdict } from "../src/drafting/scoring.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

const allPass = (ids: string[]): CriterionVerdict[] =>
  ids.map((id) => ({ id, verdict: "pass" as const, source: "llm_judge" as const, rationale: "" }));

function main(): void {
  console.log("=== Rubric scoring smoke test ===\n");

  const { rubric } = getRubric("export-control");
  check("export-control loads with unified criteria", rubric.criteria.length === 9, String(rubric.criteria.length));
  check("three criteria are critical gates",
    rubric.criteria.filter((c) => c.gate === "critical").length === 3);

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

  console.log("");
  if (failed === 0) console.log(`${GREEN}Scoring is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();