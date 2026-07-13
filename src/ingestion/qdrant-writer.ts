// Embed chunks and upsert them into Qdrant. Encapsulates collection
// management and the dimension-detection that runs once on first contact.

import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embed, embedBatch, getEmbeddingDimension } from "../embeddings.js";
import type {
  ConvertedDocument,
  DocumentChunk,
  QdrantConfig,
} from "./types.js";

export class QdrantWriter {
  private dimension: number | null = null;

  constructor(
    private client: QdrantClient,
    private config: QdrantConfig,
  ) {}

  /** Read-only accessors so callers (e.g. prune) can act on the same target. */
  get qdrantClient(): QdrantClient {
    return this.client;
  }

  get collectionName(): string {
    return this.config.collection;
  }

  async ensureCollection(): Promise<void> {
    if (this.dimension === null) {
      this.dimension = await getEmbeddingDimension();
    }

    const existing = await this.client.getCollections();
    const exists = existing.collections.some(
      (c) => c.name === this.config.collection,
    );

    if (this.config.recreateOnIngest && exists) {
      console.log(`Recreating collection ${this.config.collection}...`);
      await this.client.deleteCollection(this.config.collection);
    }

    if (!exists || this.config.recreateOnIngest) {
      await this.client.createCollection(this.config.collection, {
        vectors: { size: this.dimension, distance: "Cosine" },
      });
      console.log(
        `Created collection ${this.config.collection} (dim=${this.dimension})`,
      );
    }

    await this.ensureIndexes();
  }

  /**
   * Create payload indexes needed for filtered searches. Idempotent - Qdrant
   * errors if an index already exists, which we ignore. The
   * has_structured_table index is what lets the agent run a dedicated
   * table-targeted search (the blurb's own retrieval lane).
   */
  async ensureIndexes(): Promise<void> {
    const indexes: { field: string; schema: "bool" | "keyword" }[] = [
      { field: "has_structured_table", schema: "bool" },
      { field: "has_live_source", schema: "bool" },
      { field: "source_path", schema: "keyword" },
      { field: "tier", schema: "keyword" },
      { field: "section_id", schema: "keyword" },
      { field: "parent_section_id", schema: "keyword" },
      // The authorisation filter field. Without this index the label filter
      // cannot run, and the table lane silently falls back to unfiltered.
      { field: "access_labels", schema: "keyword" },
      // Project and collection are FILTER fields, not search fields. "the
      // Summit risk register" is an exact payload match; asking a vector
      // search to find it by similarity would be guessing.
      { field: "project", schema: "keyword" },
      { field: "collection", schema: "keyword" },
    ];

    for (const idx of indexes) {
      try {
        await this.client.createPayloadIndex(this.config.collection, {
          field_name: idx.field,
          field_schema: idx.schema,
        });
      } catch {
        // Index already exists - fine
      }
    }
  }

  async writeDocument(
    doc: ConvertedDocument,
    chunks: DocumentChunk[],
    accessLabels: string[] = [],
    subject: { project?: string | null; collection?: string | null } = {},
  ): Promise<number> {
    if (chunks.length === 0) return 0;

    const embeddings = await embedBatch(chunks.map((c) => c.text));

    const points = chunks.map((chunk, idx) => ({
      id: makePointId(doc.sourceFile.sha256, chunk.index),
      vector: embeddings[idx],
      payload: {
        // Source provenance
        source_path: doc.sourceFile.relativePath,
        source_extension: doc.sourceFile.extension,
        source_sha256: doc.sourceFile.sha256,
        // Conversion info
        converted_path: doc.convertedPath,
        conversion_metadata: doc.metadata,
        // Chunk info
        chunk_index: chunk.index,
        chunk_total: chunk.totalChunks,
        chunk_start: chunk.startOffset,
        chunk_end: chunk.endOffset,
        sheet_name: chunk.sheetName,
        row_range: chunk.rowRange,
        // Structural fields (present when the structured chunker ran) - enable
        // structural retrieval: section_id links a chunk to its section and to
        // the Postgres structural map; parent_section_id enables adaptive
        // parent expansion.
        section_id: chunk.sectionId,
        parent_section_id: chunk.parentSectionId,
        heading_path: chunk.headingPath,
        section_number: chunk.sectionNumber,
        section_level: chunk.level,
        // Enforcement labels, resolved from the document's declared
        // classification. Empty => invisible under enforcement (fail closed).
        access_labels: accessLabels,
        // What this chunk is ABOUT and what KIND of document it came from.
        // Filterable, so "risks on Summit" narrows before ranking; and
        // returned with every hit, so the ANSWER can name the project rather
        // than silently blending two registers into one paragraph.
        project: subject.project ?? null,
        collection: subject.collection ?? null,
        // The text itself - what gets returned at query time
        text: chunk.text,
        // Lifecycle
        ingested_at: new Date().toISOString(),
        approval_status: "approved",
      },
    }));

    await this.client.upsert(this.config.collection, { points });
    return points.length;
  }

