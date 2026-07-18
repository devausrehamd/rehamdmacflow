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
  // --- Capability-dispatched / pipeline steps (agent-topology spec) ---
  "gather", // fan out to a research capability -> a content-addressed artifact
  "check_readiness", // deterministic input gate BEFORE the thinker (Phase 4)
  "export", // render the section model to an output format (Phase 6)
  "act", // egress: hand the output to a channel (Phase 6)
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const baseStep = {
  id: z.string().min(1),
  // Which prior step outputs this step consumes. An intra-document DAG - a
  // step cannot consume an output produced later. Checked at load.
  inputs: z.array(z.string()).default([]),
  // The capability this step dispatches to, e.g. "research:qms" / "export:docx".
  // Only capability-dispatched kinds (gather, and optionally export/act) set it;
  // when present, validateRecipe pre-flights that some agent advertises it. The
  // orchestrator resolves capability -> live agent via Discovery at run time.
  requires: z.string().optional(),
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
  z.object({
    ...baseStep,
    kind: z.literal("gather"),
    // The research capability that supplies this input. Mandatory here (overrides
    // the optional base `requires`): a gather with no capability gathers nothing.
    requires: z.string().min(1),
    // The rubric.requiredInputs id this gather produces, e.g. "labor_rate".
    // validateRecipe checks it is a declared input.
    produces: z.string().min(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("check_readiness"),
    // The deterministic input gate before the thinker. Criteria are derived from
    // rubric.requiredInputs plus any explicit deterministic readiness criteria
    // (Phase 4). A hard gate: a missing required input halts before generation.
  }),
  z.object({
    ...baseStep,
    kind: z.literal("export"),
    // The output render format; must be a member of rubric.exportFormats. The
    // exporter (a pure capability, Phase 6) renders the section model to bytes.
    format: z.string().min(1),
  }),
  z.object({
    ...baseStep,
    kind: z.literal("act"),
    // The egress channel, e.g. "email". The actioner (Phase 6) is the sole
    // side-effecting role and the only external-write choke point.
    channel: z.string().min(1),
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

/** Optional resolution sets for the capability-dispatch pre-flight. Each is only
 *  enforced when supplied: the loader can validate a recipe's shape before
 *  Discovery is consulted, and the live capability set is injected at run time. */
export interface RecipeValidationContext {
  /** Advertised/live capabilities. When given, every step `requires` must resolve. */
  capabilities?: Set<string>;
  /** rubric.exportFormats. When given, an `export` step's `format` must be a member. */
  exportFormats?: Set<string>;
  /** rubric.requiredInputs ids. When given, a `gather` step's `produces` must be a member. */
  inputIds?: Set<string>;
}

/**
 * Validate a recipe's intra-document DAG at LOAD. All checks run before any
 * execution - a forward reference discovered mid-run is discovered too late:
 *
 *   1. no duplicate step ids
 *   2. every `inputs` name refers to an EARLIER step id (no forward refs)
 *   3. generate_section / validate_section target a section that exists
 *   4. a step's `requires` capability is advertised (when `capabilities` given)
 *   5. a `gather` step's `produces` is a declared requiredInput (when `inputIds` given)
 *   6. an `export` step's `format` is an allowed format (when `exportFormats` given)
 */
export function validateRecipe(
  steps: Step[],
  sectionIds: Set<string>,
  ctx: RecipeValidationContext = {},
): void {
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

    // Capability pre-flight: a step that dispatches to a capability must resolve
    // to an agent that advertises it. Skipped when no capability set is supplied.
    if (ctx.capabilities && step.requires && !ctx.capabilities.has(step.requires)) {
      throw new RecipeError(
        "bad_target",
        `Step '${step.id}' requires capability '${step.requires}', which no agent advertises.`,
      );
    }

    if (step.kind === "gather" && ctx.inputIds && !ctx.inputIds.has(step.produces)) {
      throw new RecipeError(
        "bad_target",
        `Gather step '${step.id}' produces '${step.produces}', which rubric.requiredInputs does not declare.`,
      );
    }

    if (step.kind === "export" && ctx.exportFormats && !ctx.exportFormats.has(step.format)) {
      throw new RecipeError(
        "bad_target",
        `Export step '${step.id}' targets format '${step.format}', which rubric.exportFormats does not allow.`,
      );
    }

    seen.add(step.id);
  }
}