// src/data/blurb.ts
//
// Generate the dual-purpose blurb for an extracted table.
//
// The blurb does two jobs:
//   1. The prose section embeds well, so semantic search finds the table
//      ("what risks are tracked in Project Summit" -> finds this blurb)
//   2. The schema section is the query manual the LLM reads to construct
//      a structured query (table id + valid columns + types)
//
// v1 generates the blurb deterministically from the schema (no LLM call).
// A future enhancement could use the LLM to write a richer prose summary,
// but the deterministic version is reliable and fast, and the prose it
// produces is good enough to embed meaningfully.

import type { ColumnSchema } from "./table-schema.js";

export interface BlurbInput {
  tableId: string;
  displayName: string;
  sourcePath: string;
  sheetName?: string | null;
  tier: string;
  rowCount: number;
  columns: ColumnSchema[];
  /** Tier-2 notes from the workbook's legend sheet that name no single column. */
  tableNotes?: string[];
  /** Canonical project id, e.g. "summit". */
  project?: string | null;
  /** Human-readable project name, e.g. "Project Summit". */
  projectDisplayName?: string | null;
  /** Canonical collection id, e.g. "risk-register". */
  collection?: string | null;
}

/**
 * Describe a column for the planner. Beyond name and type we publish the
 * deterministic semantics we can derive for free:
 *
 *   value_domain  - the complete vocabulary of a low-cardinality column, so
 *                   the planner filters on real values rather than guessing
 *                   ("status is one of Open, Closed, In Progress")
 *   value_range   - observed min/max of an ordered column, so a threshold
 *                   like ">= 15" is meaningful in context
 *   notes         - verbatim from the document's own legend sheet
 *
 * None of this is inferred by a model; all of it comes from the data or from
 * text the customer already wrote.
 */
function describeColumn(col: ColumnSchema): string {
  const nullNote = col.nullable ? ", may be empty" : "";
  const parts: string[] = [
    `  - ${col.sql_name} (${col.type}${nullNote}): from "${col.original}"`,
  ];

  if (col.value_domain && col.value_domain.length > 0) {
    // The complete set - the planner can filter exactly against this.
    parts.push(
      `      one of: ${col.value_domain.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  } else if (col.sample_values.length > 0) {
    // High cardinality: samples only, explicitly not exhaustive.
    parts.push(
      `      e.g. ${col.sample_values.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }

  if (col.value_range) {
    parts.push(`      observed range: ${col.value_range.min} to ${col.value_range.max}`);
  }

  if (col.notes) {
    parts.push(`      note: ${col.notes}`);
  }

  return parts.join("\n");
}

export function generateBlurb(input: BlurbInput): string {
  const { tableId, displayName, sourcePath, sheetName, tier, rowCount, columns } = input;
  const tableNotes = input.tableNotes ?? [];

  const fileName = sourcePath.split("/").pop() ?? sourcePath;
  const sheetPart = sheetName ? ` (sheet: ${sheetName})` : "";

  const lines: string[] = [];

  // --- Prose section (embeds for semantic search) ---
  //
  // The project is stated here as well as carried in the payload. In the prose
  // it is FACTUAL structure (the document says so), so it embeds safely and
  // makes "Summit risks" match this blurb rather than Denali's. In the payload
  // it is what the CODE reads to attribute the answer. Prose for the model's
  // judgement, structure for the code's execution.
  const projectPart = input.projectDisplayName
    ? ` It belongs to ${input.projectDisplayName}.`
    : "";

  lines.push(`[${displayName}]`);
  lines.push("");
  lines.push(
    `This is a data table from ${fileName}${sheetPart}, part of the ${tier} data domain.` +
      projectPart +
      ` It contains ${rowCount} ${rowCount === 1 ? "row" : "rows"} of structured data. ` +
      `The columns are: ${columns.map((c) => c.original).join(", ")}.`,
  );
  lines.push("");

  // --- Schema section (the LLM's query manual) ---
  // Everything below the marker is stripped before the ANSWERING prompt sees
  // this blurb (see stripBlurbSchema in src/agent/prompts.ts). It exists for
  // the query planner alone.
  lines.push(`Structured data available. SQL table id: ${tableId}`);
  lines.push(`Queryable columns:`);
  for (const col of columns) {
    lines.push(describeColumn(col));
  }

  // Tier-2 legend entries that named no single column - relayed verbatim.
  if (tableNotes.length > 0) {
    lines.push("");
    lines.push(`Notes from the document's own metadata/legend:`);
    for (const note of tableNotes) {
      lines.push(`  - ${note}`);
    }
  }

  lines.push("");
  lines.push(
    `For exact values, filters, counts, or aggregations, query the data API ` +
      `against table id ${tableId} using structured query primitives.`,
  );

  return lines.join("\n");
}