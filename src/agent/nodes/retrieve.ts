// src/agent/nodes/retrieve.ts
//
// Multi-query retrieval with RRF fusion and a dedicated table lane.
//
// Using the QueryUnderstanding from the understand node, this builds several
// search queries - the original question, rephrasings, the HyDE hypothetical
// answer, and an entity/keyword query - embeds them, searches each in
// parallel, and fuses the ranked lists with Reciprocal Rank Fusion.
//
// Separately, it runs a TABLE-TARGETED search filtered to has_structured_table
// so table blurbs are retrieved through their own lane and are guaranteed to
// be seen regardless of how they'd rank against prose. This is the fix for
// the needle-in-haystack problem: a single blurb among thousands of prose
// chunks no longer has to win a shared top-K to be noticed.
//
// Final context = fused prose chunks + guaranteed table blurbs, deduped.

import { embedBatch } from "../../embeddings.js";
import { getAccessibleServices } from "../../services.js";
import { QueryRecord, type RetrievedChunk } from "../../queries.js";
import type { DataTier } from "../../tiers.js";
import type { AgentStateType } from "../state.js";
import { labelsIntersect } from "../../identity/classification.js";
import { enforceLabels } from "../../identity/index.js";
import { appendEvent } from "../../custody/ledger.js";
import { fuse, type RankedItem } from "../fusion.js";

const PROSE_TOP_K = 6; // per-query search depth
const FUSED_PROSE_K = 6; // how many fused prose chunks to keep
const TABLE_TOP_K = 3; // table-lane search depth (guaranteed included)

interface QdrantHit {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

function hitToChunk(h: QdrantHit): RetrievedChunk {
  return {
    id: String(h.id),
    text: String(h.payload?.text ?? ""),
    score: h.score ?? 0,
    source_path: h.payload?.source_path as string | undefined,
    source_extension: h.payload?.source_extension as string | undefined,
    sheet_name: h.payload?.sheet_name as string | undefined,
    row_range: h.payload?.row_range as [number, number] | undefined,
    has_structured_table: h.payload?.has_structured_table === true,
    table_id: h.payload?.table_id as string | undefined,
    table_display_name: h.payload?.table_display_name as string | undefined,
    access_labels: (h.payload?.access_labels as string[] | undefined) ?? [],
  };
}

/** Build the distinct set of query strings from the understanding. */
function buildQueryStrings(state: AgentStateType): string[] {
  const queries = [state.question];
  const u = state.understanding;
  if (u) {
    queries.push(...u.rephrasings);
    if (u.hydeAnswer) queries.push(u.hydeAnswer);
    const terms = [...u.entities, ...u.keywords].join(" ").trim();
    if (terms) queries.push(terms);
  }
  // Dedupe and cap to keep latency bounded
  return Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean))).slice(0, 6);
}

