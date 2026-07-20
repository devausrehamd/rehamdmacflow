// scripts/smoke-test-grounding.ts
//
// The grounding gate (src/agent/grounding.ts): a planned query is validated
// against the schema BEFORE execution. A filter whose value falls outside its
// column's domain is a decode failure — a term the schema does not define — and
// is called out, not executed. A filter that is in-domain but happens to match
// nothing is a real (empty) answer and passes.
//
// This is the deterministic half of the deterministic/LLM boundary: it decides
// "can this be grounded?" with no model, so "How many Critical risks" surfaces
// "'Critical' isn't a defined field" instead of a confident, wrong 0.
//
// Pure and fast: no LLM, no server, no infra.
//
// Usage: npm run smoke:grounding

import { checkGrounding, fieldSummary, composeGroundingNotice } from "../src/agent/grounding.js";
import type { ColumnSchema } from "../src/data/table-schema.js";
import type { QueryRequest, FilterCondition } from "../src/data/query-builder.js";

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

// The Risk Register schema, as ingested (no severity/"Critical" field).
const COLUMNS: ColumnSchema[] = [
  { original: "Likelihood (1-5)", sql_name: "likelihood_1_5", type: "integer", nullable: false, sample_values: [4], value_domain: [1, 2, 3, 4], value_range: { min: 1, max: 4 } },
  { original: "Impact (1-5)", sql_name: "impact_1_5", type: "integer", nullable: false, sample_values: [5], value_domain: [2, 3, 4, 5], value_range: { min: 2, max: 5 } },
  { original: "Score", sql_name: "score", type: "integer", nullable: true, sample_values: [20], value_domain: [2, 4, 6, 8, 9, 12, 16, 20], value_range: { min: 2, max: 20 } },
  { original: "Status", sql_name: "status", type: "text", nullable: false, sample_values: ["Open"], value_domain: ["Open", "Closed"], value_range: null },
  { original: "Owner", sql_name: "owner", type: "text", nullable: false, sample_values: ["Feng"], value_domain: null, value_range: null },
];

const q = (conds: FilterCondition[]): QueryRequest => ({ filter: { op: "and", conditions: conds }, aggregate: { fn: "count" } });

function main(): void {
  console.log("=== Grounding gate ===\n");

  // --- Ungrounded: the planner's guess for "Critical" ---
  const guess = checkGrounding(q([{ column: "likelihood_1_5", op: "eq", value: 5 }]), COLUMNS);
  check("likelihood = 5 is UNGROUNDED (domain is 1–4)", !guess.grounded);
  check("  the reason names the real range", Boolean(guess.ungrounded[0]?.reason.includes("1–4")));

  // --- Ungrounded via comparison beyond the range ---
  check("likelihood >= 5 is UNGROUNDED (max is 4)", !checkGrounding(q([{ column: "likelihood_1_5", op: "gte", value: 5 }]), COLUMNS).grounded);

  // --- Grounded: real values, even when the result would be empty ---
  check("status = 'Open' is GROUNDED (a real value)", checkGrounding(q([{ column: "status", op: "eq", value: "Open" }]), COLUMNS).grounded);
  check("status = 'open' is GROUNDED (case-insensitive)", checkGrounding(q([{ column: "status", op: "eq", value: "open" }]), COLUMNS).grounded);
  check("score >= 16 is GROUNDED (within 2–20)", checkGrounding(q([{ column: "score", op: "gte", value: 16 }]), COLUMNS).grounded);
  check("owner = 'Feng' is GROUNDED (free text, no domain to disprove)", checkGrounding(q([{ column: "owner", op: "eq", value: "Feng" }]), COLUMNS).grounded);

  // --- status = 'Critical' is ungrounded (no such value) ---
  check("status = 'Critical' is UNGROUNDED", !checkGrounding(q([{ column: "status", op: "eq", value: "Critical" }]), COLUMNS).grounded);

  // --- One ungrounded leaf makes the query ungrounded ---
  const mixed = checkGrounding(q([{ column: "status", op: "eq", value: "Open" }, { column: "likelihood_1_5", op: "eq", value: 5 }]), COLUMNS);
  check("open AND likelihood=5 is UNGROUNDED (one bad leaf)", !mixed.grounded);
  check("  only the bad leaf is flagged", mixed.ungrounded.length === 1 && mixed.ungrounded[0]!.conditionText.includes("Likelihood"));

  // --- No filter, or aggregate-only, is grounded ---
  check("a bare count (no filter) is GROUNDED", checkGrounding({ aggregate: { fn: "count" } }, COLUMNS).grounded);

  // --- Field summary is human-readable ---
  const fields = fieldSummary(COLUMNS);
  check("field summary shows numeric ranges", fields.some((f) => f.includes("Likelihood") && f.includes("1–4")));
  check("field summary shows enum values", fields.some((f) => f.includes("Status") && f.includes("Open, Closed")));
  check("field summary marks free text", fields.some((f) => f.includes("Owner") && f.includes("free text")));

  // --- The call-it-out message ---
  const notice = composeGroundingNotice([
    { tableId: "t1", displayName: "Risk Register", ungrounded: guess.ungrounded, availableFields: fields },
  ]);
  check("notice refuses to guess", notice.includes("won't guess"));
  check("  names the unmatched condition", notice.includes("Likelihood") && notice.includes("= 5"));
  check("  lists the queryable fields", notice.includes("Fields you can query") && notice.includes("Status: Open, Closed"));
  check("  offers a grounded rephrase", notice.toLowerCase().includes("score ≥ 16") || notice.includes("score"));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Grounding gate is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
