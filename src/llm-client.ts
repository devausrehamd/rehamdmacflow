// src/llm-client.ts
//
// The shared LLM client, split out from clients.ts so importing it does NOT
// construct a Qdrant or Redis client (decision-13 refactor R4).
//
// The agent role reaches the model through this client, but under decision 13 it
// holds no database client and carries no database credentials. clients.ts builds
// `qdrant` and `redis` as module side-effects, so importing `llm` from there would
// instantiate a Qdrant client in the agent's process — a capability it must not
// have. This module has neither; the agent imports `llm` from here, and the
// db-free-agent guard (scripts/smoke-test-agent-db-free.ts) enforces it.
//
// Ollama exposes an OpenAI-compatible API, so ChatOpenAI is pointed at the local
// Ollama endpoint. Every llm.invoke in the codebase goes through THIS one client,
// so the trace callback is attached here — one attachment captures every prompt
// and completion, rather than a per-call-site edit that the next call site forgets.

import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";
import { LlmTraceCallback } from "./agent/llm-trace.js";

export const llm = new ChatOpenAI({
  model: config.ollama.model,
  configuration: { baseURL: config.ollama.baseUrl },
  apiKey: "ollama-no-key-needed",
  temperature: 0.2,
  callbacks: [new LlmTraceCallback()],
});
