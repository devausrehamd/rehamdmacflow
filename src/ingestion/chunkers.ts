// Chunking strategies.
//
// ============================================================================
// SEMANTIC CHUNKING (default for prose documents)
// ============================================================================
//
// Why semantic chunking matters for generation quality:
//
// The naive approach is character-window chunking — split every N characters,
// regardless of what falls at the boundary. It's simple but produces chunks
// that are cut mid-sentence and sometimes mid-word. Two real consequences:
//
// 1. Embedding quality degrades. Embedding models are trained on coherent
//    text. Feeding them a chunk that starts with "...gistration..." produces
//    a less meaningful vector than feeding them a complete sentence. The
//    similarity score during retrieval becomes noisier.
//
// 2. Generation quality degrades sharply. When the LLM is given retrieved
//    chunks and asked to synthesize a draft, mid-sentence cuts confuse it.
//    The model has to guess what was on either side. It often produces
//    text that echoes the truncation ("the document tracks ate fields...")
//    or hedges to hide its uncertainty. Even when the model handles it
//    correctly, the chunk text shows up verbatim in audit traces — and
//    "ate fields including risk identifier" looks unprofessional in an
//    auditable QMS workflow.
//
// Semantic chunking fixes both by splitting at natural language boundaries:
// paragraph breaks first, then sentence ends, then clause breaks, then
// word breaks, with a hard character cut only as last resort. The chunker
// has a target size but a flexible range — chunks are between minSize and
// maxSize, and within that range the chunker picks the cleanest available
// break.
//
// What you get visibly: chunks that read like coherent passages. What you
// get measurably: better retrieval scores on semantically-phrased queries
// and noticeably more fluent generated drafts. Worth the extra ~80 lines
// of code.
//
// ============================================================================
// TABULAR CHUNKING (used for spreadsheets)
// ============================================================================
//
// Spreadsheets don't have sentences. They have rows and columns. The tabular
// chunker groups rows into fixed-size batches and repeats the header row at
// the top of each chunk so the model knows what each column means even if
// retrieval returns a chunk from the middle of a sheet.
// ============================================================================

import type {
  ConvertedDocument,
  DocumentChunk,
  ChunkingConfig,
} from "./types.js";
import { chunkByHeadings, type ParsedSection } from "./heading-chunker.js";

/**
 * Chunk a document, returning chunks AND (for the structured strategy) the
 * parsed section map. For non-structured strategies, sections is empty.
 *
 * The pipeline uses this so it can write the section map to Postgres when the
 * structured strategy is active.
 */
export function chunkDocumentStructured(
  doc: ConvertedDocument,
  config: ChunkingConfig,
): { chunks: DocumentChunk[]; sections: ParsedSection[] } {
  const ext = doc.sourceFile.extension;
  const strategy = config.perFileType[ext] ?? config.default;

  if (strategy.strategy === "structured") {
    const size = strategy.size ?? 800;
    const result = chunkByHeadings(doc.markdown, doc.sourceFile.sha256, {
      targetSize: size,
      minSize: Math.floor(size * 0.5),
      maxSize: Math.floor(size * 1.5),
      overlap: strategy.overlap ?? 100,
    });
    return { chunks: result.chunks, sections: result.sections };
  }

  // Non-structured strategies produce no section map.
  return { chunks: chunkDocument(doc, config), sections: [] };
}