export async function retrieve(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId } = state;

  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in retrieve node`);
  }
  await queryRecord.setStatus("retrieving");

  const queryStrings = buildQueryStrings(state);
  const vectors = await embedBatch(queryStrings);
  const primaryVector = vectors[0]; // the original question's embedding

  const services = getAccessibleServices(ctx);
  const chunksByTier: Record<string, RetrievedChunk[]> = {};

  await Promise.all(
    Array.from(services.entries()).map(async ([tier, svc]) => {
      const startTime = Date.now();

      // --- The authorisation filter ---
      //
      // Applied INSIDE the query, to BOTH lanes. Restricted chunks are never
      // fetched, so they cannot be leaked - not by a clever question, not by
      // prompt injection, not by a bug in prompt assembly. Post-filtering
      // would mean asking a 7B to keep a secret.
      //
      // Qdrant excludes points that lack the key, so a point ingested without
      // access_labels is invisible to everyone. Fail-closed by construction.
      const labelFilter = enforceLabels()
        ? [{ key: "access_labels", match: { any: ctx.labels } }]
        : [];

      // --- Prose lane: one search per query vector, then RRF fuse ---
      const proseLists = await Promise.all(
        vectors.map((vector) =>
          svc.qdrant.search(svc.qdrantCollection, {
            vector,
            limit: PROSE_TOP_K,
            with_payload: true,
            ...(labelFilter.length > 0 ? { filter: { must: labelFilter } } : {}),
          }),
        ),
      );

      const rankedLists: RankedItem<QdrantHit>[][] = proseLists.map((hits) =>
        hits.map((h) => ({ id: String(h.id), item: h as QdrantHit })),
      );
      const fused = fuse(rankedLists);
      const proseChunks = fused.slice(0, FUSED_PROSE_K).map((f) => hitToChunk(f.item));

      // --- Table lane: dedicated filtered search for blurbs ---
      // Guarantees table awareness regardless of prose ranking.
      //
      // A blurb is DISCLOSURE: it carries column names, complete value domains
      // ("one of: Cascade, Denali, ..."), and observed ranges. The label filter
      // must be must-combined here too, or the guaranteed lane hands every
      // table's schema to every caller, by design.
      let tableChunks: RetrievedChunk[] = [];
      try {
        const tableHits = await svc.qdrant.search(svc.qdrantCollection, {
          vector: primaryVector,
          limit: TABLE_TOP_K,
          with_payload: true,
          filter: {
            must: [{ key: "has_structured_table", match: { value: true } }, ...labelFilter],
          },
        });
        tableChunks = tableHits.map((h) => hitToChunk(h as QdrantHit));
      } catch (err) {
        console.warn(
          `retrieve: table-lane search failed (payload index missing?): ${err instanceof Error ? err.message : err}`,
        );
        // Fall back to blurbs already surfaced by the prose lane - which was
        // itself label-filtered. Never re-query unfiltered.
        tableChunks = proseChunks.filter((c) => c.has_structured_table);
      }

      // --- Merge prose + guaranteed table blurbs, dedupe by id ---
      const seen = new Set<string>();
      const merged: RetrievedChunk[] = [];
      for (const chunk of [...tableChunks, ...proseChunks]) {
        if (!seen.has(chunk.id)) {
          seen.add(chunk.id);
          merged.push(chunk);
        }
      }

      // --- Canary: defence in depth ---
      //
      // The Qdrant filter is the control. This asserts it worked. Any chunk
      // whose labels do not intersect the caller's means the filter failed - a
      // missing payload index, a bad label at ingest, an unfiltered lane. That
      // is a security event, and it is detectable in one line.
      //
      // Log chunk IDS, never text: the error path must not become the thing
      // that prints restricted content to stdout.
      let safe = merged;
      if (enforceLabels()) {
        const leaked = merged.filter((c) => !labelsIntersect(c.access_labels ?? [], ctx.labels));
        if (leaked.length > 0) {
          console.error(
            `SECURITY: label filter failed - dropping ${leaked.length} chunk(s) that should ` +
              `have been excluded by the query.`,
            {
              decisionId: ctx.decisionId,
              policyHash: ctx.policyHash,
              callerLabels: ctx.labels,
              chunkIds: leaked.map((c) => c.id),
            },
          );
          safe = merged.filter((c) => labelsIntersect(c.access_labels ?? [], ctx.labels));
        }
      }

      const latency = Date.now() - startTime;
      await queryRecord.setTierChunks(tier as DataTier, safe, latency);
      chunksByTier[tier] = safe;

      // Custody: record WHAT was retrieved - chunk ids and labels, never text.
      // This is the grounding evidence: the export can later show every claim
      // traces to one of these ids. Emitted per tier; a rerun gets a new runId.
      await appendEvent(
        {
          correlationId: ctx.correlationId,
          runId: ctx.runId,
          userId: ctx.user.id,
          decisionId: ctx.decisionId,
          policyHash: ctx.policyHash,
        },
        "retrieval",
        {
          tier,
          chunkIds: safe.map((c) => c.id),
          tableBlurbIds: safe.filter((c) => c.has_structured_table).map((c) => c.id),
          callerLabels: ctx.labels,
          latencyMs: latency,
        },
      );
    }),
  );

  return { chunksByTier };
}