// src/drafting/rubric-schema.ts
//
// The rubric definition format and its Zod validation. Rubrics live as
// version-controlled JSON, one file per document type, in rubrics/<type>.json.
// Git is the source of truth; this schema validates a file on load and the
// loader stamps each with a content hash so every evaluation records exactly
// which rubric version judged a document.
//
// A rubric has THREE categories, each with different gating behaviour:
//
//   expert     - must-pass criteria. Any failure forces human review,
//                regardless of the objective score. Non-negotiables.
//   objective  - weighted, scored criteria. The weighted total as a
//                percentage is gated against reviewThreshold.
//   trajectory - provenance checks. Did generation consult the required QMS
//                sources, and avoid forbidden ones? Checked against the
//                recorded retrieval trajectory (deterministic in v1).

import { z } from "zod";
import { sectionSchema } from "./section-schema.js";
import { recipeSchema } from "./recipe.js";

// --- Unified criterion ---
//
// Every criterion is a binary PASS/FAIL with a weight. This is the model real
// rubrics use; the old expert(must-pass)/objective(scored) split was a v1
// simplification. A criterion's GATE decides what a failure does:
//
//   critical  a FAIL blocks approval regardless of the weighted score
//             (this is the old "must-pass"). Usually also primary.
//   major     a FAIL contributes its weight AND flags for review
//   minor     a FAIL only contributes its (missing) weight to the score
//   advisory  informational; contributes no weight, never gates
//
// assessmentType decides WHO judges:
//   llm_judge     semantic judgement (most criteria)
//   deterministic pattern match only - forbidden/required regexes. Resolved
//                 with NO LLM, more reliably than any judge for literal strings
//                 ("was EAR99", "prior 3A001.x").
//   hybrid        deterministic pre-check AND llm_judge; FAIL if either fails.
//
// The LLM only ever returns a per-criterion PASS/FAIL bit. It never sees the
// weights, never computes the score, never decides the gate. Aggregation is
// deterministic - a model that cannot see the weights cannot be argued into a
// passing total.

export const GATE_LEVELS = ["critical", "major", "minor", "advisory"] as const;
export const ASSESSMENT_TYPES = ["llm_judge", "deterministic", "hybrid"] as const;

export const patternRuleSchema = z.object({
  // Regex source, matched case-insensitively against the output text.
  pattern: z.string().min(1),
  // Human label for the report ("was EAR99", "prior CDR reference").
  label: z.string().default(""),
});

/**
 * Every criterion must read: "PASS if <condition>. FAIL otherwise."
 *
 * The judge returns one bit, so the rule has to name the passing condition and
 * nothing else. Prose like "failure modes should trace to a source" leaves the
 * model to infer where the line sits, and it will infer differently on
 * different runs - which is exactly what a coin-flip in the k-sampling report
 * IS. Forcing the author to write the boundary down converts a class of
 * ambiguity into a syntax error, caught at load rather than discovered as
 * 12/20 variance three weeks later.
 *
 * The trailing "FAIL otherwise." is not decoration: it states that the
 * condition is exhaustive, so anything not described is a fail rather than an
 * open question.
 */
export const CRITERION_FORMAT = /^\s*PASS if\s+\S[\s\S]*\.\s*FAIL otherwise\.\s*$/;

export const criterionSchema = z
  .object({
    id: z.string().min(1),

    // The PASS/FAIL rule, verbatim. This is what the judge is asked.
    criterion: z
      .string()
      .min(1)
      .regex(
        CRITERION_FORMAT,
        'criterion must be written as "PASS if <condition>. FAIL otherwise." - the judge returns one bit, so the rule must name the passing condition exhaustively',
      ),
    // Why, with examples of what a FAIL looks like. Given to the judge and
    // shown to the auditor.
    explanation: z.string().default(""),

    weight: z.number().nonnegative(),
    primary: z.boolean().default(false),

    assessmentType: z.enum(ASSESSMENT_TYPES).default("llm_judge"),
    gate: z.enum(GATE_LEVELS).default("major"),

    // What the criterion examines. Free text mirroring the source rubric
    // ("All output (modified files and final message in console)").
    scope: z.string().default("all_output"),

    // Deterministic part. A FAIL if ANY forbidden pattern is present, or if ANY
    // required pattern is absent. For anti-fabrication criteria the forbidden
    // list is the literal strings that must never appear ("was EAR99").
    forbiddenPatterns: z.array(patternRuleSchema).default([]),
    requiredPatterns: z.array(patternRuleSchema).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.assessmentType === "deterministic" &&
        c.forbiddenPatterns.length === 0 && c.requiredPatterns.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `deterministic criterion '${c.id}' has no patterns to check`,
      });
    }
    if (c.gate === "advisory" && c.weight !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `advisory criterion '${c.id}' must have weight 0 (it does not score)`,
      });
    }
  });

