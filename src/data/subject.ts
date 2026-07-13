// src/data/subject.ts
//
// Resolves what a document is ABOUT (its project) and what KIND of form it is
// (its collection), from what the document declares about itself.
//
// Both matter for correctness, not tidiness:
//
//   PROJECT     scopes a prerequisite. "Is there an approved risk register?"
//               is the wrong question. "For RC4?" is the right one. Without a
//               project, an approved register for Denali would satisfy a DFMEA
//               for Summit - silently, and in the permissive direction.
//
//   COLLECTION  enables ENUMERATION. "All risk registers" is a set membership
//               query over the registry, not a top-K vector search. Retrieval
//               discovers that a kind of thing exists; the registry enumerates
//               which ones.
//
// Resolution is EXACT alias match on word boundaries. Never fuzzy, and an
// ambiguous match throws rather than picking. Same discipline as the
// classification aliases and the document-type aliases: a near-miss must fail
// loudly, because a wrong binding here is invisible in the output.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const schema = z.object({
  registryVersion: z.string().min(1),
  description: z.string().default(""),
  projects: z.record(
    z.string(),
    z.object({ displayName: z.string().min(1), aliases: z.array(z.string()).default([]) }),
  ),
  collections: z.record(
    z.string(),
    z.object({
      displayName: z.string().min(1),
      aliases: z.array(z.string()).default([]),
      schemaContract: z
        .object({ requiredColumns: z.array(z.string()).default([]), reason: z.string().default("") })
        .optional(),
    }),
  ),
});

export type SubjectRegistry = z.infer<typeof schema>;

export interface LoadedSubjectRegistry {
  registry: SubjectRegistry;
  hash: string;
  sourcePath: string;
}

export class SubjectError extends Error {
  constructor(
    public readonly code: "ambiguous_project" | "ambiguous_collection" | "missing_registry",
    message: string,
  ) {
    super(message);
    this.name = "SubjectError";
  }
}

const REGISTRY_PATH = process.env.QMS_SUBJECT_REGISTRY ?? "registry/subjects.json";
let cache: LoadedSubjectRegistry | null = null;

export function loadSubjectRegistry(path: string = REGISTRY_PATH): LoadedSubjectRegistry {
  if (cache && cache.sourcePath === path) return cache;
  if (!existsSync(path)) {
    throw new SubjectError("missing_registry", `Subject registry not found at '${path}'.`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Subject registry ${path} failed validation:\n${parsed.error.toString()}`);
  }
  cache = {
    registry: parsed.data,
    hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    sourcePath: path,
  };
  return cache;
}

export function resetSubjectRegistry(): void {
  cache = null;
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Metadata keys that may name the project this document belongs to. */
const PROJECT_KEYS = /^(project|programme|program|product|subject|title)$/i;
/** Metadata keys that may name the KIND of document this is. */
const COLLECTION_KEYS = /^(document\s*id|form|template|type|title)$/i;

/**
 * Find every canonical id whose alias appears, on word boundaries, in any of
 * the candidate values. Returns the distinct ids matched.
 */
function matchAliases(
  values: string[],
  entries: Record<string, { aliases: string[] }>,
): string[] {
  const haystacks = values.map((v) => ` ${normalise(v)} `);
  const hits = new Set<string>();

  for (const [id, entry] of Object.entries(entries)) {
    const aliases = [id, ...entry.aliases].map(normalise).filter((a) => a.length > 0);
    for (const alias of aliases) {
      if (haystacks.some((h) => h.includes(` ${alias} `))) {
        hits.add(id);
        break;
      }
    }
  }
  return [...hits];
}

function valuesFor(fields: Record<string, string>, keyRe: RegExp): string[] {
  return Object.entries(fields)
    .filter(([k]) => keyRe.test(k.trim()))
    .map(([, v]) => v)
    .filter((v) => v.trim().length > 0);
}

export interface ResolvedSubject {
  /** Canonical project id, or null when the document names none. */
  project: string | null;
  /** Canonical collection id, or null. */
  collection: string | null;
  registryVersion: string;
  registryHash: string;
}

/**
 * Resolve project and collection from a document's declared metadata fields.
 *
 * `fields` is the raw key/value map from the document's own metadata (an xlsx
 * Metadata sheet, markdown frontmatter). Nothing is inferred from the file
 * path - a document moved between folders must not change project.
 *
 * Ambiguity THROWS. Two projects named in one document is an authoring error,
 * and guessing which one would bind the document to the wrong prerequisite.
 */
export function resolveSubject(
  fields: Record<string, string>,
  loaded: LoadedSubjectRegistry = loadSubjectRegistry(),
): ResolvedSubject {
  const { registry } = loaded;

  const projectHits = matchAliases(valuesFor(fields, PROJECT_KEYS), registry.projects);
  if (projectHits.length > 1) {
    throw new SubjectError(
      "ambiguous_project",
      `Document names more than one project (${projectHits.join(", ")}). Guessing would bind it ` +
        `to the wrong prerequisite and pollute every cross-project aggregate.`,
    );
  }

  const collectionHits = matchAliases(valuesFor(fields, COLLECTION_KEYS), registry.collections);
  if (collectionHits.length > 1) {
    throw new SubjectError(
      "ambiguous_collection",
      `Document matches more than one collection (${collectionHits.join(", ")}).`,
    );
  }

  return {
    project: projectHits[0] ?? null,
    collection: collectionHits[0] ?? null,
    registryVersion: registry.registryVersion,
    registryHash: loaded.hash,
  };
}

/** Columns every member of a collection must have to be unioned. */
export function schemaContractFor(collection: string): string[] {
  const { registry } = loadSubjectRegistry();
  return registry.collections[collection]?.schemaContract?.requiredColumns ?? [];
}

export function projectDisplayName(project: string): string {
  const { registry } = loadSubjectRegistry();
  return registry.projects[project]?.displayName ?? project;
}