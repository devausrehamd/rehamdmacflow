// src/identity/classification.ts
//
// Resolves a document's ENFORCEMENT LABELS from its DECLARED CLASSIFICATION.
//
// The indirection is the point. A document declares "Internal" - the business
// vocabulary its authors already use, part of the controlled record, changed
// only through document review. Policy translates that into labels - the
// enforcement vocabulary. A document NEVER names a label directly, because
// renaming a label would then mean re-issuing every controlled document, each
// edit a new revision and a new approval cycle.
//
// This mirrors the user side exactly:
//     user     -> groups          -> labels
//     document -> classification  -> labels
// and the access check is label against label. Neither side knows the other's
// taxonomy.
//
// Precedence, most specific first. The bottom is CLOSED:
//   1. explicit path override      (urgent restriction without re-issuing)
//   2. classification declared in the document
//   3. path default                (legacy documents that declare nothing)
//   4. nothing -> NO LABELS -> invisible to everyone
//
// Rule 4 is not a fallback, it is the design. Qdrant's `must` filter excludes
// points that lack access_labels, so an unclassified document is unreachable
// without any code deciding so.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const schema = z.object({
  policyVersion: z.string().min(1),
  description: z.string().default(""),
  /** Fail ingestion on an unrecognised classification rather than hiding the document. */
  strict: z.boolean().default(true),
  /** Raw declared string (lower-cased) -> canonical classification. Exact match, never fuzzy. */
  aliases: z.record(z.string(), z.string()),
  classifications: z.record(z.string(), z.object({ labels: z.array(z.string()).min(1) })),
  pathDefaults: z
    .array(z.object({ match: z.string().min(1), classification: z.string().min(1) }))
    .default([]),
  overrides: z
    .array(
      z.object({
        path: z.string().min(1),
        classification: z.string().min(1),
        reason: z.string().min(1),
        approvedBy: z.string().optional(),
        approvedAt: z.string().optional(),
      }),
    )
    .default([]),
});

export type ClassificationPolicy = z.infer<typeof schema>;

export interface LoadedClassificationPolicy {
  policy: ClassificationPolicy;
  hash: string;
  sourcePath: string;
}

export class ClassificationError extends Error {
  constructor(
    public readonly code: "unmapped" | "unknown_classification" | "missing_policy",
    message: string,
  ) {
    super(message);
    this.name = "ClassificationError";
  }
}

const POLICY_PATH =
  process.env.QMS_CLASSIFICATION_POLICY ?? "identity/classification-policy.json";

let cache: LoadedClassificationPolicy | null = null;

export function loadClassificationPolicy(
  path: string = POLICY_PATH,
): LoadedClassificationPolicy {
  if (cache && cache.sourcePath === path) return cache;
  if (!existsSync(path)) {
    throw new ClassificationError("missing_policy", `Classification policy not found at '${path}'.`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Classification policy ${path} failed validation:\n${parsed.error.toString()}`);
  }
  cache = {
    policy: parsed.data,
    hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    sourcePath: path,
  };
  return cache;
}

export function resetClassificationPolicy(): void {
  cache = null;
}

/** Which rule produced the labels. Recorded for audit and for the preflight report. */
export type ClassificationRule = "override" | "declared" | "path_default" | "none";

export interface DocumentLabels {
  labels: string[];
  /** Canonical classification, or null when nothing resolved. */
  classification: string | null;
  rule: ClassificationRule;
  /** The raw string found in the document, if any. Kept for diagnostics. */
  declaredRaw?: string;
}

/**
 * Normalise a declared string to a canonical classification via the alias
 * table. EXACT match on the lower-cased, whitespace-collapsed string - never
 * fuzzy. A near-miss must fail loudly, not guess: the legend parser taught
 * this when "Living Document" nearly became the meaning of the Status column.
 * Here a wrong guess grants the wrong people access to a P&L.
 */
function canonicalise(policy: ClassificationPolicy, declared: string): string | null {
  const key = declared.trim().toLowerCase().replace(/\s+/g, " ");
  return policy.aliases[key] ?? null;
}

function labelsFor(policy: ClassificationPolicy, classification: string): string[] {
  const entry = policy.classifications[classification];
  if (!entry) {
    throw new ClassificationError(
      "unknown_classification",
      `Classification '${classification}' has no label mapping. Known: ${Object.keys(policy.classifications).join(", ")}`,
    );
  }
  return [...entry.labels].sort();
}

/**
 * Resolve the enforcement labels for one document.
 *
 * `declaredRaw` is whatever the document itself said (an xlsx Metadata sheet's
 * Classification field, markdown frontmatter, docx core properties). Pass
 * undefined when the format offers nothing.
 */
export function resolveDocumentLabels(
  sourcePath: string,
  declaredRaw?: string | null,
  loaded: LoadedClassificationPolicy = loadClassificationPolicy(),
): DocumentLabels {
  const { policy } = loaded;

  // 1. Explicit override - restrict urgently without re-issuing the document.
  const override = policy.overrides.find((o) => o.path === sourcePath);
  if (override) {
    return {
      labels: labelsFor(policy, override.classification),
      classification: override.classification,
      rule: "override",
      declaredRaw: declaredRaw ?? undefined,
    };
  }

  // 2. What the document declares about itself.
  if (declaredRaw && declaredRaw.trim().length > 0) {
    const canonical = canonicalise(policy, declaredRaw);
    if (canonical) {
      return {
        labels: labelsFor(policy, canonical),
        classification: canonical,
        rule: "declared",
        declaredRaw,
      };
    }
    // A classification we do not recognise. Under fail-closed this silently
    // hides the document, so a typo must be loud - or fatal in strict mode.
    const message =
      `Document '${sourcePath}' declares classification "${declaredRaw}" which is not in the alias ` +
      `table. Under fail-closed enforcement this document would be invisible to everyone. ` +
      `Add an alias to identity/classification-policy.json.`;
    if (policy.strict) throw new ClassificationError("unmapped", message);
    console.warn(`  [classification] ${message}`);
  }

  // 3. Path default - legacy documents that declare nothing.
  const def = policy.pathDefaults.find((d) => sourcePath.includes(d.match));
  if (def) {
    return {
      labels: labelsFor(policy, def.classification),
      classification: def.classification,
      rule: "path_default",
      declaredRaw: declaredRaw ?? undefined,
    };
  }

  // 4. Nothing resolved. No labels. Invisible.
  return {
    labels: [],
    classification: null,
    rule: "none",
    declaredRaw: declaredRaw ?? undefined,
  };
}

/** Does the caller's label set grant access to this artifact's labels? */
export function labelsIntersect(artifactLabels: string[], callerLabels: string[]): boolean {
  if (artifactLabels.length === 0 || callerLabels.length === 0) return false;
  return artifactLabels.some((l) => callerLabels.includes(l));
}