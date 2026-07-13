// src/drafting/recipe.ts
//
// The recipe: the ordered program that produces a document.
//
// It is a program over a CLOSED instruction set. Deterministic code executes
// it; the LLM appears inside exactly two step types (generate_section, judge)
// and nowhere else. The recipe cannot invent a step any more than the query
// planner can invent a column - the step `kind` is an enum, Zod-validated at
// load.
//
// The more a recipe pins, the less the model can get wrong. A retrieve_sections
// step is an exact lookup; a query_table step is a QueryRequest; a check step
// is set membership. Only generate_section is generative, and even there the
// output is validated against the declared section schema before it is trusted.
//
// The recipe lives in the rubric file, so one artifact per document type
// carries aliases, requires/exports, sections, criteria, AND the steps that
// weave them - all hashed together, the hash stamped on every custody event.

import { z } from "zod";

// The closed vocabulary. Each kind maps to one executor handler.
export const STEP_KINDS = [
  "retrieve_sections", // exact lookup of SOP sections by identifier -> context
  "query_table", // a QueryRequest against a structured table -> rows
  "recall_prior", // pull an approved upstream document's exports -> reference set
  "generate_section", // LLM composes a declared section from prior outputs
  "validate_section", // deterministic: check produced section vs its schema
  "judge", // LLM returns per-criterion PASS/FAIL; scorer aggregates
  "require_human", // gate: interrupt for human disposition
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const baseStep = {
  id: z.string().min(1),
  // Which prior step outputs this step consumes. An intra-document DAG - a
  // step cannot consume an output produced later. Checked at load.
  inputs: z.array(z.string()).default([]),
};

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    ...baseStep,
    kind: z.literal("retrieve_sections"),
    // SOP source path fragment + section identifiers to fetch exactly.
    source: z.string().min(1),
    sections: z.array(z.string()).default([]),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("query_table"),
    // The collection to query (resolved to member tables at run time).
    collection: z.string().min(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("recall_prior"),
    // The upstream document type and the export to pull as a reference set.
    documentType: z.string().min(1),
    export: z.string().min(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("generate_section"),
    // Which declared section (in rubric.sections) this produces.
    sectionId: z.string().min(1),
    // How many candidates to sample; the best valid one is kept.
    bestOf: z.number().int().min(1).max(5).default(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("validate_section"),
    sectionId: z.string().min(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("judge"),
    // Which criteria to evaluate; empty = all in the rubric.
    criteria: z.array(z.string()).default([]),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("require_human"),
    prompt: z.string().default("Review and disposition this draft."),
  }),
]);

export type Step = z.infer<typeof stepSchema>;

export const recipeSchema = z.object({
  steps: z.array(stepSchema).default([]),
});

export class RecipeError extends Error {
  constructor(
    public readonly code: "cycle" | "unknown_input" | "forward_reference" | "bad_target",
    message: string,
  ) {
    super(message);
    this.name = "RecipeError";
  }
}

/**
 * Validate a recipe's intra-document DAG at LOAD. Three checks, all before any
 * execution - a forward reference discovered mid-run is discovered too late:
 *
 *   1. every `inputs` name refers to an EARLIER step id (no forward refs)
 *   2. no duplicate step ids
 *   3. generate_section / validate_section target a section that exists
 */
export function validateRecipe(steps: Step[], sectionIds: Set<string>): void {
  const seen = new Set<string>();

  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new RecipeError("cycle", `Duplicate step id '${step.id}'.`);
    }

    for (const input of step.inputs) {
      if (!seen.has(input)) {
        throw new RecipeError(
          "forward_reference",
          `Step '${step.id}' consumes '${input}', which is not an earlier step. ` +
            `A recipe is a forward-only program; inputs must be already produced.`,
        );
      }
    }

    if ((step.kind === "generate_section" || step.kind === "validate_section") &&
        !sectionIds.has(step.sectionId)) {
      throw new RecipeError(
        "bad_target",
        `Step '${step.id}' targets section '${step.sectionId}', which the rubric does not declare.`,
      );
    }

    seen.add(step.id);
  }
}