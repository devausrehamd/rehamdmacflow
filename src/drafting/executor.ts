// src/drafting/executor.ts
//
// The recipe interpreter. Deterministic control flow; the LLM is confined to
// two handlers (generate_section, judge) and touches nothing else.
//
// The executor walks the ordered steps, dispatches each to its handler, threads
// each step's output into a bag keyed by step id, and emits ONE custody event
// per step. The generation trajectory and the custody chain are the same object
// - executing a step IS appending an event.
//
// Handlers are injected, so the machinery is testable with stubs before the
// real LLM is involved. The stub handlers return fixed data; the real ones call
// the model. Same interpreter either way.

import type { Rubric } from "./rubric-schema.js";
import type { Step } from "./recipe.js";
import { validateRecipe } from "./recipe.js";
import type { SectionValidation } from "./section-validator.js";
import type { RubricResult } from "./scoring.js";
import { appendEvent, type CustodyContext } from "../custody/ledger.js";
import { persistDraft, type PersistedDraft } from "./persist.js";

// What each step can put into the output bag.
export interface StepOutputs {
  retrieve_sections: { source: string; sections: { id: string; text: string }[] };
  query_table: { collection: string; rows: Record<string, unknown>[]; coverage: string };
  recall_prior: { documentType: string; export: string; ids: Set<string> };
  generate_section: { sectionId: string; validation: SectionValidation };
  validate_section: { sectionId: string; validation: SectionValidation };
  judge: { result: RubricResult };
  require_human: { disposition: "pending" | "approved" | "rejected" | "rerun" };
}

export type OutputBag = Record<string, StepOutputs[keyof StepOutputs] | undefined>;

// A handler executes one step against the accumulated bag and returns its
// output. Handlers are pure of custody - the executor emits the event.
export interface StepHandlers {
  retrieve_sections(step: Extract<Step, { kind: "retrieve_sections" }>, bag: OutputBag): Promise<StepOutputs["retrieve_sections"]>;
  query_table(step: Extract<Step, { kind: "query_table" }>, bag: OutputBag): Promise<StepOutputs["query_table"]>;
  recall_prior(step: Extract<Step, { kind: "recall_prior" }>, bag: OutputBag): Promise<StepOutputs["recall_prior"]>;
  generate_section(step: Extract<Step, { kind: "generate_section" }>, bag: OutputBag, rubric: Rubric): Promise<StepOutputs["generate_section"]>;
  validate_section(step: Extract<Step, { kind: "validate_section" }>, bag: OutputBag, rubric: Rubric): Promise<StepOutputs["validate_section"]>;
  judge(step: Extract<Step, { kind: "judge" }>, bag: OutputBag, rubric: Rubric): Promise<StepOutputs["judge"]>;
  require_human(step: Extract<Step, { kind: "require_human" }>, bag: OutputBag): Promise<StepOutputs["require_human"]>;
}

export interface ExecutionResult {
  bag: OutputBag;
  /** True if any step produced gaps or a failed gate - forces human review. */
  reviewRequired: boolean;
  /** The rubric result, if a judge step ran. */
  rubricResult?: RubricResult;
  /** Halted at a require_human gate awaiting disposition. */
  haltedForHuman: boolean;
  /** The persisted draft, when persistence was configured. */
  persisted?: PersistedDraft;
}

