// src/data/query-builder.ts
//
// Turn a validated structured-query request into a parameterized SQL
// statement. The LLM (or any API caller) produces the JSON structure;
// this builder produces SQL. The caller never writes SQL.
//
// Safety properties:
//   - Column names are whitelisted against the table's registered schema.
//     A column not in the schema is rejected before any SQL is built.
//   - Values are ALWAYS bound as parameters ($1, $2, ...), never
//     concatenated. SQL injection via values is structurally impossible.
//   - The physical table name comes from the registry (derived from a UUID),
//     validated by quoteIdent, never from user input.
//   - LIMIT is capped server-side regardless of what the caller requests.
//
// This is pure logic - it takes a schema and a request, returns { sql, params }.
// Execution happens in the data route against the read-only pool.

import type { ColumnSchema, InferredType } from "./table-schema.js";
import { quoteIdent } from "./table-loader.js";

export const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export type FilterOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "in" | "like" | "ilike" | "is_null" | "is_not_null";

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterGroup {
  op: "and" | "or";
  conditions: FilterCondition[];
}

export interface QueryRequest {
  select?: string[];
  filter?: FilterGroup;
  aggregate?: { fn: AggregateFn; column?: string };
  group_by?: string[];
  order_by?: { column: string; dir?: "asc" | "desc" }[];
  limit?: number;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export class QueryValidationError extends Error {}

/** Build a parameterized SELECT from a validated request against a schema. */
export function buildQuery(
  physicalTable: string,
  columns: ColumnSchema[],
  req: QueryRequest,
): BuiltQuery {
  const schemaByName = new Map(columns.map((c) => [c.sql_name, c]));
  const params: unknown[] = [];

  const requireColumn = (name: string): ColumnSchema => {
    const col = schemaByName.get(name);
    if (!col) {
      // Common LLM mistake: putting an aggregate expression where a column
      // name belongs. Give a directive hint so the retry can self-correct.
      if (/\b(count|sum|avg|min|max)\s*\(/i.test(name) || name === "count") {
        throw new QueryValidationError(
          `'${name}' is not a column. To aggregate, use the "aggregate" field instead, e.g. {"aggregate":{"fn":"count"}}. Do not put functions in "select" or "group_by". Valid columns: ${columns.map((c) => c.sql_name).join(", ")}`,
        );
      }
      throw new QueryValidationError(
        `Unknown column '${name}'. Valid columns: ${columns.map((c) => c.sql_name).join(", ")}`,
      );
    }
    return col;
  };

  // ---- SELECT clause ----
  let selectClause: string;

  if (req.aggregate) {
    const { fn, column } = req.aggregate;
    if (fn === "count" && !column) {
      selectClause = "COUNT(*) AS result";
    } else {
      if (!column) {
        throw new QueryValidationError(`Aggregate '${fn}' requires a column`);
      }
      const col = requireColumn(column);
      assertNumericForAggregate(fn, col);
      selectClause = `${fn.toUpperCase()}(${quoteIdent(col.sql_name)}) AS result`;
    }

    // If grouping, include the group columns in the select
    if (req.group_by && req.group_by.length > 0) {
      const groupCols = req.group_by.map((g) => quoteIdent(requireColumn(g).sql_name));
      selectClause = `${groupCols.join(", ")}, ${selectClause}`;
    }
  } else if (req.select && req.select.length > 0) {
    const cols = req.select.map((c) => quoteIdent(requireColumn(c).sql_name));
    selectClause = cols.join(", ");
  } else {
    selectClause = "*";
  }

  // ---- WHERE clause ----
  let whereClause = "";
  if (req.filter && req.filter.conditions.length > 0) {
    const joiner = req.filter.op === "or" ? " OR " : " AND ";
    const parts = req.filter.conditions.map((cond) => {
      const col = requireColumn(cond.column);
      return buildCondition(col, cond, params);
    });
    whereClause = ` WHERE ${parts.join(joiner)}`;
  }

  // ---- GROUP BY ----
  let groupByClause = "";
  if (req.group_by && req.group_by.length > 0) {
    const cols = req.group_by.map((g) => quoteIdent(requireColumn(g).sql_name));
    groupByClause = ` GROUP BY ${cols.join(", ")}`;
  }

  // ---- ORDER BY ----
  let orderByClause = "";
  if (req.order_by && req.order_by.length > 0) {
    const parts = req.order_by.map((o) => {
      const col = requireColumn(o.column);
      const dir = o.dir === "desc" ? "DESC" : "ASC";
      return `${quoteIdent(col.sql_name)} ${dir}`;
    });
    orderByClause = ` ORDER BY ${parts.join(", ")}`;
  }

  // ---- LIMIT (capped server-side) ----
  const requestedLimit = req.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
  // Aggregates without grouping return a single row - no limit needed,
  // but applying one is harmless.
  const limitClause = ` LIMIT ${limit}`;

  const sql =
    `SELECT ${selectClause} FROM ${quoteIdent(physicalTable)}` +
    whereClause +
    groupByClause +
    orderByClause +
    limitClause;

  return { sql, params };
}

function buildCondition(
  col: ColumnSchema,
  cond: FilterCondition,
  params: unknown[],
): string {
  const ident = quoteIdent(col.sql_name);

  switch (cond.op) {
    case "is_null":
      return `${ident} IS NULL`;
    case "is_not_null":
      return `${ident} IS NOT NULL`;
    case "in": {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw new QueryValidationError(`'in' requires a non-empty array value`);
      }
      const placeholders = cond.value.map((v) => {
        params.push(coerceFilterValue(v, col.type));
        return `$${params.length}`;
      });
      return `${ident} IN (${placeholders.join(", ")})`;
    }
    case "like":
    case "ilike": {
      if (typeof cond.value !== "string") {
        throw new QueryValidationError(`'${cond.op}' requires a string value`);
      }
      params.push(cond.value);
      const opSql = cond.op === "ilike" ? "ILIKE" : "LIKE";
      return `${ident} ${opSql} $${params.length}`;
    }
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (cond.value === undefined) {
        throw new QueryValidationError(`'${cond.op}' requires a value`);
      }
      params.push(coerceFilterValue(cond.value, col.type));
      const opSql = {
        eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=",
      }[cond.op];
      return `${ident} ${opSql} $${params.length}`;
    }
    default:
      throw new QueryValidationError(`Unsupported filter op '${cond.op}'`);
  }
}

function coerceFilterValue(value: unknown, type: InferredType): unknown {
  // Light coercion so a filter value matches the column type. We don't
  // hard-reject type mismatches (Postgres will), but we do convert obvious
  // cases so "3" filters correctly against an integer column.
  if (value === null) return null;
  const s = String(value).trim();
  switch (type) {
    case "integer": {
      const n = parseInt(s, 10);
      if (Number.isNaN(n)) {
        throw new QueryValidationError(`Value '${s}' is not valid for an integer column`);
      }
      return n;
    }
    case "numeric": {
      const n = parseFloat(s);
      if (Number.isNaN(n)) {
        throw new QueryValidationError(`Value '${s}' is not valid for a numeric column`);
      }
      return n;
    }
    case "boolean":
      return ["true", "yes", "y", "1"].includes(s.toLowerCase());
    default:
      return s;
  }
}

function assertNumericForAggregate(fn: AggregateFn, col: ColumnSchema): void {
  if (fn === "count") return; // count works on any column
  if (col.type !== "integer" && col.type !== "numeric") {
    throw new QueryValidationError(
      `Aggregate '${fn}' requires a numeric column, but '${col.sql_name}' is ${col.type}`,
    );
  }
}