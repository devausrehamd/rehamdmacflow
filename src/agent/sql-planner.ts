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

INTERPRETIVE TERMS — RESOLVE OR ABSTAIN:
A qualitative judgment word — a severity, priority, size, importance, or recency term such as "critical", "major", "minor", "trivial", "severe", "urgent", "recent" — is NOT a column value. Only put it in a filter if it is listed under "Defined terms" above, or is an explicit value/threshold on a column in the schema. If it is neither, DO NOT invent a filter for it: leave it out of the query and list it under "unresolved". Guessing a filter for an undefined judgment word is WRONG; abstaining is correct.

OUTPUT: respond with ONLY this JSON object:
{"query": <the query object described above>, "unresolved": [{"term": "<word>", "reason": "<why it cannot be mapped>"}]}
"unresolved" is [] when every term maps to a column value/threshold or a defined term.

EXAMPLES:
Question: "how many open risks does A. Singh own"
{"query":{"filter":{"op":"and","conditions":[{"column":"owner","op":"eq","value":"A. Singh"},{"column":"status","op":"eq","value":"Open"}]},"aggregate":{"fn":"count"}},"unresolved":[]}

Question: "how many critical risks" (with "critical" defined above as score >= 16)
{"query":{"aggregate":{"fn":"count"},"filter":{"op":"and","conditions":[{"column":"score","op":"gte","value":16}]}},"unresolved":[]}

Question: "how many trivial risks" (no "trivial" definition, not a column value)
{"query":{"aggregate":{"fn":"count"}},"unresolved":[{"term":"trivial","reason":"no defined threshold and not a value in any column"}]}`;

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

Respond with ONLY the JSON object described under OUTPUT, no other text.`;
}

/** An interpretive term the planner declared it could not map to the schema or a
 *  defined term — it abstained rather than guess a filter (increment 3). */
export interface UnresolvedTerm {
  term: string;
  reason: string;
}

export interface PlanResult {
  query: QueryRequest;
  unresolved: UnresolvedTerm[];
}

/** Parse the planner's response into a PlanResult. Tolerant by design: it accepts
 *  the {query, unresolved} wrapper, but also a bare query object (a model that
 *  ignored the wrapper), so the common case never regresses — it just yields no
 *  abstentions. Pure, so the contract is unit-testable without an LLM. */
export function parsePlanResponse(content: string): PlanResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  if (parsed && typeof parsed === "object" && "query" in parsed) {
    const rawUnresolved = (parsed as { unresolved?: unknown }).unresolved;
    const unresolved = Array.isArray(rawUnresolved)
      ? rawUnresolved
          .filter((u): u is UnresolvedTerm => Boolean(u) && typeof (u as UnresolvedTerm).term === "string")
          .map((u) => ({ term: String(u.term), reason: String(u.reason ?? "") }))
      : [];
    return { query: (parsed as { query: QueryRequest }).query, unresolved };
  }
  // Bare query object (no wrapper) — treat the whole thing as the query.
  return { query: parsed as unknown as QueryRequest, unresolved: [] };
}

export async function planQuery(
  question: string,
  columns: ColumnSchema[],
  definitions: Derivation[] = [],
  previousError?: string,
): Promise<PlanResult> {
  const prompt = buildPlanPrompt(question, columns, definitions, previousError);
  const response = await llm.invoke(prompt);
  return parsePlanResponse(String(response.content));
}