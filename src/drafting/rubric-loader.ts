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

/** A rubric file that failed to load, kept so the failure is visible rather
 *  than silent. */
export interface RubricLoadError {
  file: string;
  error: string;
}

let loadErrors: RubricLoadError[] = [];

/** Rubric files that failed to load in the last loadRubrics(). Surfaced (e.g.
 *  to the GUI) so a broken rubric is VISIBLE, not just absent - a document type
 *  silently missing is a worse failure than one flagged as broken. */
export function rubricLoadErrors(): RubricLoadError[] {
  return loadErrors;
}

/**
 * Load all rubrics from the directory into the in-memory cache.
 *
 * RESILIENT by design: a single malformed rubric file is EXCLUDED and recorded,
 * not thrown - it must not take down every other document type. Rubrics are now
 * authored externally (an agent generates them from the QMS), so one bad file
 * would otherwise be a total outage: no rubric served, no generation, no
 * review. The failure is still loud - logged here and exposed via
 * rubricLoadErrors() - so "broken" never looks like "fine".
 *
 * A duplicate documentType is the one hard error kept: two files claiming the
 * same type is ambiguous about which standard governs, and silently picking one
 * would be worse than refusing both.
 */
export function loadRubrics(dir: string = RUBRICS_DIR): Map<string, LoadedRubric> {
  const map = new Map<string, LoadedRubric>();
  const errors: RubricLoadError[] = [];

  if (!existsSync(dir)) {
    console.warn(`Rubrics directory '${dir}' not found - no rubrics loaded.`);
    cache = map;
    loadErrors = errors;
    return map;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    let loaded: LoadedRubric;
    try {
      loaded = loadOne(join(dir, file));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file, error: message });
      console.error(`Rubric '${file}' failed to load and was EXCLUDED:\n${message}`);
      continue;
    }
    const type = loaded.rubric.documentType;
    const existing = map.get(type);
    if (existing) {
      // Ambiguous which standard governs - exclude the later one and flag it.
      const message = `Duplicate document type '${type}' (also in ${existing.sourcePath}); this file was excluded.`;
      errors.push({ file, error: message });
      console.error(message);
      continue;
    }
    map.set(type, loaded);
  }

  cache = map;
  loadErrors = errors;
  console.log(
    `Loaded ${map.size} rubric(s): ${Array.from(map.keys()).join(", ") || "(none)"}` +
      (errors.length ? ` | ${errors.length} EXCLUDED (see errors above)` : ""),
  );
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

/**
 * Drop the in-memory rubric cache so the next read re-reads from disk.
 *
 * Only for when the rubric FILES have genuinely changed underneath us - i.e.
 * pulling a release. Rubrics are otherwise immutable for the life of the
 * process, and that is load-bearing: a run must be judged by one fixed
 * standard, and re-reading mid-run could score two criteria of the same
 * document against two different rubrics.
 */
export function resetRubricCache(): void {
  cache = null;
}

/** List the document types that have a rubric. */
export function listRubricTypes(): string[] {
  if (!cache) loadRubrics();
  return Array.from(cache!.keys());
}

/**
 * A fingerprint of the ENTIRE committed rubric set: sha256 over each
 * documentType and its content hash, in sorted order.
 *
 * This exists to answer "am I editing the same rubrics on these two agents?"
 * with a fact rather than a promise. A group label is a claim an operator
 * types, and a git commit is only HEAD as it was when the process started - it
 * says nothing about a dirty working tree, and two instances running identical
 * code can advertise different commits. This hashes the rubric files the agent
 * actually loaded, so two agents share a fingerprint only if they genuinely
 * serve byte-identical rubrics.
 *
 * It deliberately covers the committed set only. Drafts live in Postgres and
 * are not part of what this identifies.
 */
export function rubricSetHash(): string {
  if (!cache) loadRubrics();
  const parts = Array.from(cache!.entries())
    .map(([type, loaded]) => `${type}:${loaded.contentHash}`)
    .sort();
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/** Total objective weight for a rubric - the denominator of the score. */
export function totalObjectiveWeight(rubric: Rubric): number {
  // Sum of all scoring weight (every non-advisory criterion). The denominator
  // the score fraction is taken over.
  return rubric.criteria
    .filter((c) => c.gate !== "advisory")
    .reduce((sum, c) => sum + c.weight, 0);
}