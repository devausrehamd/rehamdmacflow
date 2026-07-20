// scripts/smoke-test-citation.ts
//
// The deterministic citation net (src/agent/prompts.ts). A model told to cite
// sometimes emits a TEMPLATE placeholder instead of a real reference — most often
// on a "no data" answer. The prompts forbid it, but a 7B is unreliable, so
// repairCitation() replaces any placeholder with the sources actually retrieved,
// leaving real "[Source N: …]" citations untouched.
//
// Pure and fast: no LLM, no server, no infra.
//
// Usage: npm run smoke:citation

import { hasPlaceholderCitation, repairCitation, expandSourceCitations } from "../src/agent/prompts.js";

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

const SRC = ["05_Risk/Risk_Register_Summit.xlsx", "06_Correspondence/Weekly_Tag_Up.docx"];

function main(): void {
  console.log("=== Citation repair (deterministic net) ===\n");

  // --- Placeholders are detected ---
  for (const ph of [
    "Citation: [Insert relevant citation here]",
    "Citation: [relevant citation]",
    "Citation: [citation]",
    "Citation: [Source]",
    "See [Add your citation here].",
    "Citation: [TODO]",
  ]) {
    check(`detects placeholder: ${ph.slice(0, 34)}…`, hasPlaceholderCitation(ph), ph);
  }

  // --- Real citations are NOT flagged ---
  for (const real of [
    "Citation: [Source 2], [Source 5]",
    "Answer grounded in [Source 8: 06_Correspondence/Weekly_Tag_Up.docx].",
    "There are 16 risks. Citation: [Source 1]",
  ]) {
    check(`leaves real citation alone: ${real.slice(0, 34)}…`, !hasPlaceholderCitation(real), real);
  }

  // --- A "no data" answer gains a real citation from the reviewed sources ---
  const noData =
    "The provided context does not mention any risks owned by Singh.\n\nCitation: [Insert relevant citation here]";
  const repaired = repairCitation(noData, SRC);
  check("placeholder is replaced", !hasPlaceholderCitation(repaired), repaired);
  check("  the reviewed sources now appear", repaired.includes("Risk_Register_Summit.xlsx") && repaired.includes("Weekly_Tag_Up.docx"));
  check("  the answer wording is preserved", repaired.startsWith("The provided context does not mention"));

  // --- Distinct sources only, and empty-source case is graceful ---
  check("de-duplicates sources", repairCitation("x [citation]", ["a.docx", "a.docx"]) === "x [Source: a.docx]");
  check("no sources -> honest fallback, not a placeholder", repairCitation("x [Source]", []) === "x no matching source in the retrieved context");

  // --- A real citation passes through repair unchanged ---
  const good = "There are 16 risks. Citation: [Source 1: risks.xlsx]";
  check("real citation passes through unchanged", repairCitation(good, SRC) === good);

  // --- Bare numbered citations are expanded to the actual file path ---
  const ordered = ["05_Risk/Risk_Register_Summit.xlsx", undefined, undefined, undefined, "06_Correspondence/Weekly_Tag_Up.docx"];
  check(
    "expands bare [Source N] to [Source N: path]",
    expandSourceCitations("reviewed [Source 1], [Source 5]", ordered) ===
      "reviewed [Source 1: 05_Risk/Risk_Register_Summit.xlsx], [Source 5: 06_Correspondence/Weekly_Tag_Up.docx]",
  );
  check(
    "a citation that already has its path is left untouched",
    expandSourceCitations("[Source 1: risks.xlsx]", ordered) === "[Source 1: risks.xlsx]",
  );
  check(
    "an out-of-range source number is left as-is",
    expandSourceCitations("[Source 9]", ordered) === "[Source 9]",
  );

  console.log("");
  if (failed === 0) console.log(`${GREEN}Citation repair is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
