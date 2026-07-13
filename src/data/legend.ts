// src/data/legend.ts
//
// Tier 2 semantics: read the workbook's OWN legend.
//
// Most QMS spreadsheets carry a Metadata / Legend / Key / Definitions sheet
// where the organisation has already written down what the columns mean:
//
//     Scoring | Likelihood (1-5) x Impact (1-5) = Score
//
// That is a semantic hint the customer authored, sitting in the file we are
// already opening. Free, deterministic, no LLM, no SOP, nothing to approve.
//
// Two kinds of output:
//   - columnNotes: attached to a specific column, ONLY when the legend key
//     matches that column's normalised name EXACTLY. Never fuzzy. Attaching
//     "HIGH = >= 15" to the wrong column would silently corrupt every query
//     against it, so a near-miss must degrade to a table note, not a guess.
//   - tableNotes: everything else, surfaced verbatim in the blurb's schema
//     section for the planner to read as context.
//
// The legend is never interpreted, only relayed. What it says is what the
// planner sees.

import XLSX from "xlsx";
import { readFile } from "node:fs/promises";
import { normalizeHeaders } from "./table-schema.js";

// Sheets that describe the DOCUMENT (its title, owner, effective date). Their
// keys often collide with data column names - a "Status: Living Document" row
// is about the document, not about the Status column. Entries from these
// sheets NEVER attach to a column; they are relayed as table-level notes.
const DOC_METADATA_SHEETS = new Set([
  "metadata",
  "properties",
  "document info",
  "document information",
  "cover",
  "about",
]);

// Sheets that describe the COLUMNS - a data dictionary. Only these may attach
// notes to a specific column, and then only on an exact name match.
const COLUMN_LEGEND_SHEETS = new Set([
  "legend",
  "key",
  "definitions",
  "glossary",
  "data dictionary",
  "dictionary",
  "field definitions",
]);

export interface LegendData {
  /** Notes keyed by column sql_name. Data-dictionary sheets only, exact match only. */
  columnNotes: Record<string, string>;
  /** Free-standing notes relayed verbatim for the planner to read as context. */
  tableNotes: string[];
  /** Which sheet the legend came from, for provenance. */
  sourceSheet: string | null;
  /**
   * The raw classification string the document declares about itself, e.g.
   * "Stonefield Semiconductors - Internal". Fed to the classification policy,
   * which translates it into enforcement labels. Null when absent - which,
   * under fail-closed enforcement, means the document falls back to a path
   * default or becomes invisible.
   */
  declaredClassification: string | null;

  /**
   * Every key/value pair from the document's metadata sheet, verbatim.
   *
   * One sheet carries three facts the system needs, and each is resolved by a
   * different registry, none of them by guessing:
   *
   *   Document ID:    "Risk Register"                       -> collection
   *   Title:          "Project Summit - Risk Register"       -> project
   *   Classification: "Stonefield Semiconductors - Internal" -> access labels
   */
  metadataFields: Record<string, string>;
}

export const EMPTY_LEGEND: LegendData = {
  columnNotes: {},
  tableNotes: [],
  sourceSheet: null,
  declaredClassification: null,
  metadataFields: {},
};

// The metadata key that carries a document's declared classification.
const CLASSIFICATION_KEY_RE = /^(classification|security[ _-]?classification|sensitivity)$/i;

function normaliseSheetName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function isDocMetadataSheet(sheetName: string): boolean {
  return DOC_METADATA_SHEETS.has(normaliseSheetName(sheetName));
}

export function isColumnLegendSheet(sheetName: string): boolean {
  return COLUMN_LEGEND_SHEETS.has(normaliseSheetName(sheetName));
}

/** Any sheet that is documentation rather than data - never loaded as a table. */
export function isLegendSheet(sheetName: string): boolean {
  return isDocMetadataSheet(sheetName) || isColumnLegendSheet(sheetName);
}

/**
 * Normalise a legend key the same way a header becomes a sql_name, so that
 * "Scoring" and "scoring" and " Scoring " all compare identically to a
 * column's sql_name. Reuses normalizeHeaders for exact parity - a key only
 * attaches to a column if it would have produced that same sql_name.
 */
function keyToSqlName(key: string): string {
  return normalizeHeaders([key])[0];
}

/**
 * Pull key/value pairs out of a legend sheet. A legend row is expected to be
 * a label in the first non-empty cell and its text in the next. Rows that are
 * a single cell (titles, headings) are ignored.
 */
function parseLegendRows(rows: unknown[][]): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [];

  for (const row of rows) {
    const cells = row
      .map((c) => (c === null || c === undefined ? "" : String(c).trim()))
      .filter((c) => c.length > 0);

    // Need a label and a value; a lone cell is a title, not a definition.
    if (cells.length < 2) continue;

    const key = cells[0];
    const value = cells.slice(1).join(" ").trim();
    if (key.length === 0 || value.length === 0) continue;

    pairs.push({ key, value });
  }

  return pairs;
}

/**
 * Extract the legend from a workbook, if it has one. `columnSqlNames` is the
 * set of sql_names from the DATA sheet, used to decide which legend entries
 * attach to a column and which become table-level notes.
 *
 * Crucially, only a DATA-DICTIONARY sheet may attach a note to a column. A
 * document-metadata sheet ("Status: Living Document") describes the document,
 * and its keys frequently collide with data column names - attaching those
 * would tell the planner that the Status column means "Living Document" when
 * its real domain is {Open, Closed}. Those entries are relayed as table notes
 * instead, where they are informative but cannot mislead a filter.
 */
export async function extractWorkbookLegend(
  absolutePath: string,
  columnSqlNames: string[],
): Promise<LegendData> {
  let workbook: XLSX.WorkBook;
  try {
    const buf = await readFile(absolutePath);
    workbook = XLSX.read(buf, { type: "buffer" });
  } catch {
    return EMPTY_LEGEND;
  }

  const docSheets = workbook.SheetNames.filter(isDocMetadataSheet);
  const dictSheets = workbook.SheetNames.filter(isColumnLegendSheet);
  if (docSheets.length === 0 && dictSheets.length === 0) return EMPTY_LEGEND;

  const known = new Set(columnSqlNames);
  const columnNotes: Record<string, string> = {};
  const tableNotes: string[] = [];
  let declaredClassification: string | null = null;
  const metadataFields: Record<string, string> = {};

  const readPairs = (sheetName: string): { key: string; value: string }[] => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });
    return parseLegendRows(rows);
  };

  // Document metadata: relayed verbatim, NEVER attached to a column. The
  // Classification entry is additionally lifted into a structured field - it
  // is the document's own statement about who may read it.
  for (const sheetName of docSheets) {
    for (const { key, value } of readPairs(sheetName)) {
      metadataFields[key] = value;
      if (CLASSIFICATION_KEY_RE.test(key.trim())) {
        declaredClassification = value;
      }
      tableNotes.push(`${key}: ${value}`);
    }
  }

  // Data dictionary: may attach to a column, on exact normalised name match.
  for (const sheetName of dictSheets) {
    for (const { key, value } of readPairs(sheetName)) {
      const asSqlName = keyToSqlName(key);
      if (known.has(asSqlName)) {
        columnNotes[asSqlName] = value;
      } else {
        tableNotes.push(`${key}: ${value}`);
      }
    }
  }

  const sourceSheet = dictSheets[0] ?? docSheets[0] ?? null;
  return { columnNotes, tableNotes, sourceSheet, declaredClassification, metadataFields };
}