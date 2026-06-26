// scripts/smoke-test-tables.ts
//
// Verify the structured-data foundation end-to-end without touching the
// ingestion pipeline. Feeds a synthetic table (mirroring the real Risk
// Register structure) through:
//   extract -> type inference -> load into SQL -> register -> blurb
//   -> query via the builder -> verify results
//
// This proves the SQL path works in isolation before sub-batch B wires it
// into real document ingestion.
//
// Usage:
//   npm run smoke:tables

import { loadTable, physicalTableName, type ExtractedTable } from "../src/data/table-loader.js";
import { getTableById } from "../src/data/registry.js";
import { buildQuery } from "../src/data/query-builder.js";
import { inferColumnType, normalizeHeaders } from "../src/data/table-schema.js";
import { readonlyPool, pool, closeDb } from "../src/db/client.js";
import { table_registry } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let failed = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`${GREEN}OK${NC}   ${name}`);
  } catch (err) {
    failed++;
    console.error(`${RED}FAIL${NC} ${name}`);
    console.error(`     ${err instanceof Error ? err.message : err}`);
  }
}

// Synthetic table mirroring the real Risk Register
const sampleTable: ExtractedTable = {
  sourcePath: "__smoke_test__/Risk_Register.xlsx",
  sourceSha256: "smoke0000000000000000000000000000000000000000000000000000000test",
  sheetName: "Risk Register",
  tableIndex: 0,
  displayName: "Smoke Test Risk Register",
  tier: "operations",
  headers: ["Risk ID", "Title", "Owner", "Likelihood (1-5)", "Impact (1-5)", "Score", "Status"],
  rows: [
    ["R-001", "Database failover gap", "A. Singh", "4", "5", "20", "Open"],
    ["R-002", "Supply chain delay", "M. Patel", "3", "4", "12", "Open"],
    ["R-003", "Thermal margin", "T. Chen", "2", "3", "6", "Closed"],
    ["R-004", "EMC compliance", "A. Singh", "3", "5", "15", "Open"],
    ["R-005", "Firmware regression", "M. Patel", "2", "2", "4", "Closed"],
  ],
};

