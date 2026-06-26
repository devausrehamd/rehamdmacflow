// src/agent/state.ts
//
// LangGraph state schema for the agent.
//
// The state flows through every node. Each node returns a partial state
// update (just the fields it changes); LangGraph merges using the reducers
// defined here.
//
// Important: state values must be serializable to JSON because LangGraph
// can checkpoint state mid-execution. This means we use Record<string, X>
// instead of Map<string, X> for the by-tier collections.

import { Annotation } from "@langchain/langgraph";
import type { RequestContext } from "../context.js";
import type { RetrievedChunk } from "../queries.js";

export const AgentState = Annotation.Root({
  // The QueryRecord ID - nodes use this to persist progress to Redis
  queryId: Annotation<string>(),

  // The user's identity and tier access
  ctx: Annotation<RequestContext>(),

  // The original question
  question: Annotation<string>(),

  // Retrieved chunks per tier. Reducer merges by tier key so each tier's
  // retrieve node populates its own entry independently.
  chunksByTier: Annotation<Record<string, RetrievedChunk[]>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // Partial answers per tier. Same merge pattern as chunks.
  partialsByTier: Annotation<Record<string, string>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // The reconciled final answer (set by reconcile node)
  finalAnswer: Annotation<string | undefined>(),
});

export type AgentStateType = typeof AgentState.State;