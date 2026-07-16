// src/ingestion/prune.ts
//
// Supersession for DELETED source files.
//
// Re-ingesting an existing file is already clean: the pipeline calls
// deleteByPath() before rewriting it, so its old chunks and blurb are
// replaced. But a file REMOVED from the source repo is never visited by the
// ingestion loop, so nothing ever deletes its artifacts. They linger:
//
//   - its chunks stay in Qdrant
//   - its table blurb stays in Qdrant, and the TABLE LANE guarantees blurbs
//     surface, so the agent will reliably retrieve a pointer to a table that
//     no longer exists
//   - its registry row stays "active" and its tbl_<uuid> stays in Postgres
//   - its document_sections rows stay in the structural map
//
// For a QMS, retrieving a superseded document is a compliance problem, not a
// quality one. This prune closes that gap: after ingestion, anything whose
// source_path is no longer among the discovered files is removed.
//
// CRITICAL: live-source blurbs also carry a source_path (their descriptor
// file), and descriptors are NOT part of the document ingestion set. Pruning
// naively by source_path would delete every live-source pointer. They are
// excluded by has_live_source.

import { QdrantClient } from "@qdrant/js-client-rest";
import { eq, and } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { table_registry, document_sections } from "../db/schema.js";
import { physicalTableName, quoteIdent } from "../data/table-loader.js";

export interface PruneStats {
  qdrantPointsDeleted: boolean;
  tablesSuperseded: number;
  sectionsDeleted: number;
  prunedPaths: string[];
}

/**
 * Remove artifacts for source paths that no longer exist.
 *
 * @param livePaths every source_path discovered in this ingestion run
 */
export async function pruneRemovedSources(
  qdrant: QdrantClient,
  collection: string,
  livePaths: string[],
): Promise<PruneStats> {
  const stats: PruneStats = {
    qdrantPointsDeleted: false,
    tablesSuperseded: 0,
    sectionsDeleted: 0,
    prunedPaths: [],
  };

  // Guard: an empty live set would mean "delete everything". Almost certainly
  // a discovery failure rather than an empty repo - refuse.
  if (livePaths.length === 0) {
    console.warn("prune: no live source paths - skipping (refusing to delete everything).");
    return stats;
  }

  const live = new Set(livePaths);

  // --- 1. Postgres: supersede registry rows for vanished files ---
  const active = await db
    .select()
    .from(table_registry)
    .where(eq(table_registry.status, "active"));

  for (const entry of active) {
    if (live.has(entry.source_path)) continue;

    const physical = physicalTableName(entry.id);
    await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(physical)}`);
    await db
      .update(table_registry)
      .set({ status: "superseded" })
      .where(eq(table_registry.id, entry.id));

    stats.tablesSuperseded++;
    if (!stats.prunedPaths.includes(entry.source_path)) {
      stats.prunedPaths.push(entry.source_path);
    }
  }

  // --- 2. Postgres: drop structural-map rows for vanished files ---
  const sections = await db.select().from(document_sections);
  const deadKeys = new Set(
    sections.filter((s) => !live.has(s.source_path)).map((s) => s.document_key),
  );
  for (const key of deadKeys) {
    await db.delete(document_sections).where(eq(document_sections.document_key, key));
    stats.sectionsDeleted++;
  }

  // --- 3. Qdrant: delete points whose source_path is gone ---
  //
  // Filter reads: delete every point for which NONE of these hold:
  //   (a) source_path is one of the live paths
  //   (b) it is a live-source blurb
  // i.e. delete points that are neither current documents nor live-source
  // pointers. Chunk points and table blurbs both carry source_path, so both
  // are covered; live-source blurbs are protected by (b).
  try {
    await qdrant.delete(collection, {
      filter: {
        must_not: [
          { key: "source_path", match: { any: livePaths } },
          { key: "has_live_source", match: { value: true } },
        ],
      },
    });
    stats.qdrantPointsDeleted = true;
  } catch (err) {
    console.warn(
      `prune: Qdrant delete failed (payload index missing?): ${err instanceof Error ? err.message : err}`,
    );
  }

  return stats;
}
