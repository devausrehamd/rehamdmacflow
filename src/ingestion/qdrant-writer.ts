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
    // Create payload indexes for fields we filter on. This is domain specific
    // but generally we want to index anything we might use as a filter in a query.

    const indexedFields: Array<[string, "keyword"]> = [
      ["source_path", "keyword"],
      ["source_extension", "keyword"],
      ["approval_status", "keyword"],
      ["sheet_name", "keyword"],
    ];
    for (const [field, schema] of indexedFields) {
      try {
        await this.client.createPayloadIndex(this.config.collection, {
          field_name: field,
          field_schema: schema,
        });
      } catch (err) {
        // Index may already exist — that's fine
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("already exists")) {
          console.warn(`Could not create index on ${field}: ${message}`);
        }
      }
    }
  }

  async writeDocument(doc: ConvertedDocument, chunks: DocumentChunk[]): Promise<number> {
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