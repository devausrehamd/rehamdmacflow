// src/drafting/section-validator.ts
//
// The deterministic gate between the seamstress and the finished garment.
//
// The LLM produces a section as structured data. Before that data is trusted,
// this validator checks it against the DECLARED schema, field by field, row by
// row. It is pure: no LLM, no I/O. Everything the model did is checked by code.
//
// Five things it does, none of them a judgement call:
//
//   1. REQUIRED fields present. A missing required field is not an error to
//      throw - it is a GAP to record. The row is marked, the value becomes
//      insufficient_evidence, and a must-pass criterion will later fail. A gap
//      is evidence, not a silent hole.
//
//   2. TYPE and DOMAIN conformance. An enum value outside the SOP's scale, an
//      integer outside the rating bounds, a malformed identifier - rejected.
//
//   3. COMPUTED fields RECOMPUTED. The model's value is discarded and the
//      formula evaluated over the row. If the model's proposed value disagrees,
//      that is recorded (it means the model tried to do arithmetic it should
//      not have). Code owns computed fields.
//
//   4. RETRIEVED fields carry a source. A retrieved field with no grounding
//      reference is a FABRICATION - the model invented a value it was supposed
//      to transcribe. Flagged.
//
//   5. REFERENCE fields validated by SET MEMBERSHIP against the upstream
//      export. A cross-reference to RISK-014 is valid iff RISK-014 is in the
//      approved risk register's exported ids. A fabricated cross-reference
//      cannot survive this.

import type { SectionSpec, FieldSpec } from "./section-schema.js";

export const INSUFFICIENT_EVIDENCE = "insufficient_evidence" as const;

export interface FieldFinding {
  row: number; // -1 for a single-cardinality section
  field: string;
  kind:
    | "missing_required"
    | "type_error"
    | "domain_error"
    | "range_error"
    | "computed_mismatch"
    | "ungrounded_retrieved"
    | "reference_not_found";
  detail: string;
}

export interface ValidatedRow {
  values: Record<string, unknown>;
  /** Fields that came up empty and were marked, not invented. */
  gaps: string[];
}

export interface SectionValidation {
  sectionId: string;
  rows: ValidatedRow[];
  findings: FieldFinding[];
  /** True when a required field was missing anywhere - forces human review. */
  hasGaps: boolean;
  /** True when something was actively wrong (bad type, fabricated reference). */
  hasErrors: boolean;
}

/**
 * A produced field value, as the model emitted it. `value` is the content;
 * `sourceRef` is the retrieval reference the model claims grounds it (a chunk
 * id or an upstream row id). Retrieved fields without a sourceRef are
 * fabrications.
 */
export interface ProducedValue {
  value: unknown;
  sourceRef?: string | null;
}

export type ProducedRow = Record<string, ProducedValue>;

/** Restricted arithmetic evaluator for computed fields. Only * + - over field values. */
function evalFormula(formula: string, row: Record<string, number>): number | null {
  // Tokenise into numbers, field names, and the three operators. Anything else
  // is rejected - this must never become a scripting surface.
  const tokens = formula.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(\.\d+)?|[*+\-]/g);
  if (!tokens || tokens.join("") !== formula.replace(/\s+/g, "")) return null;

  // Resolve field names to numbers.
  const resolved: (number | string)[] = tokens.map((t) => {
    if (t === "*" || t === "+" || t === "-") return t;
    if (/^\d/.test(t)) return Number(t);
    const v = row[t];
    return typeof v === "number" ? v : NaN;
  });
  if (resolved.some((r) => typeof r === "number" && Number.isNaN(r))) return null;

  // Left-to-right with * before +/-. Small and explicit; no eval, no Function.
  const nums: number[] = [];
  const ops: string[] = [];
  for (const tok of resolved) {
    if (typeof tok === "string") {
      if (tok === "*") {
        const next = resolved[resolved.indexOf(tok) + 1];
        void next; // handled below by two-pass
      }
      ops.push(tok);
    } else {
      nums.push(tok);
    }
  }
  // Two-pass: fold * first, then + and -.
  const values = [nums[0]];
  const pendingOps: string[] = [];
  let ni = 1;
  for (const op of ops) {
    if (op === "*") {
      values[values.length - 1] = values[values.length - 1] * nums[ni++];
    } else {
      pendingOps.push(op);
      values.push(nums[ni++]);
    }
  }
  let acc = values[0];
  for (let i = 0; i < pendingOps.length; i++) {
    acc = pendingOps[i] === "+" ? acc + values[i + 1] : acc - values[i + 1];
  }
  return acc;
}

function checkScalar(field: FieldSpec, value: unknown): FieldFinding["kind"] | null {
  switch (field.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "type_error";
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))
        return "range_error";
      return null;
    case "number":
      if (typeof value !== "number") return "type_error";
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))
        return "range_error";
      return null;
    case "enum":
      if (!field.domain?.includes(value as string | number)) return "domain_error";
      return null;
    case "identifier":
    case "string":
    case "reference":
      if (typeof value !== "string" || value.trim() === "") return "type_error";
      return null;
    default:
      return null;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Validate a produced section against its declared schema.
 *
 * `referenceSets` maps a field's referenceExport (e.g. "risk-register.riskItems.id")
 * to the set of valid values, so reference fields are checked by membership.
 *
 * `validSourceRefs` is the set of source tokens that were actually offered to
 * the model (chunk ids, row ids, SOP section ids). A retrieved field is grounded
 * only if its sourceRef is a MEMBER of this set - not merely non-empty. Without
 * it, a model could echo any string and pass; with it, grounding is real. When
 * the set is empty (not supplied), the check falls back to "non-empty".
 */
