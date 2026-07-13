// src/ingestion/table-extract.ts
//
// Extract structured tables from documents for the SQL path.
//
//   xlsx: each sheet that looks like a table -> one ExtractedTableData
//   docx: each <table> element in the HTML -> one ExtractedTableData
//
// "Looks like a table" heuristic (kept deliberately permissive for v1):
//   - at least 2 columns
//   - at least 1 data row beyond the header
//   - header row has mostly non-empty cells
// Sheets/tables that fail the heuristic are skipped for SQL but their
// content still flows into the vector path via the markdown conversion.

import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { basename, extname } from "node:path";
import type { SourceFile, ExtractedTableData } from "./types.js";
import { extractWorkbookLegend, isLegendSheet } from "../data/legend.js";
import { normalizeHeaders } from "../data/table-schema.js";

const MIN_COLUMNS = 2;
const MIN_DATA_ROWS = 1;

/** Decide whether a header + rows pair is "table-like" enough for SQL. */
function isTableLike(headers: string[], rows: unknown[][]): boolean {
  if (headers.length < MIN_COLUMNS) return false;
  if (rows.length < MIN_DATA_ROWS) return false;

  // Header should be mostly non-empty - a sheet whose first row is blank
  // or single-celled is probably not a real table header
  const nonEmptyHeaders = headers.filter((h) => h.trim().length > 0).length;
  if (nonEmptyHeaders < MIN_COLUMNS) return false;

  return true;
}

function fileStem(file: SourceFile): string {
  return basename(file.relativePath, extname(file.relativePath));
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export async function extractXlsxTables(file: SourceFile): Promise<ExtractedTableData[]> {
  const buf = await readFile(file.absolutePath);
  const workbook = XLSX.read(buf, { type: "buffer" });
  const tables: ExtractedTableData[] = [];
  const stem = fileStem(file);

  let tableIndex = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // A legend sheet is documentation, not data. Never load it as a table -
    // its contents are read separately (below) as Tier-2 column semantics.
    if (isLegendSheet(sheetName)) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rows.length === 0) continue;

    const headers = (rows[0] as unknown[]).map((c) => String(c ?? "").trim());
    const dataRows = rows.slice(1) as unknown[][];

    if (!isTableLike(headers, dataRows)) {
      continue;
    }

    // Tier 2: read the workbook's own legend and attach whatever it says
    // about THIS sheet's columns. Deterministic, verbatim, exact-match only.
    const legend = await extractWorkbookLegend(
      file.absolutePath,
      normalizeHeaders(headers),
    );

    tables.push({
      sheetName,
      tableIndex: tableIndex++,
      displayName: `${stem} - ${sheetName}`,
      headers,
      rows: dataRows,
      extractionMethod: "xlsx_cells",
      extractionConfidence: 100,
      legend,
    });
  }

  return tables;
}

// ---------------------------------------------------------------------------
// DOCX
//
// mammoth converts docx to HTML, which preserves <table> structure. We parse
// the HTML for table elements and pull out rows/cells. The first row is
// treated as the header.
// ---------------------------------------------------------------------------

export async function extractDocxTables(file: SourceFile): Promise<ExtractedTableData[]> {
  const result = await mammoth.convertToHtml({ path: file.absolutePath });
  const html = result.value;
  const stem = fileStem(file);

  const tableHtmlBlocks = matchAll(html, /<table\b[^>]*>([\s\S]*?)<\/table>/gi);
  const tables: ExtractedTableData[] = [];

  let tableIndex = 0;
  for (const tableHtml of tableHtmlBlocks) {
    const rows = parseHtmlTableRows(tableHtml);
    if (rows.length === 0) continue;

    const headers = rows[0].map((c) => c.trim());
    const dataRows = rows.slice(1);

    if (!isTableLike(headers, dataRows)) {
      continue;
    }

    tables.push({
      tableIndex: tableIndex,
      sheetName: null,
      displayName: `${stem} - Table ${tableIndex + 1}`,
      headers,
      rows: dataRows,
      extractionMethod: "docx_cells",
      extractionConfidence: 100,
    });
    tableIndex++;
  }

  return tables;
}

// ---- minimal HTML table parsing (no external dependency) ----

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function parseHtmlTableRows(tableInner: string): string[][] {
  const rowBlocks = matchAll(tableInner, /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  const rows: string[][] = [];

  for (const rowHtml of rowBlocks) {
    // Cells can be <td> or <th>
    const cellBlocks = matchAll(rowHtml, /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi);
    const cells = cellBlocks.map(stripHtml);
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  // Normalize ragged rows to the widest row's column count so the table is
  // rectangular (SQL needs consistent columns). Short rows get padded with
  // empty strings.
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) => {
    if (r.length < width) {
      return [...r, ...Array(width - r.length).fill("")];
    }
    return r;
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")          // remove tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Dispatch by handler
// ---------------------------------------------------------------------------

export async function extractTables(
  file: SourceFile,
  handler: string,
): Promise<ExtractedTableData[]> {
  switch (handler) {
    case "xlsx-to-md":
      return extractXlsxTables(file);
    case "docx-to-md":
      return extractDocxTables(file);
    // pdf table extraction deferred (needs the visual pipeline)
    default:
      return [];
  }
}