export function chunkDocument(
  doc: ConvertedDocument,
  config: ChunkingConfig,
): DocumentChunk[] {
  const ext = doc.sourceFile.extension;
  const strategy = config.perFileType[ext] ?? config.default;

  switch (strategy.strategy) {
    case "characters":
      // The character-window chunker is kept for backwards compatibility
      // but should not be the default. Use "semantic" for prose.
      return chunkByCharacters(
        doc.markdown,
        strategy.size ?? 800,
        strategy.overlap ?? 100,
      );
    case "semantic":
      return chunkBySemantic(doc.markdown, {
        targetSize: strategy.size ?? 800,
        minSize: Math.floor((strategy.size ?? 800) * 0.5),
        maxSize: Math.floor((strategy.size ?? 800) * 1.5),
        overlap: strategy.overlap ?? 100,
      });
    case "structured":
      // When called through the plain chunkDocument path, return just the
      // chunks (sections are available via chunkDocumentStructured).
      return chunkByHeadings(doc.markdown, doc.sourceFile.sha256, {
        targetSize: strategy.size ?? 800,
        minSize: Math.floor((strategy.size ?? 800) * 0.5),
        maxSize: Math.floor((strategy.size ?? 800) * 1.5),
        overlap: strategy.overlap ?? 100,
      }).chunks;
    case "tabular":
      return chunkTabular(
        doc.markdown,
        strategy.rowsPerChunk ?? 50,
        strategy.repeatHeaders !== false,
      );
    default:
      throw new Error(`Unknown chunking strategy: ${strategy.strategy}`);
  }
}

// ----------------------------------------------------------------------------
// Semantic chunking
// ----------------------------------------------------------------------------

interface SemanticOptions {
  targetSize: number;
  minSize: number;
  maxSize: number;
  overlap: number;
}

/**
 * Reusable entry point for the semantic chunker, used by the heading-aware
 * chunker to chunk within a section's body with the same clean-boundary logic.
 */
export function chunkBySemanticForReuse(
  text: string,
  opts: SemanticOptions,
): DocumentChunk[] {
  return chunkBySemantic(text, opts);
}

/**
 * Split prose text into chunks that respect natural language boundaries.
 *
 * Boundary preference order (best to worst):
 *   1. Paragraph break (blank line)
 *   2. Heading start (markdown headers - prefer break BEFORE so headers
 *      lead their content)
 *   3. Sentence end (period/!/? followed by whitespace)
 *   4. Clause break (comma/semicolon/colon followed by whitespace)
 *   5. Word boundary (any whitespace)
 *   6. Hard character cut (last resort)
 *
 * The chunker searches within [minSize, maxSize] for the best available
 * boundary nearest to targetSize. If nothing better than a hard cut is
 * found in that window, it cuts at targetSize - which is rare in practice
 * because prose almost always has at least word boundaries.
 *
 * Overlap is achieved by starting the next chunk at a sentence boundary
 * roughly `overlap` characters before the previous chunk ended. This means
 * the overlap region is itself coherent text, not a partial sentence.
 */
function chunkBySemantic(text: string, opts: SemanticOptions): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let position = 0;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return chunks;
  }

  // If the whole document fits in a single chunk, don't split at all
  if (trimmed.length <= opts.maxSize) {
    return [
      {
        text: trimmed,
        index: 0,
        totalChunks: 1,
        startOffset: 0,
        endOffset: trimmed.length,
      },
    ];
  }

  while (position < trimmed.length) {
    // If what remains is small enough, emit it as the final chunk
    if (trimmed.length - position <= opts.maxSize) {
      chunks.push({
        text: trimmed.slice(position).trim(),
        index: chunks.length,
        totalChunks: 0, // filled after the loop
        startOffset: position,
        endOffset: trimmed.length,
      });
      break;
    }

    // Find the best break point within the window
    const searchStart = position + opts.minSize;
    const searchEnd = Math.min(position + opts.maxSize, trimmed.length);
    const preferredEnd = position + opts.targetSize;
    const breakPoint = findBestBreakPoint(
      trimmed,
      searchStart,
      searchEnd,
      preferredEnd,
    );

    chunks.push({
      text: trimmed.slice(position, breakPoint).trim(),
      index: chunks.length,
      totalChunks: 0,
      startOffset: position,
      endOffset: breakPoint,
    });

    // Determine where the next chunk should start. We want overlap, but the
    // overlap should itself start at a clean sentence boundary so the
    // overlapping text reads coherently.
    position = findOverlapStart(trimmed, breakPoint, opts.overlap);

    // Defensive: ensure we make forward progress even if findOverlapStart
    // returns something unexpected
    if (position >= breakPoint) {
      position = breakPoint;
    }
  }

  // Fill in totalChunks
  const total = chunks.length;
  return chunks.map((c) => ({ ...c, totalChunks: total }));
}

