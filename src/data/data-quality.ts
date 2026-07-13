// src/data/data-quality.ts
//
// Deterministic data-quality checks run at ingestion. No LLM, no config.
//
// Why this exists: retrieval engineering cannot fix bad source data. If a
// risk register contains the same Risk ID twice, COUNT(*) over-counts and
// every "how many open risks" answer is silently wrong - in a controlled
// document. The system cannot repair that, but it can REFUSE TO BE SILENT
// about it. These checks turn a hidden corruption into a warning the
// customer can act on.
//
// Findings are warnings, never errors: ingestion proceeds. Blocking a QMS
// ingest because a spreadsheet has a duplicate row would be worse than
// ingesting it with a flag.

import type { ColumnSchema } from "./table-schema.js";

export interface DataQualityFinding {
  kind: "duplicate_identifier" | "empty_column";
  column: string;
  detail: string;
}

// Columns whose names suggest they are identifiers - values expected unique.
const IDENTIFIER_NAME_RE = /(^|_)(id|no|num|number|code|ref|key)$/i;

// Columns that are never identifiers however unique they look. Dates are the
// trap: a 16-row register with 15 distinct dates scores 0.94 on uniqueness,
// but two risks raised on the same day is normal, not a defect.
const NEVER_IDENTIFIER_NAME_RE = /(date|time|timestamp|_at$|day|month|year)/i;

// A column with no identifier-ish name still behaves like a key if virtually
// every value is distinct. Held deliberately high: named identifiers are
// caught by IDENTIFIER_NAME_RE, so this only needs to catch the unnamed ones
// (serials, SKUs) without dragging in near-unique free text.
const IDENTIFIER_UNIQUENESS_RATIO = 0.95;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

/**
 * Does this column look like an identifier? Either by name (risk_id, doc_no)
 * or by behaviour (virtually every value distinct). Date-like columns and
 * non-discrete types are excluded outright.
 */
function looksLikeIdentifier(col: ColumnSchema, values: unknown[]): boolean {
  if (NEVER_IDENTIFIER_NAME_RE.test(col.sql_name)) return false;
  if (col.type === "date" || col.type === "numeric") return false;

  if (IDENTIFIER_NAME_RE.test(col.sql_name)) return true;

  const present = values.filter((v) => !isEmpty(v));
  if (present.length < 4) return false; // too few rows to judge
  const distinct = new Set(present.map((v) => String(v).trim())).size;
  return distinct / present.length >= IDENTIFIER_UNIQUENESS_RATIO;
}

/**
 * Inspect a table for duplicate identifier values and wholly empty columns.
 * `rows` is row-major, aligned to `columns` by index.
 */
export function checkDataQuality(
  columns: ColumnSchema[],
  rows: unknown[][],
): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];

  columns.forEach((col, colIdx) => {
    const values = rows.map((r) => r[colIdx]);
    const present = values.filter((v) => !isEmpty(v));

    if (present.length === 0) {
      findings.push({
        kind: "empty_column",
        column: col.sql_name,
        detail: `Column "${col.original}" has no values in ${rows.length} rows.`,
      });
      return;
    }

    if (!looksLikeIdentifier(col, values)) return;

    // Count how often each value repeats.
    const counts = new Map<string, number>();
    for (const v of present) {
      const k = String(v).trim();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    if (repeated.length === 0) return;

    const shown = repeated
      .slice(0, 5)
      .map(([v, n]) => `${JSON.stringify(v)} x${n}`)
      .join(", ");
    const more = repeated.length > 5 ? `, and ${repeated.length - 5} more` : "";

    findings.push({
      kind: "duplicate_identifier",
      column: col.sql_name,
      detail:
        `Column "${col.original}" looks like an identifier but has ` +
        `${repeated.length} duplicated value(s): ${shown}${more}. ` +
        `Counts and per-identifier filters over this table may be wrong.`,
    });
  });

  return findings;
}