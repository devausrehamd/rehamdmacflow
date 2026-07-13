// scripts/ensure-indexes.ts
//
// Create the Qdrant payload indexes on the existing operations collection.
// Needed for the agent's table-targeted filtered search (the blurb lane).
// New collections get these automatically via QdrantWriter.ensureCollection;
// this script applies them retroactively to a collection that already exists.
//
// Usage:
//   npm run ensure-indexes

import { getTierServices, closeAllServices } from "../src/services.js";
import { QdrantWriter } from "../src/ingestion/qdrant-writer.js";

async function main(): Promise<void> {
  const services = getTierServices("operations");
  const writer = new QdrantWriter(services.qdrant, {
    collection: services.qdrantCollection,
    recreateOnIngest: false,
  });

  console.log(`Ensuring payload indexes on '${services.qdrantCollection}'...`);
  await writer.ensureIndexes();
  console.log("Done. Indexes: has_structured_table (bool), source_path (keyword), tier (keyword).");

  await closeAllServices();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  await closeAllServices().catch(() => {});
  process.exit(1);
});