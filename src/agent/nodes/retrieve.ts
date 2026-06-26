// src/agent/nodes/retrieve.ts
//
// Parallel per-tier retrieval. Uses getAccessibleServices() to fan out
// across every tier the user can read from. For v1 with one tier, this
// is one Qdrant call. When tiers split, it becomes multiple parallel calls.
//
// Persists chunks to the QueryRecord per-tier so the full retrieval state
// is auditable after the fact.

import { embed } from "../../embeddings.js";
import { getAccessibleServices } from "../../services.js";
import { QueryRecord, type RetrievedChunk } from "../../queries.js";
import type { DataTier } from "../../tiers.js";
import type { AgentStateType } from "../state.js";
import { buildRetrievalQuery } from "../prompts.js";

const TOP_K = 6;

export async function retrieve(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, question, queryId } = state;

  // Load the QueryRecord so we can persist per-tier results
  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in retrieve node`);
  }
  await queryRecord.setStatus("retrieving");

  // Build retrieval query and embed once - the same query vector goes to
  // every tier (semantically asking the same question of each domain)
  const query = buildRetrievalQuery(question);
  const queryVector = await embed(query);

  // Fan out across accessible tiers in parallel
  const services = getAccessibleServices(ctx);
  const chunksByTier: Record<string, RetrievedChunk[]> = {};

  await Promise.all(
    Array.from(services.entries()).map(async ([tier, svc]) => {
      const startTime = Date.now();

      const hits = await svc.qdrant.search(svc.qdrantCollection, {
        vector: queryVector,
        limit: TOP_K,
        with_payload: true,
      });

      const chunks: RetrievedChunk[] = hits.map((h) => ({
        id: String(h.id),
        text: String(h.payload?.text ?? ""),
        score: h.score ?? 0,
        source_path: h.payload?.source_path as string | undefined,
        source_extension: h.payload?.source_extension as string | undefined,
        sheet_name: h.payload?.sheet_name as string | undefined,
        row_range: h.payload?.row_range as [number, number] | undefined,
      }));

      const latency = Date.now() - startTime;
      await queryRecord.setTierChunks(tier as DataTier, chunks, latency);

      chunksByTier[tier] = chunks;
    }),
  );

  return { chunksByTier };
}