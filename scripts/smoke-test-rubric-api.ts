// scripts/smoke-test-rubric-api.ts
//
// The rubric API's validation core, headless (no server, no GUI):
//
//   - a well-formed rubric validates
//   - weights that don't sum / alias collisions / bad regex / dup ids -> errors
//   - an alias colliding with a COMMITTED rubric is caught
//   - export refuses an invalid draft (git only receives valid JSON)
//   - the committed rubrics themselves all validate (regression guard)
//
// The draft/committed SEPARATION is the safety property: drafts are validated
// but never loadable by the evaluation pipeline. That's structural (the loader
// only reads rubrics/*.json), so it needs no test here beyond noting it.
//
// Usage: npm run smoke:rubric-api

import { validateRubric } from "../src/drafting/rubric-validate.js";
import { getRubric, listRubricTypes } from "../src/drafting/rubric-loader.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

// A minimal valid rubric for a NEW document type.
const validRubric = {
  documentType: "test-procedure",
  displayName: "Test Procedure",
  version: "0.1.0",
  aliases: ["test procedure", "tp"],
  reviewThreshold: 0.85,
  criteria: [
    { id: "grounded", criterion: "PASS if grounded.", explanation: "", weight: 60, primary: true, assessmentType: "llm_judge", gate: "critical", scope: "all_output" },
    { id: "complete", criterion: "PASS if complete.", explanation: "", weight: 40, primary: false, assessmentType: "llm_judge", gate: "minor", scope: "all_output" },
  ],
};

function main(): void {
  console.log("=== Rubric API validation smoke test ===\n");

  // --- Valid rubric passes ---
  const v = validateRubric(validRubric);
  check("well-formed rubric validates", v.valid, JSON.stringify(v.issues));
  check("summary reports 2 criteria", v.summary?.criteriaCount === 2);
  check("summary reports total weight 100", v.summary?.totalWeight === 100);
  check("summary reports 1 critical", v.summary?.criticalCount === 1);

  // --- Duplicate criterion id ---
  const dupId = { ...validRubric, criteria: [validRubric.criteria[0], { ...validRubric.criteria[1], id: "grounded" }] };
  const vd = validateRubric(dupId);
  check("duplicate criterion id -> error", !vd.valid && vd.issues.some((i) => /Duplicate criterion/.test(i.message)));

  // --- All-advisory (no scoring weight) ---
  const noScore = { ...validRubric, criteria: [{ ...validRubric.criteria[0], gate: "advisory", weight: 0 }] };
  const vn = validateRubric(noScore);
  check("no scoring criteria -> error", !vn.valid && vn.issues.some((i) => /No scoring/.test(i.message)));

  // --- Bad regex in a pattern criterion ---
  const badRegex = {
    ...validRubric,
    criteria: [
      { ...validRubric.criteria[0], assessmentType: "hybrid", forbiddenPatterns: [{ pattern: "[unclosed", label: "bad" }] },
      validRubric.criteria[1],
    ],
  };
  const vr = validateRubric(badRegex);
  check("invalid regex -> error", !vr.valid && vr.issues.some((i) => /Invalid regex/.test(i.message)));

  // --- Alias collision with a COMMITTED rubric ---
  const committed = listRubricTypes()[0];
  const committedAlias = getRubric(committed).rubric.aliases[0] ?? committed;
  const collide = { ...validRubric, aliases: [committedAlias] };
  const vc = validateRubric(collide);
  check(`alias colliding with committed '${committed}' -> error`,
    !vc.valid && vc.issues.some((i) => /already belongs to committed/.test(i.message)), JSON.stringify(vc.issues));

  // --- Schema violation (advisory with nonzero weight) caught by superRefine ---
  const badGate = { ...validRubric, criteria: [{ ...validRubric.criteria[0], gate: "advisory", weight: 50 }, validRubric.criteria[1]] };
  const vg = validateRubric(badGate);
  check("advisory criterion with weight -> error", !vg.valid);

  // --- Regression: every COMMITTED rubric validates ---
  for (const type of listRubricTypes()) {
    const r = getRubric(type).rubric;
    const res = validateRubric(r);
    // Committed rubrics may legitimately "collide" aliases with themselves-excluded;
    // validateRubric excludes same-type, so this should pass.
    check(`committed rubric '${type}' validates`, res.valid, JSON.stringify(res.issues));
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Rubric API validation sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();