// --- Trajectory (provenance) ---
//
// What the agent must have DONE to produce this document, as opposed to what
// the document must SAY. A trajectory requirement is about the process, and a
// document can read perfectly while having been built on nothing - fluent,
// plausible, and grounded in no source at all. That failure is invisible to
// every criterion in the rubric, because the criteria only ever see the output.
//
// A trajectory miss is an AUTO FAIL. It is not weighed against the score: a
// document produced without consulting the governing procedure is not a
// slightly worse document, it is an unsourced one, and no amount of polish
// elsewhere earns it back.
//
// Two kinds, because there are two ways to acquire a fact:
//
//   document - a document of this TYPE from the corpus had to be retrieved.
//              Keyed on type rather than a path fragment: paths move when the
//              QMS folder is reorganised, and a rubric that breaks because
//              someone renamed a directory is a rubric nobody will trust.
//
//   agent    - another agent had to be asked. For facts the corpus cannot hold
//              because they change: "current exchange rate AUD to USD" is not
//              in a controlled document and must not be invented by the model.

export const TRAJECTORY_KINDS = ["document", "agent"] as const;

export const trajectoryRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    id: z.string().min(1),
    /** The document type that must appear in the retrieval trajectory. */
    documentType: z.string().min(1),
    /** WHY this source is required - read by the auditor, not the code. */
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string().min(1),
    /** Which agent had to be called, e.g. "web". */
    agent: z.string().min(1),
    /** What it had to be asked, e.g. "current exchange rate AUD to USD". */
    query: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

export type TrajectoryRule = z.infer<typeof trajectoryRuleSchema>;

export const rubricSchema = z.object({
  documentType: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),

  // The phrases users actually say for this deliverable. EXACT match after
  // normalisation - never fuzzy. A wrong alias selects the wrong recipe, the
  // wrong rubric, and the wrong required sources, silently.
  //
  // AUTHORED BY DOMAIN EXPERTS, reviewed as a controlled artifact. These are
  // not synonyms to be guessed at: under ISO 14971 "hazard", "risk" and
  // "harm" are distinct terms, and a Risk Register is a record while a DFMEA
  // is an analysis. Do not conflate them here to be helpful.
  aliases: z.array(z.string().min(1)).default([]),

  // --- Document dependencies ---
  //
  // `requires` names GENERATED artifacts this document must be built upon: an
  // approved DFMEA, an approved risk register. Distinct from
  // trajectory.requiredSources, which names CORPUS documents the recipe must
  // consult (the FMEA procedure). One is a dependency, the other is evidence.
  // Conflate them and the trajectory check starts demanding that a controlled
  // procedure be generated.
  //
  // A prerequisite in another domain cannot be built here - the agent refuses
  // and names it, and the orchestrator resolves it. `consume` names the
  // upstream EXPORTS this document reads, which code validates at load.
  requires: z
    .array(
      z.object({
        documentType: z.string().min(1),
        domain: z.string().min(1),
        consume: z.array(z.string()).default([]),
        reason: z.string().default(""),
      }),
    )
    .default([]),

  // Typed artifacts downstream recipes may consume. Cross-references are DATA,
  // not prose: a downstream document reads `riskItems` structurally rather
  // than letting an LLM extract "RISK-014" from the upstream document's text.
  // That makes a fabricated cross-reference a set-membership failure rather
  // than a plausible-looking sentence nobody catches.
  exports: z
    .record(
      z.string(),
      z.object({
        description: z.string().default(""),
        schema: z.string().min(1),
      }),
    )
    .default({}),

  // The document's declared structure - the panels, cut from the SOP before
  // the model sews. Each section names its fields, their provenance
  // (retrieved / generated / computed), and the SOP clause each came from.
  // Optional: a rubric can score without a recipe until the recipe is authored.
  sections: z.array(sectionSchema).default([]),
  // The objective-score fraction (0-1) at or above which review is not
  // mandated by score alone. Below it, human review is required. A critical
  // gate failure forces review regardless of this.
  reviewThreshold: z.number().min(0).max(1),

  // The flat, unified criterion list. Weighted binary criteria, each with a
  // gate. This replaces the old expert/objective split.
  criteria: z.array(criterionSchema).min(1),

  // The ordered program that produces this document. Closed-vocabulary steps,
  // executed by the deterministic interpreter. Optional: a rubric can score
  // without a recipe until the recipe is authored.
  recipe: recipeSchema.default({ steps: [] }),

  // What the agent must have DONE to earn this document. Checked against the
  // RECORDED trajectory of the run, not against the output text - the output
  // cannot testify about how it was made. A miss is an auto fail (see
  // trajectory-check.ts): unsourced is not a lesser grade of sourced.
  trajectory: z
    .object({
      description: z.string().default(""),
      /** Must ALL be satisfied. Any miss fails the document outright. */
      required: z.array(trajectoryRuleSchema).default([]),
      /** Must NONE be present. A hit fails the document outright - e.g. an
       *  archived or superseded document type that must never inform a live one. */
      forbidden: z.array(trajectoryRuleSchema).default([]),
    })
    .default({ description: "", required: [], forbidden: [] }),
});

export type Criterion = z.infer<typeof criterionSchema>;
export type PatternRule = z.infer<typeof patternRuleSchema>;
export type Rubric = z.infer<typeof rubricSchema>;

// A rubric plus the provenance stamp recorded on every evaluation it governs.
export interface LoadedRubric {
  rubric: Rubric;
  // sha256 of the raw file content - the exact-version audit anchor
  contentHash: string;
  sourcePath: string;
}