  async deleteByPath(relativePath: string): Promise<void> {
    await this.client.delete(this.config.collection, {
      filter: {
        must: [{ key: "source_path", match: { value: relativePath } }],
      },
    });
  }

  /**
   * Embed a table's blurb and upsert it as a special point. This is how
   * semantic search discovers structured tables: a query like "risks in
   * Project Summit" matches the blurb's prose, and the payload carries the
   * table_id so the agent knows it can query exact values via the data API.
   *
   * The point id is derived from the table_id so re-ingesting overwrites
   * cleanly rather than duplicating.
   */
  /**
   * Embed a table's discovery blurb and upsert it as a special point. The
   * prose lets semantic search discover the table; the payload carries the
   * table_id so the agent's code can query it via the data API. The point id
   * derives from the table id so re-ingesting overwrites cleanly.
   */
  async writeTableBlurb(params: {
    tableId: string;
    blurb: string;
    sourcePath: string;
    sourceSha: string;
    displayName: string;
    tier: string;
    accessLabels?: string[];
    project?: string | null;
    collection?: string | null;
  }): Promise<void> {
    const [vector] = await embedBatch([params.blurb]);
    await this.client.upsert(this.config.collection, {
      points: [
        {
          id: tableBlurbPointId(params.tableId),
          vector,
          payload: {
            source_path: params.sourcePath,
            source_sha256: params.sourceSha,
            text: params.blurb,
            // Markers that tell the agent this is a structured-table pointer
            has_structured_table: true,
            table_id: params.tableId,
            table_display_name: params.displayName,
            // A blurb is disclosure: column names, complete value domains,
            // observed ranges. It carries the table's labels.
            access_labels: params.accessLabels ?? [],
            // Which project's register this is, and which collection it joins.
            // The agent reads `project` from the PAYLOAD to state it in the
            // answer - it never parses it out of the prose.
            project: params.project ?? null,
            collection: params.collection ?? null,
            tier: params.tier,
            ingested_at: new Date().toISOString(),
            approval_status: "approved",
          },
        },
      ],
    });
  }

  /**
   * Embed a live source's discovery blurb and upsert it as a special point.
   * Mirrors writeTableBlurb: the prose lets semantic search discover the live
   * source; the payload carries the registry id and endpoint so the agent's
   * code can query the source at request time. The point id derives from the
   * live source id so re-ingesting overwrites cleanly.
   */
  async writeLiveSourceBlurb(params: {
    liveSourceId: string;
    blurb: string;
    sourcePath: string;
    name: string;
    endpoint: string;
    lane: string;
    tier: string;
    accessLabels?: string[];
  }): Promise<void> {
    const [vector] = await embedBatch([params.blurb]);
    await this.client.upsert(this.config.collection, {
      points: [
        {
          id: liveSourceBlurbPointId(params.liveSourceId),
          vector,
          payload: {
            source_path: params.sourcePath,
            text: params.blurb,
            // Markers that tell the agent this is a live-source pointer.
            // The endpoint is in the payload for the agent's CODE to read;
            // the LLM only reads `text` (the prose) to judge relevance.
            has_live_source: true,
            live_source_id: params.liveSourceId,
            live_source_name: params.name,
            live_source_endpoint: params.endpoint,
            lane: params.lane,
            access_labels: params.accessLabels ?? [],
            tier: params.tier,
            ingested_at: new Date().toISOString(),
            approval_status: "approved",
          },
        },
      ],
    });
  }
}

function liveSourceBlurbPointId(liveSourceId: string): string {
  const hash = createHash("sha256")
    .update(`live-source-blurb::${liveSourceId}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function tableBlurbPointId(tableId: string): string {
  const hash = createHash("sha256").update(`table-blurb::${tableId}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function makePointId(sourceSha: string, chunkIndex: number): string {
  const hash = createHash("sha256")
    .update(`${sourceSha}::${chunkIndex}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}