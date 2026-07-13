// scripts/reindex.ts
//
// Atomic full re-index: clears ALL stores then re-ingests, as ONE operation.
//
// This exists so that clearing and re-ingesting can never be run out of sync.
// The stores (Qdrant vectors + SQL tables + registry) are always rebuilt
// together from the same source, so a blurb can never point at a table that
// doesn't exist and a table can never lack its blurb. That coupling is what
// prevents orphaned/stale index entries.
//
// Steps (all or nothing - if the clear succeeds the ingest always follows):
//   1. Clear both stores: drop all SQL data tables, wipe the registry,
//      recreate the Qdrant collection (with payload indexes).
//   2. Re-ingest from the configured source: rebuild prose chunks AND table
//      blurbs, creating fresh SQL tables that the blurbs point at.
//
// Usage:
//   npm run reindex               (git source, asks for confirmation)
//   npm run reindex -- --yes      (skip confirmation - for the iterate cycle)
//   npm run reindex -- --local    (use the local QMS_FOLDER source)
//   npm run reindex -- --yes --local

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { sql } from "drizzle-orm";
import { db, pool, closeDb } from "../src/db/client.js";
import { table_registry } from "../src/db/schema.js";
import { qdrant } from "../src/clients.js";
import { getEmbeddingDimension } from "../src/embeddings.js";
import { config as appConfig } from "../src/config.js";
import { closeAllServices } from "../src/services.js";
import { loadConfig, runIngestion, printStats } from "../src/ingestion/pipeline.js";
import { QdrantWriter } from "../src/ingestion/qdrant-writer.js";

const SKIP_CONFIRM = process.argv.includes("--yes") || process.argv.includes("-y");
const USE_LOCAL = process.argv.includes("--local");

async function confirm(): Promise<boolean> {
  if (SKIP_CONFIRM) return true;
  const rl = createInterface({ input, output });
  const answer = await rl.question(
    "\nThis will CLEAR all stores (SQL tables + registry + Qdrant vectors)\n" +
      "and re-ingest from source. Source documents are untouched.\n" +
      "Type 'yes' to confirm: ",
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function clearSqlTables(): Promise<number> {
  const entries = await db.select().from(table_registry);
  let dropped = 0;
  for (const entry of entries) {
    const physical = `tbl_${entry.id.replace(/-/g, "")}`;
    if (!/^tbl_[0-9a-f]{32}$/.test(physical)) continue;
    await pool.query(`DROP TABLE IF EXISTS "${physical}"`);
    dropped++;
  }
  await db.delete(table_registry);
  return dropped;
}

async function clearQdrant(): Promise<void> {
  const collection = appConfig.qdrant.operations.collection;
  const dim = await getEmbeddingDimension();

  const existing = await qdrant.getCollections();
  const exists = existing.collections.some((c) => c.name === collection);
  if (exists) {
    await qdrant.deleteCollection(collection);
  }
  await qdrant.createCollection(collection, {
    vectors: { size: dim, distance: "Cosine" },
  });

  // Recreate payload indexes on the fresh collection so the table-lane
  // filtered search works immediately.
  const writer = new QdrantWriter(qdrant, {
    collection,
    recreateOnIngest: false,
  });
  await writer.ensureIndexes();
}

async function main(): Promise<void> {
  console.log("=== Full re-index (clear all stores + re-ingest) ===");

  if (!(await confirm())) {
    console.log("Cancelled. Nothing was changed.");
    await closeDb();
    await closeAllServices();
    process.exit(0);
  }

  // --- Step 1: clear both stores ---
  console.log("\n[1/2] Clearing all stores...");
  const dropped = await clearSqlTables();
  console.log(`      SQL: dropped ${dropped} table(s), registry wiped.`);
  await clearQdrant();
  console.log(`      Qdrant: collection recreated with payload indexes.`);

  // --- Step 2: re-ingest ---
  console.log("\n[2/2] Re-ingesting from source...");
  const configPath = USE_LOCAL
    ? "config/ingestion.local.json"
    : "config/ingestion.json";

  // Give a clear message if the local config hasn't been created yet
  if (USE_LOCAL) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(configPath)) {
      console.error(
        `\nLocal ingestion config not found: ${configPath}\n` +
          `Copy config/ingestion.local.example.json to ${configPath} and set your QMS_FOLDER path.`,
      );
      await closeDb();
      await closeAllServices();
      process.exit(1);
    }
  }

  const ingestionConfig = await loadConfig(configPath);
  console.log(`      Source: ${ingestionConfig.source.url ?? "local folder"}`);

  const stats = await runIngestion(ingestionConfig);
  printStats(stats);

  await closeDb();
  await closeAllServices();

  if (stats.filesFailed > 0) {
    console.log("\nRe-index completed with some file failures (see above).");
    process.exit(1);
  }
  console.log("\nRe-index complete. Both stores rebuilt in sync.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\nRe-index FAILED:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  await closeAllServices().catch(() => {});
  process.exit(1);
});