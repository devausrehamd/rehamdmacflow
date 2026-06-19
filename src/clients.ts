// src/clients.ts
//
// Singleton client instances for the three external services.
// Importing the same name from multiple modules gives all of them
// the same connection - no need to construct clients per-module.
//
// Note: no retry/wait logic here. If a service is down, calls should
// fail fast with a clear error. 

import { ChatOpenAI } from "@langchain/openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import { config } from "./config.js";

// --- LLM client ---
// Ollama exposes an OpenAI-compatible API, so we use ChatOpenAI
// pointed at the local Ollama endpoint. The apiKey is required by
// the SDK but Ollama ignores it.
export const llm = new ChatOpenAI({
  model: config.ollama.model,
  configuration: { baseURL: config.ollama.baseUrl },
  apiKey: "ollama-no-key-needed",
  temperature: 0.2,
});

// --- Qdrant client ---
export const qdrant = new QdrantClient({
  url: config.qdrant.url,
  // Optional: increase if you start hitting timeouts on large upserts
  // timeout: 60_000,
});

// --- Redis client ---
// maxRetriesPerRequest: 1 means a single command will fail fast rather
// than retry forever when the server is unreachable. The connection
// itself will still try to reconnect transparently.
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
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