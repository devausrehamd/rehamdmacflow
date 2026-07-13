// src/agent/graph.ts
//
// Wire the nodes into a LangGraph StateGraph.
//
// For v1 (ask mode only), the graph is linear:
//   START -> retrieve -> draft -> reconcile -> finalize -> END
//
// When draft mode is added, the graph will branch from a classify node:
//   START -> classify -> (ask path)   -> retrieve -> draft -> reconcile -> finalize -> END
//                     \> (draft path) -> retrieve -> draft_n -> validate -> judge -> human_review -> persist -> END
//
// Compile the graph once at module load - the compiled version is what
// gets invoked or streamed. Compilation validates the graph topology
// (no orphan nodes, no missing edges, etc.).

import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { understand } from "./nodes/understand.js";
import { retrieve } from "./nodes/retrieve.js";
import { sqlRetrieve } from "./nodes/sql-retrieve.js";
import { draftPartials } from "./nodes/draft.js";
import { reconcile } from "./nodes/reconcile.js";
import { finalize } from "./nodes/finalize.js";

const builder = new StateGraph(AgentState)
  .addNode("understand", understand)
  .addNode("retrieve", retrieve)
  .addNode("sql_retrieve", sqlRetrieve)
  .addNode("draft", draftPartials)
  .addNode("reconcile", reconcile)
  .addNode("finalize", finalize)
  .addEdge(START, "understand")
  .addEdge("understand", "retrieve")
  .addEdge("retrieve", "sql_retrieve")
  .addEdge("sql_retrieve", "draft")
  .addEdge("draft", "reconcile")
  .addEdge("reconcile", "finalize")
  .addEdge("finalize", END);

export const agent = builder.compile();