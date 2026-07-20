// scripts/smoke-test-derivations.ts
//
// The derivation registry (src/agent/derivations.ts): the QMS defines interpretive
// terms ("critical" -> score >= 16) and the planner is handed those definitions so
// it decodes rather than guesses. A term with no definition stays undefined — the
// grounding gate calls it out.
//
// Covers the deterministic half: the shipped registry loads, terms/aliases resolve
// to their predicate only when the column exists and the table scope matches, and
// the definition is injected into the planner prompt. The LLM's use of the
// definition is exercised live (npm run integration), not here.
//
// Pure and fast: no LLM, no server, no infra.
//
// Usage: npm run smoke:derivations

import { loadDerivations, applicableDerivations, definitionsBlock } from "../src/agent/derivations.js";
import { buildPlanPrompt } from "../src/agent/sql-planner.js";
import type { ColumnSchema } from "../src/data/table-schema.js";

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

const col = (sql_name: string, type: ColumnSchema["type"]): ColumnSchema => ({
  original: sql_name, sql_name, type, nullable: false, sample_values: [],
});
const RISK_COLS: ColumnSchema[] = [col("risk_id", "text"), col("score", "integer"), col("status", "text"), col("owner", "text")];
const NO_SCORE_COLS: ColumnSchema[] = [col("issue_id", "text"), col("status", "text")];

function main(): void {
  console.log("=== Derivation registry ===\n");

  // --- The shipped registry loads ---
  const all = loadDerivations();
  check("the QMS registry loads", all.length > 0, `loaded ${all.length}`);
  check("  it defines 'critical'", all.some((d) => d.term === "critical"));

  // --- Resolution: term present, column exists, table scope matches ---
  const crit = applicableDerivations("How many Critical risks are there?", "Risk Register", RISK_COLS, all);
  check("'critical' resolves for the Risk Register", crit.length === 1 && crit[0]!.term === "critical");
  check("  to the score>=16 predicate", crit[0]?.predicate.column === "score" && crit[0]?.predicate.op === "gte" && crit[0]?.predicate.value === 16);

  // --- Aliases resolve ---
  check("an alias ('showstopper') resolves to 'critical'", applicableDerivations("how many showstopper risks", "Risk Register", RISK_COLS, all).some((d) => d.term === "critical"));
  check("'high or above' resolves", applicableDerivations("open issues that are high or above", "Risk Register", RISK_COLS, all).some((d) => d.term === "high or above"));

  // --- Non-matches ---
  check("a question with no interpretive term resolves nothing", applicableDerivations("how many open risks", "Risk Register", RISK_COLS, all).length === 0);
  check("no match when the predicate column is absent", applicableDerivations("how many critical issues", "Issues List", NO_SCORE_COLS, all).length === 0);
  check("no match when the table scope differs", applicableDerivations("how many critical issues", "Issues List", RISK_COLS, all).length === 0);

  // --- Definitions render as an exact filter for the model to copy ---
  const block = definitionsBlock(crit);
  check("the definitions block shows the exact filter JSON", block.includes('"column":"score"') && block.includes('"op":"gte"') && block.includes('"value":16'));
  check("empty definitions render nothing", definitionsBlock([]) === "");

  // --- Injected into the planner prompt when applicable, absent otherwise ---
  const withDefs = buildPlanPrompt("How many Critical risks are there?", RISK_COLS, crit);
  check("planner prompt carries the definition", withDefs.includes("Defined terms for this table") && withDefs.includes('"value":16'));
  const withoutDefs = buildPlanPrompt("How many risks are there?", RISK_COLS, []);
  check("planner prompt omits the block when there are no definitions", !withoutDefs.includes("Defined terms for this table"));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Derivation registry is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
