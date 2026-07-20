// src/clients.ts
//
// Singleton client instances for the three external services.
// Importing the same name from multiple modules gives all of them
// the same connection - no need to construct clients per-module.
//
// Note: no retry/wait logic here. If a service is down, calls should
// fail fast with a clear error. 

import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import { config } from "./config.js";

// --- LLM client ---
// Re-exported from its own module. The client lives in llm-client.ts so that the
// agent role can import `llm` WITHOUT pulling in the Qdrant/Redis clients this
// module constructs (decision-13 refactor R4). Non-agent callers may keep
// importing it from here; the agent imports it from ./llm-client.js.
export { llm } from "./llm-client.js";

// --- Qdrant client ---
// NOTE: the config is tier-aware (qdrant.operations.url). Reading the old flat
// `config.qdrant.url` yields undefined, and the client then silently falls back
// to its own localhost default - so QDRANT_URL appeared to work locally while
// being ignored entirely. Always go through the tier.
export const qdrant = new QdrantClient({
  url: config.qdrant.operations.url,
  // Optional: increase if you start hitting timeouts on large upserts
  // timeout: 60_000,
});

// --- Redis client ---
// maxRetriesPerRequest: 1 means a single command will fail fast rather
// than retry forever when the server is unreachable. The connection
// itself will still try to reconnect transparently.
export const redis = new Redis({
  host: config.redis.operations.host,
  port: config.redis.operations.port,
  maxRetriesPerRequest: 1,
});

// Surface connection-level errors without spamming repeatedly during
// reconnect storms. ioredis fires 'error' on every reconnect attempt.
let lastErrorMessage = "";
redis.on("error", (err) => {
  if (err.message !== lastErrorMessage) {
    console.error("Redis error:", err.message);
    lastErrorMessage = err.message;
  }
});