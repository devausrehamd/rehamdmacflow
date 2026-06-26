// src/data/table-loader.ts
//
// Loads an extracted table into Postgres:
//   1. Mint a UUID (the table's unique identity across all projects)
//   2. Derive the physical table name: tbl_<uuid hex, dashes stripped>
//   3. CREATE TABLE with the inferred column types
//   4. INSERT the rows (parameterized)
//   5. Write the registry entry (schema, blurb, provenance)
//
// Re-ingestion (truncate + reload): if an active registry entry exists for
// the same source_path + sheet_name + table_index, its physical table is
// dropped and its registry entry marked superseded, then a fresh table is
// created. Simple, no history (chosen for v1).
//
// Uses the read-WRITE pool because it needs CREATE/INSERT/DROP. The data
// API uses a separate read-only pool - the agent never touches this loader.

import { randomUUID } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { table_registry } from "../db/schema.js";
import {
  buildColumnSchema,
  pgTypeFor,
  coerceValueForInsert,
  type ColumnSchema,
} from "./table-schema.js";
import { generateBlurb } from "./blurb.js";

export interface ExtractedTable {
  sourcePath: string;
  sourceSha256: string;
  sheetName?: string | null;
  tableIndex: number;
  displayName: string;
  tier: string;
  headers: string[];
  rows: unknown[][];
  // Future-proofing for the visual pipeline (defaulted for xlsx/docx)
  extractionMethod?: string;
  extractionConfidence?: number; // 0-100
  sourceRegion?: Record<string, unknown> | null;
}

export interface LoadedTable {
  tableId: string;
  physicalName: string;
  displayName: string;
  rowCount: number;
  columns: ColumnSchema[];
  blurb: string;
}

/** Derive the physical SQL table name from a UUID. */
export function physicalTableName(uuid: string): string {
  return `tbl_${uuid.replace(/-/g, "")}`;
}

/** Validate and double-quote a Postgres identifier. Our generated names are
 * already constrained to [a-z_][a-z0-9_]*, but we check defensively because
 * these go into raw DDL. */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to use unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

export async function loadTable(table: ExtractedTable): Promise<LoadedTable> {
  await supersedeExisting(table);

  const tableId = randomUUID();
  const physical = physicalTableName(tableId);
  const columns = buildColumnSchema(table.headers, table.rows);

  // 1. CREATE TABLE (DDL - identifiers validated, no user values)
  const columnDefs = columns
    .map((c) => `${quoteIdent(c.sql_name)} ${pgTypeFor(c.type)}`)
    .join(", ");
  await pool.query(`CREATE TABLE ${quoteIdent(physical)} (${columnDefs})`);

  // 2. INSERT rows (parameterized - values are never concatenated)
  if (table.rows.length > 0) {
    await insertRows(physical, columns, table.rows);
  }

  // 3. Generate blurb
  const blurb = generateBlurb({
    tableId,
    displayName: table.displayName,
    sourcePath: table.sourcePath,
    sheetName: table.sheetName,
    tier: table.tier,
    rowCount: table.rows.length,
    columns,
  });

  // 4. Registry entry
  await db.insert(table_registry).values({
    id: tableId,
    source_path: table.sourcePath,
    source_sha256: table.sourceSha256,
    sheet_name: table.sheetName ?? null,
    table_index: table.tableIndex,
    display_name: table.displayName,
    tier: table.tier,
    column_schema: { columns },
    row_count: table.rows.length,
    blurb,
    extraction_method: table.extractionMethod ?? "xlsx_cells",
    extraction_confidence: table.extractionConfidence ?? 100,
    source_region: table.sourceRegion ?? null,
    status: "active",
  });

  return {
    tableId,
    physicalName: physical,
    displayName: table.displayName,
    rowCount: table.rows.length,
    columns,
    blurb,
  };
}

async function insertRows(
  physical: string,
  columns: ColumnSchema[],
  rows: unknown[][],
): Promise<void> {
  const colNames = columns.map((c) => quoteIdent(c.sql_name)).join(", ");
  const BATCH = 500;

  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const params: unknown[] = [];
    const valueGroups: string[] = [];
    let p = 1;

    for (const row of batch) {
      const placeholders = columns.map(() => `$${p++}`);
      valueGroups.push(`(${placeholders.join(", ")})`);
      for (let i = 0; i < columns.length; i++) {
        params.push(coerceValueForInsert(row[i], columns[i].type));
      }
    }

    const insertSql = `INSERT INTO ${quoteIdent(physical)} (${colNames}) VALUES ${valueGroups.join(", ")}`;
    // Parameterized: values bound by the driver, never string-concatenated
    await pool.query(insertSql, params);
  }
}

async function supersedeExisting(table: ExtractedTable): Promise<void> {
  const existing = await db
    .select()
    .from(table_registry)
    .where(
      and(
        eq(table_registry.source_path, table.sourcePath),
        eq(table_registry.sheet_name, table.sheetName ?? ""),
        eq(table_registry.table_index, table.tableIndex),
        eq(table_registry.status, "active"),
      ),
    );

  for (const entry of existing) {
    const physical = physicalTableName(entry.id);
    await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(physical)}`);
    await db
      .update(table_registry)
      .set({ status: "superseded" })
      .where(eq(table_registry.id, entry.id));
  }
}