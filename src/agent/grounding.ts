// src/agent/grounding.ts
//
// The grounding gate (increment 1 of the deterministic/LLM boundary contract).
//
// The planner decodes a natural-language question into a structured query. That
// decode is a guess until it is checked against the schema. A filter whose value
// falls OUTSIDE a column's known domain is not a "0 results" answer — it is a
// DECODE FAILURE: a term in the question ("Critical") that could not be mapped to
// a defined field. Executing it returns a confident, misleading count.
//
// So before execution, every filter value is validated against the column it
// targets:
//   - an equality against an enumerable column must name a value in its domain
//     ("likelihood = 5" fails: likelihood only takes 1-4);
//   - a comparison against a ranged column must be satisfiable ("likelihood >= 5"
//     fails the same way; "score >= 16" passes because score reaches 20).
// An in-domain filter that simply matches nothing ("status = 'Open'" when all are
// closed) is GROUNDED — a real, if empty, answer. The gate only flags the
// ungrounded.
//
// When a query is ungrounded the system CALLS IT OUT — composeGroundingNotice
// states which condition could not be mapped, lists the fields that CAN be
// queried, and asks for a grounded rephrase — instead of guessing. All pure and
// LLM-free.

import type { QueryRequest, FilterCondition, FilterOp } from "../data/query-builder.js";
import type { ColumnSchema } from "../data/table-schema.js";

/** One filter condition that could not be grounded in its column. */
export interface UngroundedCondition {
  /** Human-readable, e.g. `likelihood = 5`. */
  conditionText: string;
  /** Why it cannot be grounded, e.g. `likelihood only takes values 1–4`. */
  reason: string;
}

export interface GroundingResult {
  grounded: boolean;
  ungrounded: UngroundedCondition[];
}

/** An interpretive term the planner declared it could not map (increment 3). */
export interface UnresolvedTerm {
  term: string;
  reason: string;
}

/** A grounding problem for one table, ready to render in a call-it-out answer.
 *  Either an impossible filter (`ungrounded`, increment 1) or an interpretive
 *  term the decoder abstained on (`unresolvedTerms`, increment 3), or both. */
export interface GroundingIssue {
  tableId: string;
  displayName: string;
  ungrounded: UngroundedCondition[];
  unresolvedTerms?: UnresolvedTerm[];
  /** The fields the caller CAN query, with their domains/ranges. */
  availableFields: string[];
  /** The interpretive terms the QMS DOES define for this table, to suggest. */
  definedTerms?: string[];
}

const OP_SYMBOL: Partial<Record<FilterOp, string>> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in", like: "like", ilike: "like",
};

function label(col: ColumnSchema): string {
  return (col.original || col.sql_name).replace(/\s+/g, " ").trim();
}

function conditionText(col: ColumnSchema, cond: FilterCondition): string {
  const sym = OP_SYMBOL[cond.op] ?? cond.op;
  const val = Array.isArray(cond.value) ? cond.value.join(", ") : String(cond.value);
  return `${label(col)} ${sym} ${val}`;
}

/** Coerce a value to the column's type for domain comparison. Text compares
 *  case-insensitively so "open" still grounds against a domain of "Open". */
function coerce(value: unknown, type: ColumnSchema["type"]): string | number | boolean {
  if (type === "integer" || type === "numeric") return Number(value);
  if (type === "boolean") return typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
  return String(value).trim().toLowerCase();
}

function inDomain(value: unknown, col: ColumnSchema): boolean {
  if (!col.value_domain || col.value_domain.length === 0) return true; // free text / high card — cannot disprove
  const v = coerce(value, col.type);
  return col.value_domain.some((d) => coerce(d, col.type) === v);
}

/** Is a numeric comparison satisfiable given the column's observed range? Only
 *  applied to numeric columns (dates are left to execution). */
function comparisonSatisfiable(op: FilterOp, value: unknown, col: ColumnSchema): boolean {
  if (!col.value_range) return true;
  if (col.type !== "integer" && col.type !== "numeric") return true;
  const v = Number(value);
  const min = Number(col.value_range.min);
  const max = Number(col.value_range.max);
  if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max)) return true;
  switch (op) {
    case "gte": return v <= max;
    case "gt": return v < max;
    case "lte": return v >= min;
    case "lt": return v > min;
    default: return true;
  }
}

