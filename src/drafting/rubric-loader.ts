// src/drafting/rubric-loader.ts
//
// Loads rubric JSON files from the rubrics/ directory, validates them, and
// resolves a rubric by document type. Each rubric is stamped with a content
// hash (sha256 of the raw file) so every evaluation records the exact rubric
// version that governed it - the audit anchor.
//
// Git is the source of truth for rubric content. This loader reads the files
// at startup and caches them in memory. Optionally, loadRubricsToDb() can
// snapshot the loaded rubrics into Postgres for runtime querying, but the
// files remain authoritative.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rubricSchema, type LoadedRubric, type Rubric } from "./rubric-schema.js";

const RUBRICS_DIR = process.env.QMS_RUBRICS_DIR ?? "rubrics";

// documentType -> LoadedRubric
let cache: Map<string, LoadedRubric> | null = null;

function contentHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Read, validate, and hash a single rubric file. */
function loadOne(path: string): LoadedRubric {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Rubric ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  const result = rubricSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Rubric ${path} failed validation:\n${result.error.toString()}`);
  }

  // Sanity: filename-vs-documentType agreement is a common human slip
  const rubric: Rubric = result.data;

  return {
    rubric,
    contentHash: contentHash(raw),
    sourcePath: path,
  };
}

/** Load all rubrics from the directory into the in-memory cache. */
export function loadRubrics(dir: string = RUBRICS_DIR): Map<string, LoadedRubric> {
  const map = new Map<string, LoadedRubric>();

  if (!existsSync(dir)) {
    console.warn(`Rubrics directory '${dir}' not found - no rubrics loaded.`);
    cache = map;
    return map;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const loaded = loadOne(join(dir, file));
    const type = loaded.rubric.documentType;
    if (map.has(type)) {
      throw new Error(
        `Duplicate rubric for document type '${type}' (${file} and ${map.get(type)!.sourcePath})`,
      );
    }
    map.set(type, loaded);
  }

  cache = map;
  console.log(`Loaded ${map.size} rubric(s): ${Array.from(map.keys()).join(", ") || "(none)"}`);
  return map;
}

/** Resolve the rubric governing a document type. Loads on first use. */
export function getRubric(documentType: string): LoadedRubric {
  if (!cache) loadRubrics();
  const loaded = cache!.get(documentType);
  if (!loaded) {
    const known = Array.from(cache!.keys()).join(", ") || "(none)";
    throw new Error(`No rubric found for document type '${documentType}'. Known types: ${known}`);
  }
  return loaded;
}

/** List the document types that have a rubric. */
export function listRubricTypes(): string[] {
  if (!cache) loadRubrics();
  return Array.from(cache!.keys());
}

/** Total objective weight for a rubric - the denominator of the score. */
export function totalObjectiveWeight(rubric: Rubric): number {
  // Sum of all scoring weight (every non-advisory criterion). The denominator
  // the score fraction is taken over.
  return rubric.criteria
    .filter((c) => c.gate !== "advisory")
    .reduce((sum, c) => sum + c.weight, 0);
}