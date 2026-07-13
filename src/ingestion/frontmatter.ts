// src/ingestion/frontmatter.ts
//
// Minimal YAML-frontmatter reader. Deliberately not a YAML parser: we need
// exactly one thing from it - the document's declared classification - and a
// full YAML dependency would be a large attack surface for a small need.
//
// Handles the shape markdown documents actually use:
//
//     ---
//     title: CAPA Procedure
//     classification: Internal
//     ---
//
// Anything more elaborate (nested maps, lists, anchors) is ignored rather
// than half-parsed. If a document's classification is not a simple scalar on
// its own line, it does not declare one, and fail-closed handles the rest.

const FENCE = /^---\s*$/;
const CLASSIFICATION_KEY_RE = /^(classification|security[-_ ]?classification|sensitivity)$/i;

export interface Frontmatter {
  /** Raw key/value scalars found between the fences. */
  fields: Record<string, string>;
  /** The document body with the frontmatter block removed. */
  body: string;
  /** The declared classification, if the block named one. */
  declaredClassification: string | null;
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const lines = markdown.split("\n");

  // The opening fence must be the very first non-empty line.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !FENCE.test(lines[i])) {
    return { fields: {}, body: markdown, declaredClassification: null };
  }

  const start = i;
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (FENCE.test(lines[j])) {
      end = j;
      break;
    }
  }
  // Unterminated block: treat the whole file as body rather than guessing.
  if (end === -1) {
    return { fields: {}, body: markdown, declaredClassification: null };
  }

  const fields: Record<string, string> = {};
  let declaredClassification: string | null = null;

  for (let j = start + 1; j < end; j++) {
    const line = lines[j];
    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (key.length === 0 || value.length === 0) continue;

    // Strip surrounding quotes; leave the value otherwise verbatim so the
    // alias table matches on exactly what the author wrote.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    fields[key] = value;
    if (CLASSIFICATION_KEY_RE.test(key)) declaredClassification = value;
  }

  return {
    fields,
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
    declaredClassification,
  };
}