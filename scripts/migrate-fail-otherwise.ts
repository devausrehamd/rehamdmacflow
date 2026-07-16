// scripts/migrate-fail-otherwise.ts
//
// Normalise every criterion to the one mandated form: "PASS if <X>. FAIL
// otherwise." Rubrics generated with "PASS if <X>. FAIL if <Y>." (or any other
// FAIL clause) are rewritten so the rule states one exhaustive boundary, and
// the <Y> failure description is MOVED into `explanation` verbatim - the judge
// sees explanation too, so nothing about what a fail looks like is lost.
//
//   node: npx tsx scripts/migrate-fail-otherwise.ts          # preview only
//         npx tsx scripts/migrate-fail-otherwise.ts --write   # apply
//
// Idempotent: a criterion already ending "FAIL otherwise." is left untouched.

import { readFileSync, writeFileSync, globSync } from "node:fs";

const WRITE = process.argv.includes("--write");

// PASS if <pass>. FAIL <fail>.   — <pass> non-greedy up to the LAST ". FAIL".
const SPLIT = /^(\s*PASS if\b[\s\S]*?)\.\s*FAIL\b\s*([\s\S]*?)\.\s*$/i;

interface Crit { id: string; criterion: string; explanation?: string; [k: string]: unknown }

/** Turn a raw FAIL clause into a readable failure sentence for the explanation.
 *  "if the comparison is wrong" -> "Fails when the comparison is wrong." */
function failSentence(rawFail: string): string {
  const body = rawFail.trim().replace(/^(if|when|where)\s+/i, "");
  if (!body) return "";
  const cap = body.charAt(0).toUpperCase() + body.slice(1);
  return `Fails when ${body}.`.replace(/\s+/g, " ").replace("Fails when " + cap, "Fails when " + body);
}

let changed = 0;
let already = 0;
let unparseable = 0;

for (const file of globSync("rubrics/*.json").sort()) {
  const rubric = JSON.parse(readFileSync(file, "utf8")) as { criteria: Crit[] };
  let fileTouched = false;

  for (const c of rubric.criteria) {
    if (/\.\s*FAIL otherwise\.\s*$/i.test(c.criterion)) {
      already++;
      continue;
    }
    const m = SPLIT.exec(c.criterion);
    if (!m) {
      unparseable++;
      console.log(`  ??  ${file.replace("rubrics/", "")}[${c.id}]: cannot parse -> ${JSON.stringify(c.criterion.slice(0, 80))}`);
      continue;
    }
    const pass = m[1].trim();
    const failDesc = failSentence(m[2] ?? "");
    const newCriterion = `${pass}. FAIL otherwise.`;
    const newExplanation = [c.explanation?.trim(), failDesc].filter(Boolean).join(" ");

    if (changed < 6) {
      console.log(`\n  ~ ${file.replace("rubrics/", "")}[${c.id}]`);
      console.log(`    from: ${c.criterion}`);
      console.log(`    to:   ${newCriterion}`);
      console.log(`    expl+: ${failDesc || "(none added)"}`);
    }
    c.criterion = newCriterion;
    c.explanation = newExplanation;
    changed++;
    fileTouched = true;
  }

  if (WRITE && fileTouched) writeFileSync(file, JSON.stringify(rubric, null, 2) + "\n", "utf8");
}

console.log(`\n  ${changed} criteria rewritten, ${already} already correct, ${unparseable} unparseable.`);
console.log(WRITE ? "  WRITTEN." : "  PREVIEW ONLY — re-run with --write to apply.");
process.exit(unparseable > 0 ? 1 : 0);
