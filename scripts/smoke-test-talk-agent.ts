// scripts/smoke-test-talk-agent.ts
//
// The Talk Agent's capability selection (Stage 5). Proves the "select" step:
//
//   - an ordinary question selects the research (answer) capability
//   - "draft a <known doc type>" selects that draft capability
//   - draft intent with no known document type -> clarify
//   - an empty / too-short request -> clarify
//   - the selection surfaces alternatives and a response-safe view
//
// Pure: no network, DB, or LLM.
//
// Usage: npm run smoke:talk-agent

import { selectCapability, describeSelection } from "../src/orchestrator/capability-select.js";

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

function main(): void {
  console.log("=== Talk Agent capability selection smoke test ===\n");

  // Ordinary question -> research (answer).
  const q1 = selectCapability("How many open risks does A. Singh own?");
  check("a question selects the research capability", q1.capability.id === "research:qms" && q1.capability.kind === "answer");
  check("  and does not ask for clarification", q1.clarify === false);

  // Draft a known document type.
  const q2 = selectCapability("Draft a CAPA for the defect found on line 3");
  check("'draft a CAPA' selects draft:capa", q2.capability.id === "draft:capa" && q2.capability.kind === "draft");
  const q3 = selectCapability("please generate a DFMEA for the pump assembly");
  check("'generate a DFMEA' selects draft:dfmea", q3.capability.id === "draft:dfmea");

  // Draft intent, no known document type -> clarify.
  const q4 = selectCapability("draft a spaceship blueprint");
  check("draft intent with no known doc type -> clarify", q4.clarify === true);

  // Too short / empty -> clarify.
  check("empty request -> clarify", selectCapability("").clarify === true);
  check("too-short request -> clarify", selectCapability("hi").clarify === true);

  // Alternatives + response-safe view.
  const view = describeSelection(q1);
  check("describeSelection exposes id/kind/confidence, not keyword lists",
    view.capability === "research:qms" && typeof view.confidence === "number" && !("keywords" in view));
  check("alternatives list the other capabilities", q1.alternatives.length >= 1 && q1.alternatives.every((a) => a.id !== "research:qms"));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Talk Agent selection is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
