// src/agent/nodes/draft.ts
//
// Per-tier partial answer generation. Each tier's chunks produce one
// partial answer, generated in parallel.
//
// In Pattern B (per-tier partials + reconciliation), this is the
// "isolation" step - each partial is grounded in only one tier's content,
// so the model cannot accidentally conflate sources from different domains.
// For v1 with one tier, this produces one partial.

import { llm } from "../../clients.js";
import { QueryRecord } from "../../queries.js";
import type { DataTier } from "../../tiers.js";
import type { AgentStateType } from "../state.js";
import { buildPartialAnswerPrompt } from "../prompts.js";

export async function draftPartials(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { ctx, queryId, question, chunksByTier, sqlResults } = state;

  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in draft node`);
  }
  await queryRecord.setStatus("drafting");

  // SQL results are not tier-keyed (a table belongs to a tier, but the
  // results are exact data relevant to the whole question). In single-tier
  // v1 we make all SQL results available to the partial. When tiers split,
  // we would filter results to those whose table belongs to the tier.
  const sqlForPrompt = Object.values(sqlResults ?? {}).map((r) => ({
    displayName: r.displayName,
    executedSql: r.executedSql,
    rowCount: r.rowCount,
    rows: r.rows,
  }));

  const partialsByTier: Record<string, string> = {};

  // Generate partial answers in parallel - one per tier
  await Promise.all(
    Object.entries(chunksByTier).map(async ([tier, chunks]) => {
      // A tier with no chunks AND no SQL results has nothing to say
      if (chunks.length === 0 && sqlForPrompt.length === 0) {
        const noContent = "(no relevant content found in this domain)";
        await queryRecord.setTierPartial(tier as DataTier, noContent, 0);
        partialsByTier[tier] = noContent;
        return;
      }

      const startTime = Date.now();
      const prompt = buildPartialAnswerPrompt(question, tier, chunks, sqlForPrompt);
      const response = await llm.invoke(prompt);
      const partial = String(response.content);

      const latency = Date.now() - startTime;
      await queryRecord.setTierPartial(tier as DataTier, partial, latency);

      partialsByTier[tier] = partial;
    }),
  );

  return { partialsByTier };
}