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
import { buildReconciliationPrompt, repairCitation, expandSourceCitations } from "../prompts.js";

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
  const latency = Date.now() - startTime;

  // Deterministic citation post-processing, so the reader always sees a real
  // source with its file path:
  //   1. repairCitation replaces a placeholder ("[Insert relevant citation here]")
  //      with the sources actually retrieved — even a "no data" answer cites what
  //      was reviewed rather than a template.
  //   2. expandSourceCitations turns a bare "[Source 5]" into "[Source 5: path]"
  //      so an opaque index becomes the actual file. The [Source N] numbering is
  //      per-tier, so the index→path map is only unambiguous with a single tier.
  const tierChunkLists = Object.values(queryRecord.toJSON().tiers).map((t) => t.chunks ?? []);
  const sourcePaths = tierChunkLists.flat().map((c) => c.source_path).filter((p): p is string => Boolean(p));
  const orderedSources = tierChunkLists.length === 1 ? tierChunkLists[0]!.map((c) => c.source_path) : [];

  let finalAnswer = repairCitation(String(response.content), sourcePaths);
  finalAnswer = expandSourceCitations(finalAnswer, orderedSources);

  // setFinalAnswer also marks the query as "complete"
  await queryRecord.setFinalAnswer(finalAnswer, latency);

  return { finalAnswer };
}