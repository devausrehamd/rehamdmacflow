// src/drafting/mode-gate.ts
//
// The ONE place the two modes differ.
//
// Debug mode exists so an engineer can iterate on rubrics and the pipeline
// until the output is good enough. Its only relaxation is that the executor may
// be handed an UNCOMMITTED draft rubric. Everything else - approver != author,
// custody chaining, section validation, scoring - is identical in both modes.
// Keeping the difference to a single function is deliberate: a mode whose
// behaviour is scattered across `if (debug)` branches is one refactor away from
// leaking into production.
//
// Production does not "disable" this path; it refuses it. The check is here so
// that a caller cannot load a draft rubric without passing through it.

import { config, type AgentMode } from "../config.js";
import { ForbiddenError } from "../api/errors.js";

/** This instance's mode. Fixed for the life of the process. */
export function currentMode(): AgentMode {
  return config.mode;
}

export function isDebugMode(): boolean {
  return config.mode === "debug";
}

/**
 * Guard the only relaxation debug mode grants: judging with an uncommitted
 * (draft) rubric. Throws in production.
 *
 * A draft rubric governs nothing - it has not been through git or human review.
 * Letting one score a real document in production would mean a document could
 * be approved against a standard nobody signed off, which is the failure this
 * whole split exists to prevent.
 */
export function assertMayUseDraftRubric(): void {
  if (config.mode !== "debug") {
    throw new ForbiddenError(
      "This agent runs in production mode and cannot evaluate against an uncommitted draft rubric. " +
        "Export the draft to git and commit it, or use a debug-mode agent.",
    );
  }
}

/**
 * Whether output produced by this instance may ever be treated as a controlled
 * QMS record. False in debug: its artifacts are provisional, must be marked as
 * such, and must never reach an approved state.
 */
export function producesControlledRecords(): boolean {
  return config.mode === "production";
}
