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
import type { QueryUnderstanding } from "./understand.js";
import type { GroundingIssue } from "./grounding.js";

// A single SQL retrieval result - one table queried, its rows, and the SQL
// that produced them (for transparency in the partial-answer prompt).
export interface SqlResult {
  tableId: string;
  displayName: string;
  executedSql: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}

export const AgentState = Annotation.Root({
  // The QueryRecord ID - nodes use this to persist progress to Redis
  queryId: Annotation<string>(),

  // The user's identity and tier access
  ctx: Annotation<RequestContext>(),

  // The user's access token, used by the SQL retrieval node to call the
  // data API as the user (so tier checks enforce the user's permissions).
  // IN-MEMORY ONLY: this flows through LangGraph state but is never written
  // to the QueryRecord, so it does not get persisted to Redis.
  authToken: Annotation<string | undefined>(),

  // The original question
  question: Annotation<string>(),

  // Query understanding (intent, entities, keywords, rephrasings, HyDE).
  // Produced by the understand node, consumed by retrieve to build multiple
  // search queries.
  understanding: Annotation<QueryUnderstanding | undefined>(),

  // Retrieved chunks per tier. Reducer merges by tier key so each tier's
  // retrieve node populates its own entry independently.
  chunksByTier: Annotation<Record<string, RetrievedChunk[]>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // Structured-table results from the SQL retrieval node. Keyed by tableId
  // so multiple tables can be queried independently.
  sqlResults: Annotation<Record<string, SqlResult>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // Partial answers per tier. Same merge pattern as chunks.
  partialsByTier: Annotation<Record<string, string>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // Filters the SQL planner produced whose values fall outside their column's
  // domain — decode failures the grounding gate refused to execute. When present,
  // the graph answers by calling them out (deterministically) rather than guessing.
  groundingIssues: Annotation<GroundingIssue[]>({
    reducer: (current, update) => (update && update.length > 0 ? update : current),
    default: () => [],
  }),

  // The reconciled final answer (set by reconcile node)
  finalAnswer: Annotation<string | undefined>(),
});

export type AgentStateType = typeof AgentState.State;