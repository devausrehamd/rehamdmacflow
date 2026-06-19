// scripts/reset-collection.ts
//
// Drop and recreate the Qdrant collection from scratch.
//
// Use this when:
//   - You changed the embedding model (dimensions changed)
//   - The collection got into a bad state
//   - You want a clean slate for testing
//
// This deletes ALL chunks and metadata. The source documents in your
// QMS folder or git repo are untouched - re-run the ingest task to
// repopulate.
//
// Usage:
//   npm run reset
//   # or with confirmation skipped:
//   npm run reset -- --yes

import { qdrant } from "../src/clients.js";
import { getEmbeddingDimension } from "../src/embeddings.js";
import { config } from "../src/config.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SKIP_CONFIRM = process.argv.includes("--yes") || process.argv.includes("-y");

async function confirmDestructive(collectionName: string): Promise<boolean> {
  if (SKIP_CONFIRM) return true;

  const rl = createInterface({ input, output });
  const answer = await rl.question(
    `\nAbout to DELETE the '${collectionName}' collection and all its data.\nType 'yes' to confirm: `,
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function getCollectionInfo(name: string) {
  try {
    const info = await qdrant.getCollection(name);
    return { exists: true, pointsCount: info.points_count ?? 0 };
  } catch {
    return { exists: false, pointsCount: 0 };
  }
}

async function main(): Promise<void> {
  const collectionName = config.qdrant.collection;

  console.log(`Target Qdrant: ${config.qdrant.url}`);
  console.log(`Target collection: ${collectionName}`);

  // Check current state
  const before = await getCollectionInfo(collectionName);

  if (before.exists) {
    console.log(`Collection currently has ${before.pointsCount} points.`);
    const ok = await confirmDestructive(collectionName);
    if (!ok) {
      console.log("Cancelled. Collection was not modified.");
      process.exit(0);
    }
    console.log(`\nDeleting collection '${collectionName}'...`);
    await qdrant.deleteCollection(collectionName);
    console.log("Deleted.");
  } else {
    console.log("Collection does not exist; will create fresh.");
  }

  // Detect current embedding dimension from the live Ollama endpoint
  console.log("\nDetecting embedding dimension from Ollama...");
  const dimension = await getEmbeddingDimension();
  console.log(`Embedding dimension: ${dimension}`);

  console.log(`\nCreating collection '${collectionName}' (dim=${dimension}, distance=Cosine)...`);
  await qdrant.createCollection(collectionName, {
    vectors: { size: dimension, distance: "Cosine" },
  });

  // Verify
  const after = await getCollectionInfo(collectionName);
  if (after.exists) {
    console.log(`\nCollection '${collectionName}' is ready (0 points).`);
    console.log("\nNext steps:");
    console.log("  npm run ingest:repo      # re-ingest from the configured source");
    console.log("  npm run test-retrieval   # verify search works once populated");
  } else {
    console.error("Collection creation reported success but the collection is not visible.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});