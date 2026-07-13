// src/ingestion/sections-writer.ts
//
// Writes the structural map (parsed sections) to Postgres document_sections.
// Called during ingestion when the structured chunker runs. On re-ingest of a
// document, prior sections for that document_key are deleted first so the map
// stays in sync (supersession - no orphaned sections).

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { document_sections, type NewDocumentSection } from "../db/schema.js";
import type { ParsedSection } from "./heading-chunker.js";

export async function writeSections(
  sections: ParsedSection[],
  sourcePath: string,
): Promise<number> {
  if (sections.length === 0) return 0;

  const documentKey = sections[0].documentKey;

  // Supersede: clear this document's prior sections before writing the new map.
  await db.delete(document_sections).where(eq(document_sections.document_key, documentKey));

  const rows: NewDocumentSection[] = sections.map((s) => ({
    section_id: s.sectionId,
    document_key: s.documentKey,
    parent_section_id: s.parentSectionId,
    level: s.level,
    section_number: s.sectionNumber,
    heading_text: s.headingText,
    heading_path: s.headingPath,
    order_index: s.orderIndex,
    source_path: sourcePath,
  }));

  // Insert in batches to be safe with large documents.
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await db.insert(document_sections).values(batch);
    written += batch.length;
  }
  return written;
}