/**
 * Search for the best boundary in [searchStart, searchEnd], preferring
 * boundaries near `preferred`. Returns the position to cut at.
 *
 * Priority is paragraph > heading > sentence > clause > word > hard cut.
 * Within each priority, we pick the candidate nearest to `preferred`.
 */
function findBestBreakPoint(
  text: string,
  searchStart: number,
  searchEnd: number,
  preferred: number,
): number {
  const window = text.slice(searchStart, searchEnd);

  // 1. Paragraph breaks (one or more consecutive newlines that separate text)
  // Capture position AFTER the break so the next chunk starts with real content
  const paragraphPositions = collectMatches(window, /\n[ \t]*\n+/g, searchStart, "after");
  if (paragraphPositions.length > 0) {
    return closest(paragraphPositions, preferred);
  }

  // 2. Heading starts. Prefer to break BEFORE a heading so the heading
  // leads its content in the next chunk. Markdown headings start at line
  // beginnings.
  const headingPositions = collectMatches(window, /\n(?=#{1,6} )/g, searchStart, "after");
  if (headingPositions.length > 0) {
    return closest(headingPositions, preferred);
  }

  // 3. Sentence ends: . ! or ? followed by whitespace
  const sentencePositions = collectMatches(window, /[.!?]\s+/g, searchStart, "after");
  if (sentencePositions.length > 0) {
    return closest(sentencePositions, preferred);
  }

  // 4. Clause breaks: , ; or : followed by whitespace
  const clausePositions = collectMatches(window, /[,;:]\s+/g, searchStart, "after");
  if (clausePositions.length > 0) {
    return closest(clausePositions, preferred);
  }

  // 5. Word boundaries: any whitespace
  const wordPositions = collectMatches(window, /\s+/g, searchStart, "after");
  if (wordPositions.length > 0) {
    return closest(wordPositions, preferred);
  }

  // 6. Hard cut. Only reached for pathological text without any whitespace
  // in a 400-character span - effectively never happens for real prose.
  return preferred;
}

/**
 * Find a good starting position for the next chunk, ~overlap characters
 * before `chunkEnd`, biased toward sentence boundaries so the overlap
 * reads as coherent prose.
 */
function findOverlapStart(
  text: string,
  chunkEnd: number,
  targetOverlap: number,
): number {
  const idealStart = Math.max(0, chunkEnd - targetOverlap);
  // Look in a window around idealStart for a sentence boundary
  const windowStart = Math.max(0, idealStart - 80);
  const windowEnd = Math.min(text.length, idealStart + 80);
  const window = text.slice(windowStart, windowEnd);

  // Prefer the sentence boundary closest to idealStart
  const sentenceMatches = [...window.matchAll(/[.!?]\s+/g)];
  if (sentenceMatches.length > 0) {
    const positions = sentenceMatches.map(
      (m) => windowStart + m.index! + m[0].length,
    );
    return closest(positions, idealStart);
  }

  // Fall back to a word boundary near idealStart
  const wordMatches = [...window.matchAll(/\s+/g)];
  if (wordMatches.length > 0) {
    const positions = wordMatches.map(
      (m) => windowStart + m.index! + m[0].length,
    );
    return closest(positions, idealStart);
  }

  return idealStart;
}

function collectMatches(
  text: string,
  pattern: RegExp,
  offset: number,
  position: "before" | "after",
): number[] {
  const results: number[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    results.push(
      offset + match.index + (position === "after" ? match[0].length : 0),
    );
  }
  return results;
}

function closest(candidates: number[], target: number): number {
  return candidates.reduce((best, c) =>
    Math.abs(c - target) < Math.abs(best - target) ? c : best,
  );
}

// ----------------------------------------------------------------------------
// Character-window chunking (legacy / fallback)
// ----------------------------------------------------------------------------

/**
 * Naive fixed-window chunker. Cuts at character boundaries regardless of
 * sentence structure. Produces ugly truncation but is deterministic and
 * simple. Kept available for cases where you specifically want fixed-size
 * chunks, but prefer "semantic" for prose.
 */
function chunkByCharacters(
  text: string,
  size: number,
  overlap: number,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const step = size - overlap;
  let index = 0;

  for (let i = 0; i < text.length; i += step) {
    const end = Math.min(i + size, text.length);
    chunks.push({
      text: text.slice(i, end),
      index: index++,
      totalChunks: 0,
      startOffset: i,
      endOffset: end,
    });
    if (end >= text.length) break;
  }

  return chunks.map((c) => ({ ...c, totalChunks: chunks.length }));
}

// ----------------------------------------------------------------------------
// Tabular chunking (for spreadsheets)
// ----------------------------------------------------------------------------

/**
 * Tabular chunking: splits a markdown document containing one or more
 * "# Sheet: <name>" sections (each with a markdown table) into row-grouped
 * chunks. The header row is repeated at the top of each chunk so that
 * downstream retrieval gets context about what the columns mean even when
 * a chunk lands mid-table.
 *
 * Each chunk carries sheet_name and row_range in its metadata, which gives
 * the retriever fine-grained provenance: "this content came from rows
 * 51-100 of the Risk_Register sheet."
 */
function chunkTabular(
  markdown: string,
  rowsPerChunk: number,
  repeatHeaders: boolean,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const sheetSections = markdown.split(/^# Sheet: /m).filter((s) => s.trim());

  for (const section of sheetSections) {
    const firstNewline = section.indexOf("\n");
    const sheetName = section.slice(0, firstNewline).trim();
    const body = section.slice(firstNewline + 1);

    const lines = body.split("\n");
    let tableStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("|")) {
        tableStart = i;
        break;
      }
    }

    if (tableStart === -1) {
      chunks.push({
        text: `# Sheet: ${sheetName}\n\n${body}`,
        index: chunks.length,
        totalChunks: 0,
        sheetName,
      });
      continue;
    }

    const preamble = lines.slice(0, tableStart).join("\n").trim();
    const headerLines = lines.slice(tableStart, tableStart + 2).join("\n");
    const dataLines = lines
      .slice(tableStart + 2)
      .filter((l) => l.startsWith("|"));

    if (dataLines.length === 0) {
      chunks.push({
        text: `# Sheet: ${sheetName}\n\n${preamble}\n\n${headerLines}`,
        index: chunks.length,
        totalChunks: 0,
        sheetName,
        rowRange: [0, 0],
      });
      continue;
    }

    for (let i = 0; i < dataLines.length; i += rowsPerChunk) {
      const rowSlice = dataLines.slice(i, i + rowsPerChunk);
      const parts = [
        `# Sheet: ${sheetName}`,
        preamble,
        `> Rows ${i + 1}-${Math.min(i + rowsPerChunk, dataLines.length)} of ${dataLines.length}`,
      ];
      if (repeatHeaders) {
        parts.push(headerLines);
      }
      parts.push(rowSlice.join("\n"));

      chunks.push({
        text: parts.filter(Boolean).join("\n\n"),
        index: chunks.length,
        totalChunks: 0,
        sheetName,
        rowRange: [i + 1, Math.min(i + rowsPerChunk, dataLines.length)],
      });
    }
  }

  return chunks.map((c) => ({ ...c, totalChunks: chunks.length }));
}