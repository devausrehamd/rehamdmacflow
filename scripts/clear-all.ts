// scripts/clear-all.ts
//
// Clear BOTH data stores in one operation:
//   1. Drop every physical SQL data table (tbl_<uuid>) and wipe the registry
//   2. Recreate the Qdrant collection (drops all vector points)
//
// This is the "full clean" - after running it, both the structured (SQL)
// and semantic (vector) stores are empty, ready for a fresh ingest.
//
// The source documents (git repo / local folder) are untouched.
//
// Usage:
//   npm run clear:all            (asks for confirmation)
//   npm run clear:all -- --yes   (skips confirmation, for the reingest cycle)

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { sql } from "drizzle-orm";
import { db, pool, closeDb } from "../src/db/client.js";
import { table_registry } from "../src/db/schema.js";
import { qdrant } from "../src/clients.js";
import { getEmbeddingDimension } from "../src/embeddings.js";
import { config } from "../src/config.js";
import { closeAllServices } from "../src/services.js";

const SKIP_CONFIRM = process.argv.includes("--yes") || process.argv.includes("-y");

async function confirm(): Promise<boolean> {
  if (SKIP_CONFIRM) return true;
  const rl = createInterface({ input, output });
  const answer = await rl.question(
    "\nThis will DELETE all SQL data tables AND all Qdrant vectors.\n" +
      "Source documents are untouched. Type 'yes' to confirm: ",
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function clearSqlTables(): Promise<number> {
  // Find every registered physical table and drop it
  const entries = await db.select().from(table_registry);
  let dropped = 0;
  for (const entry of entries) {
    const physical = `tbl_${entry.id.replace(/-/g, "")}`;
    // Identifier is derived from a UUID, safe to interpolate, but validate
    if (!/^tbl_[0-9a-f]{32}$/.test(physical)) {
      console.warn(`  Skipping suspicious table name: ${physical}`);
      continue;
    }
    await pool.query(`DROP TABLE IF EXISTS "${physical}"`);
    dropped++;
  }
  // Wipe the registry
  await db.delete(table_registry);
  return dropped;
}

async function clearQdrant(): Promise<void> {
  const collection = config.qdrant.operations.collection;
  const dim = await getEmbeddingDimension();

  const existing = await qdrant.getCollections();
  const exists = existing.collections.some((c) => c.name === collection);
  if (exists) {
    await qdrant.deleteCollection(collection);
  }
  await qdrant.createCollection(collection, {
    vectors: { size: dim, distance: "Cosine" },
  });
}

async function main(): Promise<void> {
  console.log("=== Clear all data stores ===");

  if (!(await confirm())) {
    console.log("Cancelled. Nothing was changed.");
    await closeDb();
    await closeAllServices();
    process.exit(0);
  }

  console.log("\nClearing SQL data tables...");
  const dropped = await clearSqlTables();
  console.log(`  Dropped ${dropped} physical table(s), registry wiped.`);

  console.log("Clearing Qdrant collection...");
  await clearQdrant();
  console.log(`  Collection '${config.qdrant.operations.collection}' recreated (empty).`);

  console.log("\nBoth stores cleared. Run an ingest to repopulate:");
  console.log("  npm run ingest:repo");

  await closeDb();
  await closeAllServices();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  await closeAllServices().catch(() => {});
  process.exit(1);
});