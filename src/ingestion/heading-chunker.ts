// src/ingestion/heading-chunker.ts
//
// Heading-aware ("structured") chunking. Parses a markdown document's heading
// hierarchy, chunks WITHIN the deepest sections, and tags every chunk with its
// structural identity (heading path, section id, parent section id, level).
//
// This is what enables structural retrieval downstream: because every chunk
// knows its section and parent, retrieval can expand a matched chunk to its
// whole section, and adaptively roll up to the parent when multiple sibling
// subsections hit. See docs/retrieval-structure.md for the full design.
//
// Deterministic. No LLM. The heading path is FACTUAL (the document's own
// structure), not interpreted - so it can be safely embedded and stored.
//
// Two outputs:
//   - chunks (with structural fields) -> embedded + written to Qdrant
//   - sections (the structural map)   -> written to Postgres (document_sections)

import { createHash } from "node:crypto";
import { chunkBySemanticExported } from "./semantic-export.js";
import type { DocumentChunk } from "./types.js";

export interface ParsedSection {
  sectionId: string;
  parentSectionId: string | null;
  documentKey: string; // stable per-document key (e.g. source path or sha)
  level: number; // heading depth 1-6
  sectionNumber: string | null; // "4.3.1" if the heading is numbered
  headingText: string; // "Design Verification"
  headingPath: string; // "4 Controls > 4.3 Verification > 4.3.1 Methods"
  orderIndex: number; // position in document order
}

export interface StructuredChunkResult {
  chunks: DocumentChunk[];
  sections: ParsedSection[];
}

interface HeadingNode {
  level: number;
  raw: string; // full heading line text after the #'s
  number: string | null;
  text: string; // heading text without the number
  startLine: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// Leading numbered label like "4.3.1", "4.3.1.", "4.3.1)" possibly with trailing sep
const NUMBER_RE = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/;

function sectionIdOf(documentKey: string, headingPath: string): string {
  return createHash("sha256")
    .update(`${documentKey}::${headingPath}`)
    .digest("hex")
    .slice(0, 32);
}

function parseHeadingLine(line: string): HeadingNode | null {
  const m = line.match(HEADING_RE);
  if (!m) return null;
  const level = m[1].length;
  const raw = m[2].trim();
  const numMatch = raw.match(NUMBER_RE);
  if (numMatch) {
    return { level, raw, number: numMatch[1], text: numMatch[2].trim(), startLine: 0 };
  }
  return { level, raw, number: null, text: raw, startLine: 0 };
}

/**
 * Parse the document into a flat list of sections in document order, each
 * with its heading path derived from the heading stack, plus the body text
 * belonging to that section (text up to the next heading of any level).
 */
function parseSections(
  markdown: string,
  documentKey: string,
): { section: ParsedSection; body: string }[] {
  const lines = markdown.split("\n");
  const out: { section: ParsedSection; body: string }[] = [];
  const stack: HeadingNode[] = []; // current ancestor headings
  let orderIndex = 0;

  // Text before the first heading becomes a synthetic "preamble" section at
  // level 0 so nothing is lost.
  let currentBody: string[] = [];
  let currentHeadings: HeadingNode[] | null = null;

  const flush = () => {
    const body = currentBody.join("\n").trim();
    if (currentHeadings === null) {
      // preamble (no heading yet)
      if (body.length === 0) return;
      const headingPath = "(preamble)";
      const sectionId = sectionIdOf(documentKey, headingPath);
      out.push({
        section: {
          sectionId,
          parentSectionId: null,
          documentKey,
          level: 0,
          sectionNumber: null,
          headingText: "(preamble)",
          headingPath,
          orderIndex: orderIndex++,
        },
        body,
      });
      return;
    }
    const path = currentHeadings
      .map((h) => (h.number ? `${h.number} ${h.text}` : h.text))
      .join(" > ");
    const sectionId = sectionIdOf(documentKey, path);
    const parentPath =
      currentHeadings.length > 1
        ? currentHeadings
            .slice(0, -1)
            .map((h) => (h.number ? `${h.number} ${h.text}` : h.text))
            .join(" > ")
        : null;
    const parentSectionId = parentPath ? sectionIdOf(documentKey, parentPath) : null;
    const leaf = currentHeadings[currentHeadings.length - 1];
    out.push({
      section: {
        sectionId,
        parentSectionId,
        documentKey,
        level: leaf.level,
        sectionNumber: leaf.number,
        headingText: leaf.text,
        headingPath: path,
        orderIndex: orderIndex++,
      },
      body,
    });
  };

  for (const line of lines) {
    const heading = parseHeadingLine(line);
    if (heading) {
      // close the current section
      flush();
      currentBody = [];
      // update the ancestor stack: pop headings of >= this level
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
        stack.pop();
      }
      stack.push(heading);
      currentHeadings = [...stack];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return out;
}

/**
 * Heading-aware chunking. Splits by section, then chunks within each section's
 * body (so large sections still become multiple chunks, but every chunk keeps
 * its section identity). Emits chunks (structural fields set, heading path
 * PREPENDED to the embedded text for findability) and the section map.
 */
export function chunkByHeadings(
  markdown: string,
  documentKey: string,
  opts: { targetSize: number; minSize: number; maxSize: number; overlap: number },
): StructuredChunkResult {
  const parsed = parseSections(markdown, documentKey);
  const chunks: DocumentChunk[] = [];
  const sections: ParsedSection[] = parsed.map((p) => p.section);

  let globalIndex = 0;

  for (const { section, body } of parsed) {
    if (body.trim().length === 0) continue;

    // Chunk within the section body. Reuse the semantic chunker for clean
    // boundaries, then stamp each resulting chunk with this section's identity.
    const bodyChunks = chunkBySemanticExported(body, opts);

    for (const bc of bodyChunks) {
      // Prepend the heading path to the EMBEDDED text (findability). This is
      // factual document structure, safe to embed.
      const prefixed =
        section.level > 0
          ? `[${section.headingPath}]\n\n${bc.text}`
          : bc.text;

      chunks.push({
        ...bc,
        text: prefixed,
        index: globalIndex++,
        totalChunks: 0,
        sectionId: section.sectionId,
        parentSectionId: section.parentSectionId,
        headingPath: section.headingPath,
        sectionNumber: section.sectionNumber,
        headingText: section.headingText,
        level: section.level,
      });
    }
  }

  const total = chunks.length;
  return {
    chunks: chunks.map((c) => ({ ...c, totalChunks: total })),
    sections,
  };
}