async function main(): Promise<void> {
  console.log("=== Structured-data foundation smoke test ===\n");

  let tableId: string | null = null;
  let physicalName: string | null = null;

  // --- Type inference (pure logic) ---

  await step("Type inference: integers detected", () => {
    const type = inferColumnType(["4", "3", "2", "3", "2"]);
    if (type !== "integer") throw new Error(`expected integer, got ${type}`);
  });

  await step("Type inference: text fallback for mixed", () => {
    const type = inferColumnType(["R-001", "R-002", "R-003"]);
    if (type !== "text") throw new Error(`expected text, got ${type}`);
  });

  await step("Type inference: empty values don't break integer detection", () => {
    const type = inferColumnType(["4", "", "2", null, "3"]);
    if (type !== "integer") throw new Error(`expected integer with nulls, got ${type}`);
  });

  await step("Column normalization: handles parens and spaces", () => {
    const names = normalizeHeaders(["Risk ID", "Likelihood (1-5)", "Date Identified"]);
    if (names[0] !== "risk_id") throw new Error(`got ${names[0]}`);
    if (names[1] !== "likelihood_1_5") throw new Error(`got ${names[1]}`);
    if (names[2] !== "date_identified") throw new Error(`got ${names[2]}`);
  });

  await step("Column normalization: dedupes collisions", () => {
    const names = normalizeHeaders(["Name", "name", "NAME"]);
    if (new Set(names).size !== 3) throw new Error(`expected 3 unique, got ${JSON.stringify(names)}`);
  });

  // --- Load into SQL ---

  await step("Load: creates table, inserts rows, registers", async () => {
    const loaded = await loadTable(sampleTable);
    tableId = loaded.tableId;
    physicalName = loaded.physicalName;
    if (loaded.rowCount !== 5) throw new Error(`expected 5 rows, got ${loaded.rowCount}`);
    if (!loaded.tableId.includes("-")) throw new Error("tableId should be a UUID");
    if (!physicalName.startsWith("tbl_")) throw new Error("physical name should start with tbl_");
  });

  await step("Load: physical table actually exists with data", async () => {
    if (!physicalName) throw new Error("no physical name");
    const result = await pool.query(`SELECT COUNT(*) AS n FROM "${physicalName}"`);
    const count = Number(result.rows[0].n);
    if (count !== 5) throw new Error(`expected 5 rows in physical table, got ${count}`);
  });

  await step("Load: type inference applied (score is integer)", async () => {
    const table = await getTableById(tableId!);
    if (!table) throw new Error("table not in registry");
    const scoreCol = table.columns.find((c) => c.sql_name === "score");
    if (!scoreCol) throw new Error("score column missing");
    if (scoreCol.type !== "integer") throw new Error(`score should be integer, got ${scoreCol.type}`);
  });

  await step("Registry: blurb contains table id and columns", async () => {
    const table = await getTableById(tableId!);
    if (!table) throw new Error("table not found");
    if (!table.blurb.includes(tableId!)) throw new Error("blurb missing table id");
    if (!table.blurb.includes("likelihood_1_5")) throw new Error("blurb missing column");
  });

  // --- Query via the builder against the read-only pool ---

  await step("Query: simple filter (status = Open)", async () => {
    const table = await getTableById(tableId!);
    const { sql, params } = buildQuery(table!.physicalName, table!.columns, {
      filter: { op: "and", conditions: [{ column: "status", op: "eq", value: "Open" }] },
    });
    const result = await readonlyPool.query(sql, params);
    if (result.rowCount !== 3) throw new Error(`expected 3 open, got ${result.rowCount}`);
  });

  await step("Query: aggregate count with filter", async () => {
    const table = await getTableById(tableId!);
    const { sql, params } = buildQuery(table!.physicalName, table!.columns, {
      filter: {
        op: "and",
        conditions: [
          { column: "owner", op: "eq", value: "A. Singh" },
          { column: "status", op: "eq", value: "Open" },
        ],
      },
      aggregate: { fn: "count" },
    });
    const result = await readonlyPool.query(sql, params);
    const count = Number(result.rows[0].result);
    if (count !== 2) throw new Error(`expected 2 (A. Singh open risks), got ${count}`);
  });

  await step("Query: numeric comparison (score >= 15)", async () => {
    const table = await getTableById(tableId!);
    const { sql, params } = buildQuery(table!.physicalName, table!.columns, {
      select: ["risk_id", "score"],
      filter: { op: "and", conditions: [{ column: "score", op: "gte", value: 15 }] },
      order_by: [{ column: "score", dir: "desc" }],
    });
    const result = await readonlyPool.query(sql, params);
    if (result.rowCount !== 2) throw new Error(`expected 2 high-score, got ${result.rowCount}`);
    if (Number(result.rows[0].score) !== 20) throw new Error("order by desc failed");
  });

  await step("Query: aggregate avg of score", async () => {
    const table = await getTableById(tableId!);
    const { sql, params } = buildQuery(table!.physicalName, table!.columns, {
      aggregate: { fn: "avg", column: "score" },
    });
    const result = await readonlyPool.query(sql, params);
    const avg = Number(result.rows[0].result);
    // (20+12+6+15+4)/5 = 11.4
    if (Math.abs(avg - 11.4) > 0.01) throw new Error(`expected avg 11.4, got ${avg}`);
  });

  await step("Query: group by status", async () => {
    const table = await getTableById(tableId!);
    const { sql, params } = buildQuery(table!.physicalName, table!.columns, {
      aggregate: { fn: "count" },
      group_by: ["status"],
      order_by: [{ column: "status", dir: "asc" }],
    });
    const result = await readonlyPool.query(sql, params);
    if (result.rowCount !== 2) throw new Error(`expected 2 groups, got ${result.rowCount}`);
  });

  await step("Query: rejects unknown column", async () => {
    const table = await getTableById(tableId!);
    try {
      buildQuery(table!.physicalName, table!.columns, {
        filter: { op: "and", conditions: [{ column: "nonexistent", op: "eq", value: "x" }] },
      });
      throw new Error("should have rejected unknown column");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Unknown column")) return;
      throw err;
    }
  });

  // --- Re-ingestion (truncate + reload) ---

  await step("Reload: re-loading same source supersedes the old table", async () => {
    const firstId = tableId!;
    const reloaded = await loadTable(sampleTable);
    if (reloaded.tableId === firstId) throw new Error("reload should mint a new UUID");

    // Old registry entry should be superseded
    const oldEntry = await db
      .select()
      .from(table_registry)
      .where(eq(table_registry.id, firstId));
    if (oldEntry[0]?.status !== "superseded") {
      throw new Error("old entry should be superseded");
    }

    // Old physical table should be gone
    const oldPhysical = physicalTableName(firstId);
    const exists = await pool.query(
      `SELECT to_regclass($1) AS reg`,
      [oldPhysical],
    );
    if (exists.rows[0].reg !== null) throw new Error("old physical table should be dropped");

    // Track the new one for cleanup
    tableId = reloaded.tableId;
    physicalName = reloaded.physicalName;
  });

  // --- Cleanup ---

  await step("Cleanup: remove smoke test tables and registry entries", async () => {
    // Drop any physical tables and registry rows from this test
    const entries = await db
      .select()
      .from(table_registry)
      .where(eq(table_registry.source_path, sampleTable.sourcePath));
    for (const entry of entries) {
      const phys = physicalTableName(entry.id);
      await pool.query(`DROP TABLE IF EXISTS "${phys}"`);
      await db.delete(table_registry).where(eq(table_registry.id, entry.id));
    }
  });

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}All structured-data checks passed.${NC}`);
  } else {
    console.log(`${RED}${failed} check(s) failed.${NC}`);
  }

  await closeDb();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Smoke test crashed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});