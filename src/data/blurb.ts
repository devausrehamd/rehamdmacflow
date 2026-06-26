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
}

export function generateBlurb(input: BlurbInput): string {
  const { tableId, displayName, sourcePath, sheetName, tier, rowCount, columns } = input;

  const fileName = sourcePath.split("/").pop() ?? sourcePath;
  const sheetPart = sheetName ? ` (sheet: ${sheetName})` : "";

  const lines: string[] = [];

  // --- Prose section (embeds for semantic search) ---
  lines.push(`[${displayName}]`);
  lines.push("");
  lines.push(
    `This is a data table from ${fileName}${sheetPart}, part of the ${tier} data domain. ` +
      `It contains ${rowCount} ${rowCount === 1 ? "row" : "rows"} of structured data. ` +
      `The columns are: ${columns.map((c) => c.original).join(", ")}.`,
  );
  lines.push("");

  // --- Schema section (the LLM's query manual) ---
  lines.push(`Structured data available. SQL table id: ${tableId}`);
  lines.push(`Queryable columns:`);
  for (const col of columns) {
    const nullNote = col.nullable ? ", may be empty" : "";
    const samplePart =
      col.sample_values.length > 0
        ? ` e.g. ${col.sample_values.map((v) => JSON.stringify(v)).join(", ")}`
        : "";
    lines.push(`  - ${col.sql_name} (${col.type}${nullNote}): from "${col.original}"${samplePart}`);
  }
  lines.push("");
  lines.push(
    `For exact values, filters, counts, or aggregations, query the data API ` +
      `against table id ${tableId} using structured query primitives.`,
  );

  return lines.join("\n");
}