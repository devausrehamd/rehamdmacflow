// src/agent/nodes/reconcile.ts
//
// Reconciliation node. Takes per-tier partial answers and produces a
// final, polished response.
//
// For v1 with one tier, this is effectively a polish pass on the single
// partial. The pattern is the same as multi-tier reconciliation though,
// so when tiers split this node already handles the federated case.
//
// This is the node that writes the final answer to the QueryRecord and
// marks the query complete.

import { llm } from "../../llm-client.js";
import { QueryRecord } from "../../queries.js";
import type { AgentStateType } from "../state.js";
import { buildReconciliationPrompt } from "../prompts.js";

export async function reconcile(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId, question, partialsByTier } = state;

  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in reconcile node`);
  }
  await queryRecord.setStatus("reconciling");

  const startTime = Date.now();
  const prompt = buildReconciliationPrompt(question, partialsByTier);
  const response = await llm.invoke(prompt);
  const finalAnswer = String(response.content);
  const latency = Date.now() - startTime;

  // setFinalAnswer also marks the query as "complete"
  await queryRecord.setFinalAnswer(finalAnswer, latency);

  return { finalAnswer };
}