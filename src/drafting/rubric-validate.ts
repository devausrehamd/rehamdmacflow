// src/drafting/rubric-validate.ts
//
// Validate a proposed rubric before it can be exported to git.
//
// Today this is SCHEMA + STRUCTURAL validation: does it parse, do the weights
// make sense, are aliases unique against the committed set, do patterns compile.
// This is the floor - "well-formed", not "good".
//
// TOMORROW'S SEAM: "does this rubric work as intended, is it high-standard" is a
// deeper question - backtest it against approved historical documents and check
// it agrees with past human decisions. That harness will hang off this same
// function (an additional check block). For now the seam is explicit and the
// floor is honest about being a floor.

import { rubricSchema } from "./rubric-schema.js";
import { listRubricTypes, getRubric } from "./rubric-loader.js";

export interface RubricValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface RubricValidationResult {
  valid: boolean; // no errors (warnings allowed)
  issues: RubricValidationIssue[];
  // Set when it parses: the normalised rubric + derived facts the GUI shows.
  summary?: {
    documentType: string;
    criteriaCount: number;
    totalWeight: number;
    criticalCount: number;
    hasRecipe: boolean;
    sectionCount: number;
  };
}

/**
 * Validate a candidate rubric object. Pure except for reading the committed
 * rubric set (to check alias/type collisions against what is already live).
 */
export function validateRubric(candidate: unknown): RubricValidationResult {
  const issues: RubricValidationIssue[] = [];

  // 1. Schema. The superRefine rules in the schema catch most structural
  //    problems (deterministic-needs-patterns, advisory-weight-0, etc).
  const parsed = rubricSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const e of parsed.error.errors) {
      issues.push({ severity: "error", path: e.path.join("."), message: e.message });
    }
    return { valid: false, issues };
  }
  const rubric = parsed.data;

  // 2. Weights: at least one scoring (non-advisory) criterion, positive total.
  const scoring = rubric.criteria.filter((c) => c.gate !== "advisory");
  const totalWeight = scoring.reduce((s, c) => s + c.weight, 0);
  if (scoring.length === 0) {
    issues.push({ severity: "error", path: "criteria", message: "No scoring (non-advisory) criteria; the score would be undefined." });
  }
  if (totalWeight <= 0) {
    issues.push({ severity: "error", path: "criteria", message: "Total scoring weight must be positive." });
  }

  // 3. Duplicate criterion ids within the rubric.
  const ids = new Set<string>();
  for (const c of rubric.criteria) {
    if (ids.has(c.id)) issues.push({ severity: "error", path: `criteria.${c.id}`, message: `Duplicate criterion id '${c.id}'.` });
    ids.add(c.id);
  }

  // 4. Pattern criteria: regexes must compile.
  for (const c of rubric.criteria) {
    for (const rule of [...c.forbiddenPatterns, ...c.requiredPatterns]) {
      try { new RegExp(rule.pattern); }
      catch { issues.push({ severity: "error", path: `criteria.${c.id}`, message: `Invalid regex: ${rule.pattern}` }); }
    }
  }

  // 5. Alias collisions against the COMMITTED set (excluding same document type,
  //    which is a legitimate re-version of an existing type).
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const committedAliases = new Map<string, string>();
  for (const type of listRubricTypes()) {
    if (type === rubric.documentType) continue;
    const r = getRubric(type).rubric;
    for (const a of [r.documentType, ...r.aliases]) committedAliases.set(norm(a), type);
  }
  for (const a of [rubric.documentType, ...rubric.aliases]) {
    const owner = committedAliases.get(norm(a));
    if (owner) issues.push({ severity: "error", path: "aliases", message: `Alias '${a}' already belongs to committed rubric '${owner}'.` });
  }

  // 6. Recipe/section coherence (warnings - a rubric can score without a recipe).
  if (rubric.recipe.steps.length > 0 && rubric.sections.length === 0) {
    issues.push({ severity: "warning", path: "recipe", message: "Recipe has steps but no sections are declared." });
  }

  // --- SEAM: tomorrow's backtest harness runs here and appends issues. ---

  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    summary: {
      documentType: rubric.documentType,
      criteriaCount: rubric.criteria.length,
      totalWeight,
      criticalCount: rubric.criteria.filter((c) => c.gate === "critical").length,
      hasRecipe: rubric.recipe.steps.length > 0,
      sectionCount: rubric.sections.length,
    },
  };
}