function reasonFor(col: ColumnSchema, op: FilterOp): string {
  const name = label(col);
  if (col.value_range && (col.type === "integer" || col.type === "numeric")) {
    return `${name} only takes values ${col.value_range.min}–${col.value_range.max}`;
  }
  if (col.value_domain && col.value_domain.length > 0) {
    return `${name} is one of: ${col.value_domain.join(", ")}`;
  }
  return `${name} has no value matching that condition`;
}

/**
 * Check a planned query against the table's schema. Returns the conditions whose
 * values fall outside their column's domain/range — the decode failures.
 */
export function checkGrounding(req: QueryRequest, columns: ColumnSchema[]): GroundingResult {
  const byName = new Map(columns.map((c) => [c.sql_name, c]));
  const ungrounded: UngroundedCondition[] = [];

  for (const cond of req.filter?.conditions ?? []) {
    const col = byName.get(cond.column);
    if (!col) continue; // unknown column is rejected by the query builder, not here

    let ok = true;
    if ((cond.op === "eq" || cond.op === "neq") && col.value_domain) {
      ok = inDomain(cond.value, col);
    } else if (cond.op === "in" && Array.isArray(cond.value) && col.value_domain) {
      ok = cond.value.every((v) => inDomain(v, col));
    } else if (cond.op === "gt" || cond.op === "gte" || cond.op === "lt" || cond.op === "lte") {
      ok = comparisonSatisfiable(cond.op, cond.value, col);
    }

    if (!ok) {
      ungrounded.push({ conditionText: conditionText(col, cond), reason: reasonFor(col, cond.op) });
    }
  }

  return { grounded: ungrounded.length === 0, ungrounded };
}

/** A readable list of the fields a caller can query, with their domains/ranges. */
export function fieldSummary(columns: ColumnSchema[]): string[] {
  return columns.map((c) => {
    const name = label(c);
    if (c.value_domain && c.value_domain.length > 0) {
      if (c.type === "integer" || c.type === "numeric") {
        const nums = c.value_domain.map(Number).filter(Number.isFinite);
        if (nums.length > 0) return `${name}: ${Math.min(...nums)}–${Math.max(...nums)}`;
      }
      const shown = c.value_domain.slice(0, 8).join(", ");
      return `${name}: ${shown}${c.value_domain.length > 8 ? ", …" : ""}`;
    }
    if (c.value_range && (c.type === "integer" || c.type === "numeric" || c.type === "date")) {
      return `${name}: ${c.value_range.min}–${c.value_range.max}`;
    }
    return `${name}: free text`;
  });
}

/**
 * Compose the deterministic call-it-out answer: what could not be mapped, the
 * fields that can be queried, and how to rephrase. Never guesses a value.
 */
export function composeGroundingNotice(issues: GroundingIssue[]): string {
  const out: string[] = [
    "I couldn't map part of your question to a defined field or term, so I won't guess a number.",
  ];
  for (const issue of issues) {
    out.push("");
    for (const u of issue.ungrounded) {
      out.push(`- "${u.conditionText}" doesn't match anything in the "${issue.displayName}" — ${u.reason}.`);
    }
    for (const t of issue.unresolvedTerms ?? []) {
      out.push(`- "${t.term}" is a judgment term the QMS hasn't defined for the "${issue.displayName}" — ${t.reason}.`);
    }
    if (issue.definedTerms && issue.definedTerms.length > 0) {
      out.push(`Defined terms you can use here: ${issue.definedTerms.join(", ")}.`);
    }
    out.push("");
    out.push(`Fields you can query in the "${issue.displayName}":`);
    for (const f of issue.availableFields) out.push(`  - ${f}`);
  }
  out.push("");
  out.push(
    'Rephrase using a defined term or field — e.g. a numeric threshold ("score ≥ 16") or an exact value from a listed set ("status is Open") — or define the term in the QMS derivations registry.',
  );
  return out.join("\n");
}
