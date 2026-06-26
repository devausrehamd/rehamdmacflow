// src/data/table-schema.ts
//
// Column normalization and type inference for extracted tables.
// Pure logic, no I/O - fully unit-testable.
//
// Normalization: human header -> valid SQL column name
//   "Likelihood (1-5)" -> "likelihood_1_5"
//   "Date Identified"  -> "date_identified"
//
// Type inference: scan non-empty values, infer the narrowest type that
// fits, fall back to text when ambiguous. Conservative by design - a
// column of part numbers like "0603", "1N4148" stays text because not
// all values parse as numbers, which is correct (misparsing "0603" as
// the integer 603 would be a data-integrity disaster in a BOM).

export type InferredType = "integer" | "numeric" | "date" | "boolean" | "text";

export interface ColumnSchema {
  original: string;
  sql_name: string;
  type: InferredType;
  nullable: boolean;
  sample_values: (string | number | boolean | null)[];
}

const SQL_RESERVED = new Set([
  "select", "from", "where", "table", "column", "order", "group", "by",
  "and", "or", "not", "null", "insert", "update", "delete", "drop", "create",
  "index", "primary", "key", "foreign", "references", "join", "on", "as",
  "user", "default", "check", "unique", "values", "into", "set", "limit",
]);

/**
 * Normalize a human header into a valid SQL column name.
 * Guarantees: lowercase, alphanumeric + underscore only, doesn't start
 * with a digit, isn't a reserved word, non-empty.
 */
export function normalizeColumnName(header: string): string {
  let name = header
    .toLowerCase()
    .trim()
    // Replace any run of non-alphanumeric chars with a single underscore
    .replace(/[^a-z0-9]+/g, "_")
    // Trim leading/trailing underscores
    .replace(/^_+|_+$/g, "");

  if (name.length === 0) {
    name = "col";
  }
  // SQL identifiers can't start with a digit
  if (/^[0-9]/.test(name)) {
    name = `col_${name}`;
  }
  // Avoid reserved words
  if (SQL_RESERVED.has(name)) {
    name = `col_${name}`;
  }
  return name;
}

/**
 * Normalize a full set of headers, deduplicating collisions by appending
 * _2, _3, etc. Returns names in the same order as the input headers.
 */
export function normalizeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const base = normalizeColumnName(h);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

// ---- Type inference ----

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function parsesAsInteger(v: string): boolean {
  return /^-?\d+$/.test(v.trim());
}

function parsesAsNumeric(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v.trim()) || /^-?\.\d+$/.test(v.trim());
}

function parsesAsDate(v: string): boolean {
  const s = v.trim();
  // ISO date or datetime
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
    const d = new Date(s);
    return !Number.isNaN(d.getTime());
  }
  // Common slash formats: YYYY/MM/DD or DD/MM/YYYY-ish
  if (/^\d{1,4}[/]\d{1,2}[/]\d{1,4}$/.test(s)) {
    const d = new Date(s);
    return !Number.isNaN(d.getTime());
  }
  return false;
}

const BOOL_TRUE = new Set(["true", "yes", "y"]);
const BOOL_FALSE = new Set(["false", "no", "n"]);

function parsesAsBoolean(v: string): boolean {
  const s = v.trim().toLowerCase();
  return BOOL_TRUE.has(s) || BOOL_FALSE.has(s);
}

/**
 * Infer the column type from its values. Looks only at non-empty values.
 * Returns the narrowest type all non-empty values satisfy, else "text".
 */
export function inferColumnType(values: unknown[]): InferredType {
  const nonEmpty = values.filter((v) => !isEmpty(v)).map((v) => String(v));

  if (nonEmpty.length === 0) return "text";

  if (nonEmpty.every(parsesAsInteger)) return "integer";
  if (nonEmpty.every(parsesAsNumeric)) return "numeric";
  if (nonEmpty.every(parsesAsDate)) return "date";
  if (nonEmpty.every(parsesAsBoolean)) return "boolean";

  return "text";
}

/**
 * Build the full column schema for a table given its headers and rows.
 * rows is an array of arrays (row-major), aligned to headers by index.
 */
export function buildColumnSchema(
  headers: string[],
  rows: unknown[][],
): ColumnSchema[] {
  const sqlNames = normalizeHeaders(headers);

  return headers.map((header, colIdx) => {
    const columnValues = rows.map((row) => row[colIdx]);
    const type = inferColumnType(columnValues);
    const nullable = columnValues.some(isEmpty);

    // A few representative non-empty sample values for the blurb
    const samples = columnValues
      .filter((v) => !isEmpty(v))
      .slice(0, 3)
      .map((v) => coerceSample(v, type));

    return {
      original: header,
      sql_name: sqlNames[colIdx],
      type,
      nullable,
      sample_values: samples,
    };
  });
}

function coerceSample(
  v: unknown,
  type: InferredType,
): string | number | boolean | null {
  const s = String(v).trim();
  switch (type) {
    case "integer":
      return parseInt(s, 10);
    case "numeric":
      return parseFloat(s);
    case "boolean":
      return BOOL_TRUE.has(s.toLowerCase());
    default:
      return s;
  }
}

/** Map an inferred type to its Postgres column type. */
export function pgTypeFor(type: InferredType): string {
  switch (type) {
    case "integer":
      return "INTEGER";
    case "numeric":
      return "NUMERIC";
    case "date":
      return "DATE";
    case "boolean":
      return "BOOLEAN";
    default:
      return "TEXT";
  }
}

/** Coerce a raw cell value to the form Postgres expects for its column type.
 * Empty values become null. Used by the loader when building INSERT rows. */
export function coerceValueForInsert(v: unknown, type: InferredType): unknown {
  if (isEmpty(v)) return null;
  const s = String(v).trim();
  switch (type) {
    case "integer": {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? null : n;
    }
    case "numeric": {
      const n = parseFloat(s);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return BOOL_TRUE.has(s.toLowerCase());
    case "date":
      return s; // Postgres parses ISO date strings directly
    default:
      return s;
  }
}