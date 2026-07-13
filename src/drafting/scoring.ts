// src/drafting/scoring.ts
//
// Deterministic aggregation of per-criterion verdicts into a rubric result.
//
// The LLM judge returns ONE BIT per criterion: PASS or FAIL, with a rationale.
// It never sees the weights, never computes the score, never decides the gate.
// Everything here is arithmetic over those bits - a model that cannot see the
// weights cannot be argued into a passing total.
//
// Two mechanisms produce the bits:
//   - deterministic pattern checks (this file, checkPatterns) - no LLM
//   - the LLM judge (elsewhere) - semantic criteria
// A `hybrid` criterion FAILs if EITHER the pattern check or the judge fails.

import type { Rubric, Criterion, PatternRule } from "./rubric-schema.js";

export type Verdict = "pass" | "fail";

export interface PatternResult {
  passed: boolean;
  /** Which forbidden patterns matched, or which required patterns were missing. */
  hits: { label: string; pattern: string; kind: "forbidden_present" | "required_absent" }[];
}

/**
 * Run a criterion's deterministic patterns over the output text.
 * FAIL if any forbidden pattern is present, or any required pattern is absent.
 * Case-insensitive. Pure.
 */
export function checkPatterns(criterion: Criterion, output: string): PatternResult {
  const hits: PatternResult["hits"] = [];

  for (const rule of criterion.forbiddenPatterns) {
    if (matches(rule, output)) {
      hits.push({ label: rule.label || rule.pattern, pattern: rule.pattern, kind: "forbidden_present" });
    }
  }
  for (const rule of criterion.requiredPatterns) {
    if (!matches(rule, output)) {
      hits.push({ label: rule.label || rule.pattern, pattern: rule.pattern, kind: "required_absent" });
    }
  }
  return { passed: hits.length === 0, hits };
}

function matches(rule: PatternRule, text: string): boolean {
  try {
    return new RegExp(rule.pattern, "i").test(text);
  } catch {
    // A malformed pattern must not silently pass. Treat as "present" for a
    // forbidden rule (fail closed) by matching nothing safely: report false so
    // required-absent fails and forbidden-present does not spuriously fire.
    return false;
  }
}

export interface CriterionVerdict {
  id: string;
  verdict: Verdict;
  /** Where the verdict came from. */
  source: "deterministic" | "llm_judge" | "hybrid";
  rationale: string;
  /** Pattern hits, when deterministic/hybrid. */
  patternHits?: PatternResult["hits"];
}

export interface RubricResult {
  /** Weighted fraction over non-gating, non-advisory criteria: 0..1. */
  score: number;
  /** Did every CRITICAL criterion pass? A single critical FAIL blocks approval. */
  gatePassed: boolean;
  /** Criteria that failed and are marked primary - the auditor's first look. */
  primaryFailures: string[];
  /** All critical criteria that failed. */
  criticalFailures: string[];
  /** score >= threshold AND gatePassed. */
  approved: boolean;
  /** Whether human review is forced (gate failed, or score below threshold, or any major fail). */
  reviewRequired: boolean;
  perCriterion: CriterionVerdict[];
}

/**
 * Aggregate verdicts against the rubric. `verdicts` must cover every criterion
 * by id; a missing verdict is treated as FAIL (fail closed - an unjudged
 * criterion is not a passed one).
 */
export function scoreRubric(
  rubric: Rubric,
  verdicts: CriterionVerdict[],
  threshold = rubric.reviewThreshold,
): RubricResult {
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  let weightAwarded = 0;
  let weightPossible = 0;
  const primaryFailures: string[] = [];
  const criticalFailures: string[] = [];
  let anyMajorFail = false;

  for (const c of rubric.criteria) {
    const v = byId.get(c.id);
    const passed = v?.verdict === "pass"; // missing => fail closed

    // Scoring: every non-advisory criterion contributes its weight to the
    // denominator; a pass adds it to the numerator. Critical criteria still
    // score, but their failure ALSO gates - a gate failure is not a score
    // problem you can outweigh.
    if (c.gate !== "advisory") {
      weightPossible += c.weight;
      if (passed) weightAwarded += c.weight;
    }

    if (!passed) {
      if (c.primary) primaryFailures.push(c.id);
      if (c.gate === "critical") criticalFailures.push(c.id);
      if (c.gate === "major") anyMajorFail = true;
    }
  }

  const score = weightPossible > 0 ? weightAwarded / weightPossible : 1;
  const gatePassed = criticalFailures.length === 0;
  const approved = gatePassed && score >= threshold;
  const reviewRequired = !gatePassed || score < threshold || anyMajorFail;

  return {
    score,
    gatePassed,
    primaryFailures,
    criticalFailures,
    approved,
    reviewRequired,
    perCriterion: rubric.criteria.map(
      (c) =>
        byId.get(c.id) ?? {
          id: c.id,
          verdict: "fail" as const,
          source: "llm_judge" as const,
          rationale: "No verdict returned for this criterion; failed closed.",
        },
    ),
  };
}

/** The evaluation block for the output and the custody record. */
export function renderRubricResult(rubric: Rubric, r: RubricResult): string {
  const L: string[] = [];
  L.push(`Evaluation: ${rubric.displayName} (v${rubric.version})`);
  L.push(`  Score: ${(r.score * 100).toFixed(1)}%  (threshold ${(rubric.reviewThreshold * 100).toFixed(0)}%)`);
  L.push(`  Gate: ${r.gatePassed ? "PASSED" : "FAILED"}`);
  L.push(`  Outcome: ${r.approved ? "APPROVED" : "REVIEW REQUIRED"}`);

  if (r.criticalFailures.length > 0) {
    L.push(`  CRITICAL failures (block approval): ${r.criticalFailures.join(", ")}`);
  }
  if (r.primaryFailures.length > 0) {
    L.push(`  Primary failures: ${r.primaryFailures.join(", ")}`);
  }

  L.push(`  Per criterion:`);
  for (const v of r.perCriterion) {
    const c = rubric.criteria.find((x) => x.id === v.id)!;
    const tag = c.gate === "critical" ? "[CRITICAL]" : c.primary ? "[primary]" : "";
    L.push(`    ${v.verdict === "pass" ? "PASS" : "FAIL"} ${v.id} (w${c.weight}) ${tag}`);
    if (v.verdict === "fail") L.push(`         ${v.rationale}`);
    for (const h of v.patternHits ?? []) {
      L.push(`         pattern: ${h.kind === "forbidden_present" ? "found forbidden" : "missing required"} "${h.label}"`);
    }
  }
  return L.join("\n");
}