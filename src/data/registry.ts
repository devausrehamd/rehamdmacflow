// src/data/registry.ts
//
// Read-side helpers for the table registry. Used by the data API to look
// up a table's physical name, schema, and tier before running a query.

import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { table_registry, type TableRegistryEntry } from "../db/schema.js";
import type { ColumnSchema } from "./table-schema.js";

export interface RegisteredTable {
  id: string;
  physicalName: string;
  displayName: string;
  tier: string;
  columns: ColumnSchema[];
  rowCount: number;
  blurb: string;
}

function toRegistered(entry: TableRegistryEntry): RegisteredTable {
  const schema = entry.column_schema as { columns: ColumnSchema[] };
  return {
    id: entry.id,
    physicalName: `tbl_${entry.id.replace(/-/g, "")}`,
    displayName: entry.display_name,
    tier: entry.tier,
    columns: schema.columns,
    rowCount: entry.row_count,
    blurb: entry.blurb,
  };
}

/** Look up an active table by its UUID. Returns null if not found or superseded. */
export async function getTableById(id: string): Promise<RegisteredTable | null> {
  const rows = await db
    .select()
    .from(table_registry)
    .where(and(eq(table_registry.id, id), eq(table_registry.status, "active")))
    .limit(1);
  return rows[0] ? toRegistered(rows[0]) : null;
}

/** List active tables for a tier. Used for discovery / debugging. */
export async function listTables(tier?: string): Promise<RegisteredTable[]> {
  const rows = tier
    ? await db
        .select()
        .from(table_registry)
        .where(and(eq(table_registry.tier, tier), eq(table_registry.status, "active")))
    : await db.select().from(table_registry).where(eq(table_registry.status, "active"));
  return rows.map(toRegistered);
}