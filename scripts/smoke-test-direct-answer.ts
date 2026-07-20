// scripts/smoke-test-direct-answer.ts
//
// The exact-data short-circuit composer (src/agent/compose-exact.ts). When the
// SQL researcher already holds the answer to a quantitative question, the answer
// is composed deterministically and NO LLM is called — so a count answer is
// fast, reproducible, and unit-testable, and cannot leak a placeholder.
//
// Covers: quantitative-question gating (and the cross-referencing case that must
// not be fooled by a table named "Issues List"), a single count, a multi-table
// cross-reference with a combined total, and every fall-back-to-LLM condition.
//
// Pure and fast: no LLM, no server, no infra.
//
// Usage: npm run smoke:direct-answer

import { composeExactAnswer, isQuantitativeQuestion } from "../src/agent/compose-exact.js";
import type { SqlResult } from "../src/agent/state.js";
import type { RetrievedChunk } from "../src/queries.js";

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

function countResult(tableId: string, displayName: string, n: number): SqlResult {
  return { tableId, displayName, executedSql: `SELECT COUNT(*) AS result FROM ${tableId}`, rowCount: 1, rows: [{ result: n }] };
}
function blurb(tableId: string, sourcePath: string): RetrievedChunk {
  return { id: tableId, text: "", score: 1, source_path: sourcePath, table_id: tableId, has_structured_table: true };
}

function main(): void {
  console.log("=== Exact-data short-circuit composer ===\n");

  // --- Quantitative-question gating ---
  check("'how many' is quantitative", isQuantitativeQuestion("How many Critical risks are there?"));
  check("'number of' is quantitative", isQuantitativeQuestion("What is the number of open risks?"));
  check("a count question naming 'Issues List' is still quantitative", isQuantitativeQuestion(
    "How many open issues are there in the Risk Register and Issues List that are High or above?",
  ));
  check("'how many … and what are they' is NOT (needs prose)", !isQuantitativeQuestion("How many risks are there and what are they?"));
  check("'which risks are critical' is NOT quantitative", !isQuantitativeQuestion("Which risks are critical?"));
  check("'describe the risks' is NOT quantitative", !isQuantitativeQuestion("Describe the open risks."));

  // --- Single exact answer ---
  const single = composeExactAnswer(
    "How many Critical risks are there?",
    { t1: countResult("t1", "Risk Register", 5) },
    { operations: [blurb("t1", "00_Program_Management/Risk/Risk_Register.xlsx")] },
  );
  check(
    "single count composes deterministically with its source",
    single === 'There are 5 matching records in the "Risk Register".\n\nCitation: [Source: 00_Program_Management/Risk/Risk_Register.xlsx]',
    single ?? "null",
  );

  // --- Cross-reference: two tables, a breakdown, and a combined total ---
  const cross = composeExactAnswer(
    "How many open issues are there in the Risk Register and Issues List that are High or above?",
    { t1: countResult("t1", "Risk Register", 3), t2: countResult("t2", "Issues List", 5) },
    { operations: [blurb("t1", "05_Risk/Risk_Register.xlsx"), blurb("t2", "03_Issues/Issues_List.xlsx")] },
  );
  check("cross-reference shows a per-source breakdown", Boolean(cross?.includes('- "Risk Register" — 3 matching records [Source: 05_Risk/Risk_Register.xlsx]')));
  check("  and each source's own count + citation", Boolean(cross?.includes('- "Issues List" — 5 matching records [Source: 03_Issues/Issues_List.xlsx]')));
  check("  and a combined total (3 + 5 = 8)", Boolean(cross?.includes("Combined total: 8 matching records across 2 sources.")));

  // --- Fall back to the LLM path (returns null) ---
  check("non-quantitative question -> null", composeExactAnswer("Which risks are critical?", { t1: countResult("t1", "Risk Register", 5) }, {}) === null);
  check("no SQL results -> null", composeExactAnswer("How many risks?", {}, {}) === null);
  const listResult: SqlResult = { tableId: "t1", displayName: "Risk Register", executedSql: "SELECT risk_id FROM t1", rowCount: 2, rows: [{ risk_id: "R1" }, { risk_id: "R2" }] };
  check("a non-scalar (list) result -> null", composeExactAnswer("How many risks?", { t1: listResult }, {}) === null);

  // --- Missing source path still cites, by display name ---
  const noSource = composeExactAnswer("How many risks?", { t1: countResult("t1", "Risk Register", 5) }, {});
  check("missing source path falls back to the display name", Boolean(noSource?.includes("[Source: Risk Register]")));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Exact-data short-circuit is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
