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
import { AgentState, type AgentStateType } from "./state.js";
import { instrument } from "./instrument.js";
import { understand } from "./nodes/understand.js";
import { retrieve } from "./nodes/retrieve.js";
import { sqlRetrieve } from "./nodes/sql-retrieve.js";
import { draftPartials } from "./nodes/draft.js";
import { directAnswer } from "./nodes/direct-answer.js";
import { reconcile } from "./nodes/reconcile.js";
import { finalize } from "./nodes/finalize.js";
import { composeExactAnswer } from "./compose-exact.js";

// After SQL retrieval, take the deterministic short-circuit when the exact data
// already answers a quantitative question (no LLM needed); otherwise fall through
// to the LLM answer path (draft + reconcile) that synthesises prose from context.
function routeAfterSql(state: AgentStateType): "direct" | "draft" {
  return composeExactAnswer(state.question, state.sqlResults, state.chunksByTier) !== null ? "direct" : "draft";
}

// Every node goes through `instrument`, which records what it was given and
// what it returned into agent_run_steps.
//
// Wrapping at the graph rather than inside each node is the point: a node added
// later is instrumented by being added here, so the trace cannot develop holes
// as the graph grows. Instrumenting from within each node would be one
// forgotten line away from a stage that silently reports nothing - and a trace
// with an invisible gap is worse than no trace, because it reads as complete.
const builder = new StateGraph(AgentState)
  .addNode("understand", instrument("understand", understand))
  .addNode("retrieve", instrument("retrieve", retrieve))
  .addNode("sql_retrieve", instrument("sql_retrieve", sqlRetrieve))
  .addNode("draft", instrument("draft", draftPartials))
  .addNode("direct_answer", instrument("direct_answer", directAnswer))
  .addNode("reconcile", instrument("reconcile", reconcile))
  .addNode("finalize", instrument("finalize", finalize))
  .addEdge(START, "understand")
  .addEdge("understand", "retrieve")
  .addEdge("retrieve", "sql_retrieve")
  // Exact-data short-circuit: skip the LLM answer path when the number is known.
  .addConditionalEdges("sql_retrieve", routeAfterSql, { direct: "direct_answer", draft: "draft" })
  .addEdge("direct_answer", "finalize")
  .addEdge("draft", "reconcile")
  .addEdge("reconcile", "finalize")
  .addEdge("finalize", END);

export const agent = builder.compile();