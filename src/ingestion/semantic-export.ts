// src/ingestion/semantic-export.ts
//
// Exposes the semantic chunker for reuse by the heading-aware chunker, which
// chunks WITHIN each section using the same clean-boundary logic. Kept as a
// thin re-export so the heading chunker doesn't duplicate the boundary logic.
//
// The implementation lives in chunkers.ts; this exports a section-body variant
// that returns plain {text, startOffset, endOffset} pieces (no global index -
// the caller assigns indices and structural fields).

import type { DocumentChunk } from "./types.js";

export interface SemanticOpts {
  targetSize: number;
  minSize: number;
  maxSize: number;
  overlap: number;
}

// Re-export the internal semantic chunker. chunkers.ts exports this under the
// name chunkBySemanticForReuse (added there).
export { chunkBySemanticForReuse as chunkBySemanticExported } from "./chunkers.js";

export type { DocumentChunk };