export function validateSection(
  spec: SectionSpec,
  producedRows: ProducedRow[],
  referenceSets: Record<string, Set<string>> = {},
  validSourceRefs: Set<string> = new Set(),
): SectionValidation {
  const findings: FieldFinding[] = [];
  const outRows: ValidatedRow[] = [];

  producedRows.forEach((produced, rowIdx) => {
    const rowNum = spec.cardinality === "single" ? -1 : rowIdx;
    const values: Record<string, unknown> = {};
    const gaps: string[] = [];

    // Numeric view for formula evaluation, built as we go.
    const numeric: Record<string, number> = {};

    for (const field of spec.fields) {
      const cell = produced[field.name];
      const raw = cell?.value;

      // --- Gap: required field absent -> mark, never invent ---
      if (isEmpty(raw) && field.provenance !== "computed") {
        if (field.required) {
          values[field.name] = INSUFFICIENT_EVIDENCE;
          gaps.push(field.name);
          findings.push({
            row: rowNum,
            field: field.name,
            kind: "missing_required",
            detail: `Required ${field.provenance} field '${field.name}' had no value. Marked insufficient_evidence.`,
          });
        } else {
          values[field.name] = null;
        }
        continue;
      }

      // --- Computed: discard the model's value, recompute from the row ---
      if (field.provenance === "computed") {
        const computed = evalFormula(field.formula!, numeric);
        if (computed === null) {
          values[field.name] = INSUFFICIENT_EVIDENCE;
          gaps.push(field.name);
          findings.push({
            row: rowNum,
            field: field.name,
            kind: "missing_required",
            detail: `Computed field '${field.name}' could not be evaluated (a dependency was missing).`,
          });
        } else {
          values[field.name] = computed;
          numeric[field.name] = computed;
          // If the model also proposed a value and it disagrees, record it -
          // the model tried to do arithmetic it should not have.
          if (!isEmpty(raw) && typeof raw === "number" && raw !== computed) {
            findings.push({
              row: rowNum,
              field: field.name,
              kind: "computed_mismatch",
              detail: `Model proposed ${raw} for computed field '${field.name}'; code computed ${computed}. Using code.`,
            });
          }
        }
        continue;
      }

      // --- Type / domain / range ---
      const typeErr = checkScalar(field, raw);
      if (typeErr) {
        findings.push({
          row: rowNum,
          field: field.name,
          kind: typeErr,
          detail: `Field '${field.name}' value ${JSON.stringify(raw)} failed ${typeErr}.`,
        });
        values[field.name] = raw; // keep it visible for the reviewer
      } else {
        values[field.name] = raw;
        if (typeof raw === "number") numeric[field.name] = raw;
      }

      // --- Retrieved fields must carry a REAL source ---
      // Grounded means the sourceRef is one that was actually offered to the
      // model. Membership, not mere presence - a value citing a source that was
      // never in the context is as fabricated as one citing nothing.
      if (field.provenance === "retrieved" && !isEmpty(values[field.name]) && values[field.name] !== INSUFFICIENT_EVIDENCE) {
        const ref = cell?.sourceRef;
        const grounded = !isEmpty(ref) &&
          (validSourceRefs.size === 0 || validSourceRefs.has(String(ref)));
        if (!grounded) {
          findings.push({
            row: rowNum,
            field: field.name,
            kind: "ungrounded_retrieved",
            detail: isEmpty(ref)
              ? `Retrieved field '${field.name}' has no source reference. A retrieved value with no source is a fabrication.`
              : `Retrieved field '${field.name}' cites source '${String(ref)}', which was not in the offered context. Grounding must be real.`,
          });
        }
      }

      // --- Reference fields validated by set membership ---
      if (field.type === "reference" && field.referenceExport) {
        const set = referenceSets[field.referenceExport];
        if (!set || !set.has(String(raw))) {
          findings.push({
            row: rowNum,
            field: field.name,
            kind: "reference_not_found",
            detail: `Reference '${field.name}' = ${JSON.stringify(raw)} is not in ${field.referenceExport}. Cross-reference cannot be a fabrication.`,
          });
        }
      }
    }

    outRows.push({ values, gaps });
  });

  const hasGaps = outRows.some((r) => r.gaps.length > 0);
  const hasErrors = findings.some((f) => f.kind !== "missing_required");

  return { sectionId: spec.id, rows: outRows, findings, hasGaps, hasErrors };
}

/** The coverage statement a section carries into the document and the rubric. */
export function renderSectionCoverage(v: SectionValidation): string {
  if (!v.hasGaps && !v.hasErrors) {
    return `Section '${v.sectionId}': complete. ${v.rows.length} row(s), no gaps.`;
  }
  const lines = [`Section '${v.sectionId}': INCOMPLETE.`];
  const gapCount = v.rows.reduce((n, r) => n + r.gaps.length, 0);
  if (gapCount > 0) lines.push(`  ${gapCount} field(s) marked insufficient_evidence.`);
  const errs = v.findings.filter((f) => f.kind !== "missing_required");
  if (errs.length > 0) lines.push(`  ${errs.length} field(s) failed validation.`);
  lines.push(`  Human review required before approval.`);
  return lines.join("\n");
}