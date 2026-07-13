// src/drafting/human-edit.ts
//
// A human edit is a DISTINCT PROVENANCE, and this computes it exactly.
//
// When a reviewer changes a field, that value no longer came from a retrieved
// source or from code - it came from a person. Re-running grounding rubrics on
// it would either fail the legitimate edit (it has no source) or, worse,
// launder it: edit the value, re-score, and the chain says "validated" over
// something typed freehand. Neither is acceptable.
//
// So a human edit is recorded as a field-level delta with its own provenance
// tag, never merged back into the model's rows as if the model produced it. The
// diff IS the provenance record: for every changed field, what it was, what it
// became, and what kind of value it used to be.
//
// Two things get special, louder treatment:
//   - editing a COMPUTED field (e.g. RPN) is a human overriding code. Recorded
//     and flagged - the reviewer is asserting a number the formula disagrees
//     with, and an auditor must see that.
//   - editing a RETRIEVED field detaches it from its source. The prior source
//     ref is recorded so the change from grounded->human is explicit.

import type { SectionSpec } from "./section-schema.js";
import type { ValidatedRow } from "./section-validator.js";

export interface FieldEdit {
  row: number;
  field: string;
  from: unknown;
  to: unknown;
  /** What the value's provenance WAS before the human touched it. */
  priorProvenance: "retrieved" | "generated" | "computed" | "unknown";
  /** True when the human overrode a code-computed field. Auditor red flag. */
  overridesComputed: boolean;
  /** The source the value used to cite, if it was retrieved. */
  detachedSource?: string | null;
}

export interface HumanEditResult {
  /** The new rows after applying edits. Provenance of edited fields is human. */
  editedRows: ValidatedRow[];
  /** Every field-level change, for the custody record. */
  edits: FieldEdit[];
  /** Field name -> provenance, so downstream knows which values are human-authored. */
  provenanceOverrides: Record<string, "human_edited">;
  /** True if any computed field was overridden - forces prominent review note. */
  hasComputedOverride: boolean;
}

function provenanceOf(spec: SectionSpec, field: string): FieldEdit["priorProvenance"] {
  const f = spec.fields.find((x) => x.name === field);
  return f?.provenance ?? "unknown";
}

/**
 * Compute the exact delta between the persisted rows and the reviewer's
 * submitted rows. Pure - no I/O. Applies edits into a NEW row set (the original
 * is never mutated; provenance is append-only, same as the custody chain).
 *
 * `submitted` is the reviewer's version of each row's `values`. Only fields that
 * differ are recorded; unchanged fields keep their original provenance.
 */
export function computeHumanEdits(
  spec: SectionSpec,
  original: ValidatedRow[],
  submitted: Record<string, unknown>[],
): HumanEditResult {
  const edits: FieldEdit[] = [];
  const editedRows: ValidatedRow[] = [];
  const provenanceOverrides: Record<string, "human_edited"> = {};
  let hasComputedOverride = false;

  original.forEach((origRow, rowIdx) => {
    const sub = submitted[rowIdx] ?? {};
    const newValues: Record<string, unknown> = { ...origRow.values };

    for (const field of spec.fields) {
      if (!(field.name in sub)) continue; // not submitted => unchanged
      const before = origRow.values[field.name];
      const after = sub[field.name];
      if (Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after)) continue;

      const prior = provenanceOf(spec, field.name);
      const overridesComputed = prior === "computed";
      if (overridesComputed) hasComputedOverride = true;

      edits.push({
        row: rowIdx,
        field: field.name,
        from: before,
        to: after,
        priorProvenance: prior,
        overridesComputed,
        detachedSource: prior === "retrieved" ? "(source detached by human edit)" : undefined,
      });

      newValues[field.name] = after;
      provenanceOverrides[field.name] = "human_edited";
    }

    editedRows.push({ values: newValues, gaps: origRow.gaps });
  });

  return { editedRows, edits, provenanceOverrides, hasComputedOverride };
}

/** A human-readable summary of the edits for the custody record and the reviewer. */
export function renderEditSummary(result: HumanEditResult): string {
  if (result.edits.length === 0) return "No field edits; disposition only.";
  const lines = [`${result.edits.length} field edit(s) by reviewer:`];
  for (const e of result.edits) {
    const flag = e.overridesComputed ? "  [OVERRIDES COMPUTED FIELD]" : "";
    lines.push(`  row ${e.row} ${e.field}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)} (was ${e.priorProvenance})${flag}`);
  }
  if (result.hasComputedOverride) {
    lines.push(`WARNING: a code-computed field was overridden by a human. This value no longer follows the formula.`);
  }
  return lines.join("\n");
}