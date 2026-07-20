// src/agent/sql-planner.ts
//
// Two LLM-driven decisions for hybrid retrieval:
//
//   1. shouldQuerySql - the GATE. Given the question and the tables that
//      surfaced in retrieval, decide whether answering needs exact data
//      from SQL, or whether the prose context is sufficient. Avoids firing
//      SQL queries for purely descriptive questions.
//
//   2. planQuery - the PLANNER. Given the question and a table's schema,
//      generate the structured-query JSON the data API expects. Validation
//      happens at the API; if it rejects the query, replanQuery feeds the
//      error back for one corrective retry.
//
// Both use the local LLM. Both parse JSON defensively (7B models produce
// malformed JSON) and degrade gracefully: a gate failure falls back to a
// keyword heuristic; a planning failure skips that table (prose still answers).

import { llm } from "../llm-client.js";
import type { ColumnSchema } from "../data/table-schema.js";
import type { QueryRequest } from "../data/query-builder.js";
import { extractJson } from "./parse.js";
import { definitionsBlock, type Derivation } from "./derivations.js";

// ---- The gate ----

export interface AvailableTable {
  tableId: string;
  displayName: string;
  columnSummary: string; // "risk_id (text), owner (text), score (integer), ..."
}

export interface GateDecision {
  needsSql: boolean;
  tableIds: string[];
}

const SQL_KEYWORDS =
  /\b(how many|count|number of|total|sum|average|avg|most|least|highest|lowest|which|list all|how much|greater than|less than|more than|fewer than|owned by|assigned to|status of|where)\b/i;

/** Keyword heuristic fallback used when the LLM gate fails to parse. */
function heuristicGate(question: string, tables: AvailableTable[]): GateDecision {
  if (SQL_KEYWORDS.test(question)) {
    return { needsSql: true, tableIds: tables.map((t) => t.tableId) };
  }
  return { needsSql: false, tableIds: [] };
}

export async function shouldQuerySql(
  question: string,
  tables: AvailableTable[],
): Promise<GateDecision> {
  if (tables.length === 0) return { needsSql: false, tableIds: [] };

  const tableList = tables
    .map((t) => `- id: ${t.tableId}\n  name: ${t.displayName}\n  columns: ${t.columnSummary}`)
    .join("\n");

  const prompt = `You decide whether a question needs EXACT data from structured tables, or whether descriptive context is enough.

Available tables:
${tableList}

Question: ${question}

A question needs SQL if it asks for specific values, counts, filters, comparisons, aggregations, or "which/how many" style answers about the table data.
A question does NOT need SQL if it asks what a table is, what columns it has, or general descriptive information.

Respond with ONLY a JSON object, no other text:
{"needs_sql": true or false, "table_ids": ["id1", ...]}
Include only the table ids that are actually relevant to the question.`;

  try {
    const response = await llm.invoke(prompt);
    const parsed = extractJson(String(response.content)) as {
      needs_sql?: boolean;
      table_ids?: string[];
    };
    const needsSql = Boolean(parsed.needs_sql);
    const ids = Array.isArray(parsed.table_ids) ? parsed.table_ids : [];
    // Only keep ids that are actually in the available set
    const validIds = ids.filter((id) => tables.some((t) => t.tableId === id));
    return {
      needsSql: needsSql && validIds.length > 0,
      tableIds: needsSql ? validIds : [],
    };
  } catch {
    // Gate parse failed - fall back to the keyword heuristic
    return heuristicGate(question, tables);
  }
}

// ---- The planner ----

function schemaSummary(columns: ColumnSchema[]): string {
  return columns
    .map((c) => {
      const samples =
        c.sample_values.length > 0
          ? ` e.g. ${c.sample_values.map((v) => JSON.stringify(v)).join(", ")}`
          : "";
      return `  - ${c.sql_name} (${c.type}${c.nullable ? ", nullable" : ""})${samples}`;
    })
    .join("\n");
}

const PLANNER_RULES = `The query JSON supports:
{
  "select": ["col1", "col2"],          // omit for all columns
  "filter": {
    "op": "and" | "or",
    "conditions": [
      {"column": "col", "op": "eq|neq|gt|gte|lt|lte|in|like|ilike|is_null|is_not_null", "value": ...}
    ]
  },
  "aggregate": {"fn": "count|sum|avg|min|max", "column": "col"},
  "group_by": ["col"],
  "order_by": [{"column": "col", "dir": "asc|desc"}],
  "limit": 50
}

CRITICAL RULES:
- To COUNT rows, use "aggregate": {"fn": "count"}. NEVER put "count(*)", "count", or any function in "select". "select" and "group_by" accept ONLY real column names from the schema.
- For sum/avg/min/max, set "column" to a numeric column.
- Use ONLY column names that exist in the schema. Use exact string values as they appear in the samples.

EXAMPLES:
Question: "how many open risks does A. Singh own"
{"filter":{"op":"and","conditions":[{"column":"owner","op":"eq","value":"A. Singh"},{"column":"status","op":"eq","value":"Open"}]},"aggregate":{"fn":"count"}}

Question: "list the high-score risks"
{"select":["risk_id","title","score"],"filter":{"op":"and","conditions":[{"column":"score","op":"gte","value":15}]},"order_by":[{"column":"score","dir":"desc"}]}

Question: "count risks per status"
{"aggregate":{"fn":"count"},"group_by":["status"]}`;

/** Build the planner prompt. Pure — the QMS-defined terms (if any) are injected
 *  as authoritative so the model decodes "critical" to the declared filter rather
 *  than guessing. Separated out so the injection is unit-testable without an LLM. */
export function buildPlanPrompt(
  question: string,
  columns: ColumnSchema[],
  definitions: Derivation[] = [],
  previousError?: string,
): string {
  const errorNote = previousError
    ? `\nYour previous attempt was rejected with this error:\n${previousError}\nFix the query to address it.\n`
    : "";
  const defs = definitionsBlock(definitions);
  const defsSection = defs ? `\n${defs}\n` : "";

  return `Generate a structured query to answer the question using this table.

Table columns:
${schemaSummary(columns)}

${PLANNER_RULES}
${defsSection}${errorNote}
Question: ${question}

Respond with ONLY the query JSON object, no other text.`;
}

export async function planQuery(
  question: string,
  columns: ColumnSchema[],
  definitions: Derivation[] = [],
  previousError?: string,
): Promise<QueryRequest> {
  const prompt = buildPlanPrompt(question, columns, definitions, previousError);
  const response = await llm.invoke(prompt);
  const parsed = extractJson(String(response.content)) as QueryRequest;
  return parsed;
}