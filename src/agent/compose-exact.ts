// src/agent/compose-exact.ts
//
// Deterministic answer composition for exact-data questions — the short-circuit
// that keeps the LLM out of the loop when the SQL researcher already has the
// answer (docs/00-philosophy.md: deterministic where possible).
//
// When a question is quantitative ("how many", "number of", "total") and every
// SQL result is a scalar aggregate (a single Count/Sum/Avg/Min/Max), the number
// IS the answer. Composing it needs no model:
//
//   - one result           -> "There are 5 matching records in the "Risk Register"."
//   - several results       -> a per-source breakdown plus, for additive
//     (cross-reference)        aggregates, a combined total. This is how a
//                              cross-referencing question is answered — "how many
//                              open items in the Risk Register AND the Issues List
//                              that are High or above" becomes one filtered count
//                              per table (the planner's job) which are then summed
//                              here, transparently, with each source shown.
//
// Returns null when it cannot conclusively answer — no SQL results, a
// non-quantitative question, or a result that is a list of rows rather than a
// scalar. The caller then falls back to the LLM answer path (draft + reconcile),
// which synthesises prose from the vector context.
//
// Pure and LLM-free, so a count answer is deterministic and unit-testable.

import type { RetrievedChunk } from "../queries.js";
import type { SqlResult } from "./state.js";

const AGG_RE = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;

type AggLabel = "Count" | "Sum" | "Average" | "Minimum" | "Maximum";

function aggregateLabel(sql: string): AggLabel | null {
  const m = sql.match(AGG_RE);
  if (!m) return null;
  switch (m[1]!.toUpperCase()) {
    case "COUNT": return "Count";
    case "SUM": return "Sum";
    case "AVG": return "Average";
    case "MIN": return "Minimum";
    case "MAX": return "Maximum";
    default: return null;
  }
}

/**
 * A quantitative question is one the exact data can answer on its own — "how
 * many", "number of", "total". A question that ALSO asks to enumerate or explain
 * ("...and what are they", "which ones", "describe", "why") needs prose synthesis
 * and must NOT short-circuit. Kept clear of the bare word "list" so a table named
 * "Issues List" is not mistaken for a request to enumerate.
 */
export function isQuantitativeQuestion(question: string): boolean {
  const s = question.toLowerCase();
  const quantitative = /\b(how many|how much|number of|count of|count the|total number of|total count)\b/.test(s);
  // Note: bare "what is" is deliberately NOT a qualitative cue — "what is the
  // number of open risks" is a count. The quantitative test gates first, so a
  // descriptive "what is the highest risk" simply lacks a quantitative cue and
  // never reaches the short-circuit anyway.
  const qualitative =
    /\b(what (?:are|kind|type|were)|which (?:are|ones|of)|name (?:them|the|all)|describe|explain|elaborate|summar|why|tell me about|give (?:me )?(?:the )?details|list (?:them|all|out|the))\b/.test(
      s,
    );
  return quantitative && !qualitative;
}

interface Scalar {
  value: number;
  label: AggLabel;
  displayName: string;
  /** A ready-to-print "[Source: …]" citation. */
  citation: string;
}

/** Map a tableId to its source-file citation, from the retrieved table blurbs. */
function sourceLookup(chunksByTier: Record<string, RetrievedChunk[]> | undefined) {
  const byTable = new Map<string, string>();
  const tiers: RetrievedChunk[][] = chunksByTier ? Object.values(chunksByTier) : [];
  for (const chunks of tiers) {
    for (const c of chunks) {
      // table_id rides in via RetrievedChunk's `[key: string]: unknown` index
      // signature, so it reads as unknown — narrow it before use.
      const id = typeof c.table_id === "string" ? c.table_id : undefined;
      const path = c.source_path;
      if (id && path && !byTable.has(id)) byTable.set(id, path);
    }
  }
  return (tableId: string, displayName: string): string => {
    const path = byTable.get(tableId);
    return path ? `[Source: ${path}]` : `[Source: ${displayName}]`;
  };
}

/** A SQL result is a scalar aggregate iff it is one row, one numeric column, and
 *  the executed SQL used an aggregate function. Otherwise it is not conclusive. */
function asScalar(r: SqlResult, cite: (id: string, name: string) => string): Scalar | null {
  const label = aggregateLabel(r.executedSql);
  if (!label) return null;
  if (r.rows.length !== 1) return null;
  const keys = Object.keys(r.rows[0]!);
  if (keys.length !== 1) return null;
  const raw = r.rows[0]![keys[0]!];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  return { value, label, displayName: r.displayName, citation: cite(r.tableId, r.displayName) };
}

function phrase(s: Scalar): string {
  return s.label === "Count" ? `${s.value} matching records` : `${s.label.toLowerCase()} ${s.value}`;
}

/**
 * Compose a deterministic answer from exact SQL data, or return null to defer to
 * the LLM answer path.
 */
export function composeExactAnswer(
  question: string,
  sqlResults: Record<string, SqlResult> | undefined,
  chunksByTier: Record<string, RetrievedChunk[]> | undefined,
): string | null {
  const results = Object.values(sqlResults ?? {});
  if (results.length === 0) return null;
  if (!isQuantitativeQuestion(question)) return null;

  const cite = sourceLookup(chunksByTier);
  const scalars: (Scalar | null)[] = results.map((r) => asScalar(r, cite));
  if (scalars.some((s) => s === null)) return null; // not every result is conclusive
  const list = scalars as Scalar[];

  // --- Single exact answer ---
  if (list.length === 1) {
    const s = list[0]!;
    const body =
      s.label === "Count"
        ? `There are ${s.value} matching records in the "${s.displayName}".`
        : `The ${s.label.toLowerCase()} for "${s.displayName}" is ${s.value}.`;
    return `${body}\n\nCitation: ${s.citation}`;
  }

  // --- Cross-reference: a per-source breakdown, plus a combined total when the
  //     aggregates are additive and homogeneous (all Count, or all Sum). ---
  const lines = list.map((s) => `- "${s.displayName}" — ${phrase(s)} ${s.citation}`);
  let out = `By source:\n${lines.join("\n")}`;

  const labels = new Set(list.map((s) => s.label));
  if (labels.size === 1 && (labels.has("Count") || labels.has("Sum"))) {
    const total = list.reduce((sum, s) => sum + s.value, 0);
    const unit = list[0]!.label === "Count" ? "matching records" : list[0]!.label.toLowerCase();
    out += `\n\nCombined total: ${total} ${unit} across ${list.length} sources.`;
  }
  return out;
}
