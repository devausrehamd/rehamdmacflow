// src/agent/nodes/direct-answer.ts
//
// The exact-data short-circuit (docs/00-philosophy.md: deterministic where
// possible). When the SQL researcher already holds the answer to a quantitative
// question, this node composes it deterministically and finalises — the graph
// skips draft and reconcile, so no LLM is called to phrase a number the database
// already returned. That removes the class of failures where a model wrapped a
// definite figure in a placeholder or a note-to-self.
//
// It is reached only when the routing predicate (composeExactAnswer != null) has
// already confirmed a composable answer; the recompute here is pure and cheap.

import { QueryRecord } from "../../queries.js";
import type { AgentStateType } from "../state.js";
import { composeExactAnswer } from "../compose-exact.js";

export async function directAnswer(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId, question, sqlResults, chunksByTier } = state;

  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in direct_answer node`);
  }

  const answer = composeExactAnswer(question, sqlResults, chunksByTier);
  if (answer === null) {
    // The router only sends us here when an exact answer is composable; if that
    // ever changes, fail loudly rather than write an empty answer.
    throw new Error("direct_answer reached without a composable exact answer");
  }

  // Deterministic composition — no model latency to record.
  await queryRecord.setFinalAnswer(answer, 0);
  return { finalAnswer: answer };
}
