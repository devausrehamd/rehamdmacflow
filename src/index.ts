// src/index.ts
//
// Entry point. Currently runs a foundation smoke test that verifies
// each external service is reachable and the basic clients work.
//
// Replace the smoke test with the LangGraph agent runner once you've
// built src/agent/graph.ts (Phase 6+ in the tutorial).
//
// Will be moved to a visual studio task in the future to check local 
// configuration is ok before running any agents.
//
// Usage:
//   npm run agent

import { config } from "./config.js";
import { llm, qdrant, redis } from "./clients.js";
import { getEmbeddingDimension } from "./embeddings.js";

async function smokeTest(): Promise<void> {
  console.log("=== Foundation smoke test ===\n");

  // Config loaded and validated?
  console.log("Configuration:");
  console.log(`  Ollama:     ${config.ollama.baseUrl}`);
  console.log(`              model=${config.ollama.model}`);
  console.log(`              embed=${config.ollama.embedModel}`);
  console.log(`  Qdrant:     ${config.qdrant.operations.url}`);
  console.log(`              collection=${config.qdrant.operations.collection}`);
  console.log(`  Redis:      ${config.redis.operations.host}:${config.redis.operations.port}`);
  console.log(`  QMS folder: ${config.qmsFolder}`);

  // LLM endpoint
  console.log("\nLLM endpoint:");
  const llmStart = Date.now();
  const llmResponse = await llm.invoke("Reply with exactly: OK");
  const llmLatency = Date.now() - llmStart;
  console.log(`  Response: ${String(llmResponse.content).trim()}`);
  console.log(`  Latency:  ${llmLatency}ms`);

  // Embeddings endpoint
  console.log("\nEmbedding endpoint:");
  const embedStart = Date.now();
  const dim = await getEmbeddingDimension();
  const embedLatency = Date.now() - embedStart;
  console.log(`  Dimension: ${dim}`);
  console.log(`  Latency:   ${embedLatency}ms`);

  // Qdrant
  console.log("\nQdrant:");
  const collections = await qdrant.getCollections();
  console.log(`  Total collections: ${collections.collections.length}`);
  const matched = collections.collections.find(
    (c) => c.name === config.qdrant.operations.collection,
  );
  if (matched) {
    const info = await qdrant.getCollection(config.qdrant.operations.collection);
    console.log(`  ${config.qdrant.operations.collection}: ${info.points_count ?? 0} points`);
  } else {
    console.log(`  ${config.qdrant.operations.collection}: not yet created`);
    console.log(`    Run: npm run ingest:repo`);
  }

  // Redis
  console.log("\nRedis:");
  await redis.set("smoke-test", "ok", "EX", 10);
  const val = await redis.get("smoke-test");
  console.log(`  Round-trip: ${val}`);
  const dbsize = await redis.dbsize();
  console.log(`  Keys in db: ${dbsize}`);

  console.log("\n=== All foundations working ===");
  console.log("\nNext steps:");
  console.log("  1. Ingest your QMS documents:");
  console.log("       npm run ingest:repo");
  console.log("  2. Test retrieval:");
  console.log("       npm run test-retrieval 'how should safety classification be justified'");
  console.log("  3. Build the agent module under src/agent/");
  console.log("     (see docs/setup_tutorial.md Phase 6 onward)");
}

smokeTest()
  .catch((err) => {
    console.error("\n=== Smoke test FAILED ===");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Always close Redis cleanly so the process can exit
    await redis.quit();
  });