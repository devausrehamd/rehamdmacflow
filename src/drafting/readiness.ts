// src/drafting/readiness.ts
//
// The readiness gate (Phase 4 of docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// A DETERMINISTIC input gate that runs AFTER gathering and BEFORE the thinker.
// It answers one question with no LLM: is the gathered input bundle complete and
// valid enough to generate from? If not, it names the specific gaps so the run
// halts with "missing the labor rate from research:sales" instead of spending an
// LLM call to produce a garbage document.
//
// This brackets the thinker: a deterministic gate here (inputs), the section
// validator + scored rubric after (output). Non-determinism sits in exactly one
// box with a checkpoint on each side.
//
// The checks are driven by rubric.requiredInputs — presence for required inputs,
// plus the declared min/max/pattern constraints for present ones. Everything
// here is pure and offline-testable; that is the whole point.

import type { Rubric } from "./rubric-schema.js";

/** One gathered input available to the gate. A gather step (Phase 5) produces
 *  these; `value` is what the researcher returned for this input id. */
export interface GatheredInput {
  value: unknown;
  capability?: string;
  artifactId?: string;
}

export type InputBundle = Record<string, GatheredInput>;

export interface ReadinessGap {
  inputId: string;
  capability: string;
  reason: string;
}

export interface ReadinessResult {
  ready: boolean;
  gaps: ReadinessGap[];
  /** How many required-input checks ran. */
  checked: number;
}

/**
 * Extract the gathered-input bundle from an executor bag. A gather step puts
 * `{ produces, value, capability, artifactId }` into the bag under its step id;
 * this collects them keyed by input id. Returns {} until a gather step runs
 * (Phase 5), which is exactly why an ungathered run reads as "everything
 * missing" at the gate.
 */
export function bundleFromBag(bag: Record<string, unknown>): InputBundle {
  const bundle: InputBundle = {};
  for (const v of Object.values(bag)) {
    if (v && typeof v === "object" && "produces" in v) {
      const g = v as { produces?: unknown; value?: unknown; capability?: unknown; artifactId?: unknown };
      if (typeof g.produces === "string") {
        bundle[g.produces] = {
          value: g.value,
          capability: typeof g.capability === "string" ? g.capability : undefined,
          artifactId: typeof g.artifactId === "string" ? g.artifactId : undefined,
        };
      }
    }
  }
  return bundle;
}

/**
 * The deterministic input gate. Given the document type and the gathered bundle,
 * decide whether the thinker may run. NO LLM: presence + declared constraints
 * only. A required input that is missing, or a present input that violates a
 * min/max/pattern constraint, is a gap. Ready iff there are no gaps.
 */
export function evaluateReadiness(rubric: Rubric, bundle: InputBundle): ReadinessResult {
  const gaps: ReadinessGap[] = [];

  for (const ri of rubric.requiredInputs) {
    const got = bundle[ri.id];
    const present = got !== undefined && got.value !== undefined && got.value !== null;

    if (!present) {
      // An optional input that wasn't gathered is fine; a required one is a gap.
      if (ri.required) {
        gaps.push({ inputId: ri.id, capability: ri.capability, reason: "required input was not gathered" });
      }
      continue;
    }

    const value = got.value;
    if (ri.min !== undefined && typeof value === "number" && value < ri.min) {
      gaps.push({ inputId: ri.id, capability: ri.capability, reason: `value ${value} is below the minimum ${ri.min}` });
    }
    if (ri.max !== undefined && typeof value === "number" && value > ri.max) {
      gaps.push({ inputId: ri.id, capability: ri.capability, reason: `value ${value} exceeds the maximum ${ri.max}` });
    }
    if (ri.pattern && typeof value === "string" && !new RegExp(ri.pattern).test(value)) {
      gaps.push({ inputId: ri.id, capability: ri.capability, reason: `value does not match required pattern /${ri.pattern}/` });
    }
  }

  return { ready: gaps.length === 0, gaps, checked: rubric.requiredInputs.length };
}
