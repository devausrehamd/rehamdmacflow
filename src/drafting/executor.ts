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
import type { RecordedTrajectory } from "./trajectory-check.js";
import { assembleTrajectory } from "./trajectory-assemble.js";
import { recordRunStep, runInScope } from "../agent/instrument.js";
import type { Step } from "./recipe.js";
import { validateRecipe } from "./recipe.js";
import type { SectionValidation } from "./section-validator.js";
import type { RubricResult } from "./scoring.js";
import { appendEvent, type CustodyContext } from "../custody/ledger.js";
import { DAG_INPUTS_KEY } from "../custody/dag.js";
import { evaluateReadiness, bundleFromBag, type ReadinessResult, type ReadinessGap } from "./readiness.js";
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
  check_readiness: { ready: boolean; gaps: ReadinessGap[] };
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
  judge(step: Extract<Step, { kind: "judge" }>, bag: OutputBag, rubric: Rubric, trajectory?: RecordedTrajectory): Promise<StepOutputs["judge"]>;
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
  /** The readiness gate's verdict, when a check_readiness step ran. When it is
   *  not ready the run halts here (before the thinker) and this carries the gaps. */
  readiness?: ReadinessResult;
}

/** A custody payload for a step - references only, never generated text. */
/** Artifact hashes gathered so far in this run, for the DAG `inputs` reference.
 *  A gather step (Phase 5) puts `{ artifactIds: string[] }` into the bag; this
 *  flattens them across the bag. Returns [] until such a step exists, so no
 *  generation event changes shape yet. */
function gatheredArtifactIds(bag: OutputBag): string[] {
  const ids: string[] = [];
  for (const v of Object.values(bag)) {
    const maybe = (v as { artifactIds?: unknown } | undefined)?.artifactIds;
    if (Array.isArray(maybe)) for (const x of maybe) if (typeof x === "string") ids.push(x);
  }
  return ids;
}

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
    case "gather":
    case "check_readiness":
    case "export":
    case "act":
      // Unreachable in Phase 3 - these throw in the dispatch switch above before
      // any custody event is emitted. Present for exhaustiveness; their real
      // payloads land with their handlers.
      return { kind: step.kind };
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

/** Called after each step completes, for progress streaming. Never throws into
 *  the run: a reporting failure must not fail generation, so the executor
 *  guards it. */
export type StepProgress = (ev: { kind: Step["kind"]; index: number; total: number; status: "ok" }) => void;