/** A custody payload for a step - references only, never generated text. */
function custodyPayload(step: Step, output: unknown): Record<string, unknown> {
  switch (step.kind) {
    case "retrieve_sections": {
      const o = output as StepOutputs["retrieve_sections"];
      return { kind: step.kind, source: o.source, sectionIds: o.sections.map((s) => s.id) };
    }
    case "query_table": {
      const o = output as StepOutputs["query_table"];
      return { kind: step.kind, collection: o.collection, rowCount: o.rows.length, coverage: o.coverage };
    }
    case "recall_prior": {
      const o = output as StepOutputs["recall_prior"];
      return { kind: step.kind, documentType: o.documentType, export: o.export, refCount: o.ids.size };
    }
    case "generate_section":
    case "validate_section": {
      const o = output as StepOutputs["generate_section"];
      return {
        kind: step.kind,
        sectionId: o.sectionId,
        rowCount: o.validation.rows.length,
        gaps: o.validation.rows.reduce((n, r) => n + r.gaps.length, 0),
        findingKinds: [...new Set(o.validation.findings.map((f) => f.kind))],
      };
    }
    case "judge": {
      const o = output as StepOutputs["judge"];
      return {
        kind: step.kind,
        score: o.result.score,
        gatePassed: o.result.gatePassed,
        criticalFailures: o.result.criticalFailures,
        primaryFailures: o.result.primaryFailures,
      };
    }
    case "require_human": {
      const o = output as StepOutputs["require_human"];
      return { kind: step.kind, disposition: o.disposition };
    }
  }
}

/**
 * Execute a recipe. Validates the DAG, then walks steps in order, emitting a
 * custody event for each. Stops at a require_human step (returns haltedForHuman)
 * - generation resumes on disposition, which is the LangGraph interrupt point.
 */
export interface PersistConfig {
  documentType: string;
  subject: string | null;
  originatingQueryId: string;
}

export async function executeRecipe(
  rubric: Rubric,
  steps: Step[],
  handlers: StepHandlers,
  custody: CustodyContext,
  persist?: PersistConfig,
): Promise<ExecutionResult> {
  const sectionIds = new Set(rubric.sections.map((s) => s.id));
  validateRecipe(steps, sectionIds);

  const bag: OutputBag = {};
  let reviewRequired = false;
  let rubricResult: RubricResult | undefined;

  for (const step of steps) {
    let output: StepOutputs[keyof StepOutputs];

    switch (step.kind) {
      case "retrieve_sections": output = await handlers.retrieve_sections(step, bag); break;
      case "query_table": output = await handlers.query_table(step, bag); break;
      case "recall_prior": output = await handlers.recall_prior(step, bag); break;
      case "generate_section": {
        output = await handlers.generate_section(step, bag, rubric);
        if ((output as StepOutputs["generate_section"]).validation.hasGaps ||
            (output as StepOutputs["generate_section"]).validation.hasErrors) reviewRequired = true;
        break;
      }
      case "validate_section": {
        output = await handlers.validate_section(step, bag, rubric);
        if ((output as StepOutputs["validate_section"]).validation.hasGaps ||
            (output as StepOutputs["validate_section"]).validation.hasErrors) reviewRequired = true;
        break;
      }
      case "judge": {
        output = await handlers.judge(step, bag, rubric);
        rubricResult = (output as StepOutputs["judge"]).result;
        if (rubricResult.reviewRequired) reviewRequired = true;
        break;
      }
      case "require_human": {
        // The generated sections are still only in memory here. Persist them
        // BEFORE halting - this is the write that makes the draft durable and
        // reviewable. Without it, the section vanishes when this function
        // returns. Persistence is opt-in so the stub tests stay DB-free.
        output = await handlers.require_human(step, bag);
        bag[step.id] = output;

        let persisted: PersistedDraft | undefined;
        if (persist) {
          persisted = await persistDraft({
            documentType: persist.documentType,
            subject: persist.subject,
            correlationId: custody.correlationId,
            originatingQueryId: persist.originatingQueryId,
            bag,
            rubricResult,
          });
        }

        await appendEvent(custody, "human_decision", {
          ...custodyPayload(step, output),
          ...(persisted ? { draftSetId: persisted.setId, documentIds: persisted.documentIds } : {}),
        });
        return { bag, reviewRequired, rubricResult, haltedForHuman: true, persisted };
      }
    }

    bag[step.id] = output;

    // One custody event per step - references only.
    const eventType =
      step.kind === "generate_section" ? "generation" :
      step.kind === "judge" ? "judge" :
      step.kind === "query_table" ? "sql_query" :
      "retrieval";
    await appendEvent(custody, eventType, custodyPayload(step, output));
  }

  return { bag, reviewRequired, rubricResult, haltedForHuman: false };
}