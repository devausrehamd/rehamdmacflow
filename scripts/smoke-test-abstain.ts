// scripts/smoke-test-abstain.ts
//
// The decoder abstain contract (increment 3). We cannot enumerate every judgment
// word, so the LLM planner — the only thing that understands language — must
// SELF-DECLARE an interpretive term it cannot map to a column value or a defined
// term, instead of inventing a filter. The system then calls it out.
//
// Covers the deterministic half: the planner prompt carries the abstain rule and
// the {query, unresolved} contract; parsePlanResponse reads that contract and,
// crucially, still accepts a bare query so the common case never regresses; and
// the call-it-out notice renders an unresolved term with the QMS's defined terms
// as suggestions. The model's actual abstention is exercised live.
//
// Pure and fast: no LLM, no server, no infra.
//
// Usage: npm run smoke:abstain

import { parsePlanResponse, buildPlanPrompt } from "../src/agent/sql-planner.js";
import { composeGroundingNotice } from "../src/agent/grounding.js";
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

function main(): void {
  console.log("=== Decoder abstain contract ===\n");

  // --- parsePlanResponse reads the {query, unresolved} wrapper ---
  const wrapped = parsePlanResponse('{"query":{"aggregate":{"fn":"count"}},"unresolved":[{"term":"trivial","reason":"no defined threshold"}]}');
  check("reads the query from the wrapper", wrapped.query?.aggregate?.fn === "count");
  check("reads the unresolved term", wrapped.unresolved.length === 1 && wrapped.unresolved[0]!.term === "trivial");

  // --- Never regress: a bare query (no wrapper) still parses, with no abstentions ---
  const bare = parsePlanResponse('{"aggregate":{"fn":"count"},"filter":{"op":"and","conditions":[{"column":"status","op":"eq","value":"Open"}]}}');
  check("a bare query object still parses", bare.query?.aggregate?.fn === "count");
  check("  with zero unresolved terms", bare.unresolved.length === 0);

  // --- Tolerant of a malformed unresolved field ---
  check("non-array unresolved -> []", parsePlanResponse('{"query":{"aggregate":{"fn":"count"}},"unresolved":"oops"}').unresolved.length === 0);
  check("unresolved item missing a reason still keeps the term", parsePlanResponse('{"query":{},"unresolved":[{"term":"minor"}]}').unresolved[0]?.term === "minor");
  check("an empty unresolved list means fully resolved", parsePlanResponse('{"query":{"aggregate":{"fn":"count"}},"unresolved":[]}').unresolved.length === 0);

  // --- The planner prompt carries the abstain rule + output contract ---
  const prompt = buildPlanPrompt("How many trivial risks are there?", [col("score", "integer"), col("status", "text")], []);
  check("prompt instructs resolve-or-abstain", prompt.includes("RESOLVE OR ABSTAIN"));
  check("prompt specifies the {query, unresolved} output", prompt.includes('"query"') && prompt.includes('"unresolved"'));

  // --- The call-it-out notice renders an unresolved term with defined-term hints ---
  const notice = composeGroundingNotice([
    {
      tableId: "t1",
      displayName: "Risk Register",
      ungrounded: [],
      unresolvedTerms: [{ term: "trivial", reason: "no defined threshold and not a value in any column" }],
      availableFields: ["Score: 2–20", "Status: Open, Closed"],
      definedTerms: ["critical", "high or above"],
    },
  ]);
  check("notice names the unresolved term", notice.includes("trivial") && notice.includes("hasn't defined"));
  check("  suggests the terms the QMS DOES define", notice.includes("Defined terms you can use here: critical, high or above"));
  check("  lists queryable fields", notice.includes("Score: 2–20"));
  check("  points at the derivations registry", notice.includes("derivations registry"));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Abstain contract is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