export async function executeRecipe(
  rubric: Rubric,
  steps: Step[],
  handlers: StepHandlers,
  custody: CustodyContext,
  persist?: PersistConfig,
  onStep?: StepProgress,
): Promise<ExecutionResult> {
  const sectionIds = new Set(rubric.sections.map((s) => s.id));
  validateRecipe(steps, sectionIds, {
    // Intrinsic to the rubric, so enforced at load. The live capability set is
    // injected once the orchestrator/Discovery is wired (Phase 5).
    exportFormats: new Set(rubric.exportFormats),
    inputIds: new Set(rubric.requiredInputs.map((r) => r.id)),
  });

  const bag: OutputBag = {};
  let reviewRequired = false;
  let rubricResult: RubricResult | undefined;
  let readinessResult: ReadinessResult | undefined;

  const reportStep = (kind: Step["kind"], index: number) => {
    try {
      onStep?.({ kind, index, total: steps.length, status: "ok" });
    } catch {
      // A progress-report failure must never fail the run it reports on.
    }
  };

  for (const [stepIndex, step] of steps.entries()) {
    let output: StepOutputs[keyof StepOutputs];

    // Every step is recorded into the run trace (agent_run_steps), keyed by the
    // custody correlation id, so a generation run leaves the SAME trace an ask
    // run does - which is what lets the judge step below assemble a trajectory
    // from what actually happened. `input` is the step's own config, not the
    // whole bag: the bag grows unboundedly and each prior step's output is
    // already recorded, so logging it again would bloat the trace for no gain.
    const startedAt = Date.now();
    const scope = { correlationId: custody.correlationId, runId: custody.runId, node: step.kind, userId: custody.userId };
    const record = (out: unknown, status: "ok" | "error", error?: string) =>
      recordRunStep({ ...scope, input: step, output: out, status, error, latencyMs: Date.now() - startedAt });

    try {
    switch (step.kind) {
      case "retrieve_sections": output = await handlers.retrieve_sections(step, bag); break;
      case "query_table": output = await handlers.query_table(step, bag); break;
      case "recall_prior": output = await handlers.recall_prior(step, bag); break;
      case "generate_section": {
        // Scoped so the section-generation model calls attribute to this step
        // in the LLM trace, exactly as an ask-graph node's calls do.
        output = await runInScope(scope, () => handlers.generate_section(step, bag, rubric));
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
        // Assemble what this run actually did from its recorded trace, so a
        // required source that was never consulted becomes an auto-fail. Read by
        // correlation id: the SAME key custody and the run trace share, so the
        // judge is checked against the very run being judged. The retrieval
        // steps above have already been recorded by the time we reach here, so
        // the trajectory sees them.
        const trajectory = await assembleTrajectory(custody.correlationId);
        output = await runInScope(scope, () => handlers.judge(step, bag, rubric, trajectory));
        rubricResult = (output as StepOutputs["judge"]).result;
        if (rubricResult.reviewRequired) reviewRequired = true;
        break;
      }
      case "check_readiness": {
        // The deterministic input gate, BEFORE the thinker. Reads the gathered
        // bundle from the bag (empty until a gather step runs) and decides
        // whether generation may proceed. No LLM.
        const readiness = evaluateReadiness(rubric, bundleFromBag(bag));
        readinessResult = readiness;
        const rout: StepOutputs["check_readiness"] = { ready: readiness.ready, gaps: readiness.gaps };
        bag[step.id] = rout;
        await record(rout, "ok");
        reportStep(step.kind, stepIndex);
        // The orchestrator records the gate outcome - references only (input ids
        // and reasons), never the gathered values.
        await appendEvent(custody, "readiness_gate", {
          kind: "check_readiness",
          ready: readiness.ready,
          checked: readiness.checked,
          gaps: readiness.gaps,
        });
        if (!readiness.ready) {
          // HARD GATE: the thinker never runs on an incomplete input set. Halt
          // with the gaps. Re-dispatching the missing capability under a retry
          // policy is the deferred alternative (see the spec's open decisions).
          reviewRequired = true;
          return { bag, reviewRequired, rubricResult, haltedForHuman: false, readiness: readinessResult };
        }
        continue; // ready: proceed to the next step
      }
      case "gather":
      case "export":
      case "act":
        // Schema-declared (Phase 3) but not yet executable. Their handlers land
        // in later phases of the agent-topology spec; until then a recipe that
        // uses one fails loudly rather than silently producing nothing.
        throw new Error(
          `Step kind '${step.kind}' has no executor handler yet ` +
            `(lands in a later phase of docs/specs/SPEC-agent-topology-and-custody-dag.md).`,
        );
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
            // The author IS whoever the custody context says triggered this
            // run. Recording it here is what lets the disposition endpoint
            // enforce APPROVER != AUTHOR.
            authorId: custody.userId,
            bag,
            rubricResult,
          });
        }

        await record(output, "ok");
        reportStep(step.kind, stepIndex);
        await appendEvent(custody, "human_decision", {
          ...custodyPayload(step, output),
          ...(persisted ? { draftSetId: persisted.setId, documentIds: persisted.documentIds } : {}),
        });
        return { bag, reviewRequired, rubricResult, haltedForHuman: true, persisted, readiness: readinessResult };
      }
    }
    } catch (err) {
      // A step that threw is the most useful row in the trace - record it before
      // rethrowing, or the trace stops exactly where the fault is. The recorder
      // swallows its own write failure, so this cannot mask the original error.
      await record(undefined, "error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      throw err;
    }

    bag[step.id] = output;
    await record(output, "ok");
    reportStep(step.kind, stepIndex);

    // One custody event per step - references only.
    const eventType =
      step.kind === "generate_section" ? "generation" :
      step.kind === "judge" ? "judge" :
      step.kind === "query_table" ? "sql_query" :
      "retrieval";
    const payload = custodyPayload(step, output);
    // The thinker (generate_section) commits, via the DAG convention, to the
    // gathered artifacts it consumed. Absent until a gather step runs (Phase 5),
    // so this is omitted when nothing was gathered - keeping today's generation
    // events byte-identical while making the reference edge automatic later.
    if (step.kind === "generate_section") {
      const consumed = gatheredArtifactIds(bag);
      if (consumed.length > 0) payload[DAG_INPUTS_KEY] = consumed;
    }
    await appendEvent(custody, eventType, payload);
  }

  return { bag, reviewRequired, rubricResult, haltedForHuman: false, readiness: readinessResult };
}