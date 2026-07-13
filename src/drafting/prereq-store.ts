// src/drafting/prereq-store.ts
//
// Which document types have an APPROVED instance?
//
// The DFMEA rubric's own trajectory rule forbids grounding in drafts/. So a
// prerequisite must be approved, not merely generated, before a dependent may
// cite it. That makes the dependency graph a workflow with a human gate on
// every edge - not a build that runs to completion.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { draft_sets } from "../db/schema.js";
import { buildGraph, planFor, type GenerationPlan } from "./dependency.js";
import { loadRubrics } from "./rubric-loader.js";
import { currentDomain } from "../identity/index.js";

export class PrerequisiteError extends Error {
  constructor(
    public readonly plan: GenerationPlan,
    message: string,
  ) {
    super(message);
    this.name = "PrerequisiteError";
  }
}

/**
 * Document types with at least one approved draft set.
 *
 * KNOWN LIMITATION, flagged deliberately: this is TYPE-level, not
 * SUBJECT-level. It answers "is there an approved DFMEA", not "is there an
 * approved DFMEA *for RC4*". A real system needs the draft set to carry its
 * subject, and this predicate to match on it. Until then, an approved DFMEA
 * for a different product would wrongly satisfy the prerequisite.
 *
 * Add `subject` to draft_sets and filter on it here. Do not paper over this
 * with a heuristic on the title.
 */
export async function approvedDocumentTypes(): Promise<Set<string>> {
  const rows = await db
    .select({ documentType: draft_sets.document_type })
    .from(draft_sets)
    .where(eq(draft_sets.status, "approved"));
  return new Set(rows.map((r) => r.documentType));
}

/** Resolve the plan for a target, against what is actually approved right now. */
export async function resolvePlan(target: string): Promise<GenerationPlan> {
  const rubrics = loadRubrics();
  const asRubrics = new Map([...rubrics].map(([k, v]) => [k, v.rubric]));
  const graph = buildGraph(asRubrics, currentDomain());
  const approved = await approvedDocumentTypes();
  return planFor(graph, target, approved, currentDomain());
}

/**
 * Refuse to generate when a prerequisite is missing or unapproved.
 *
 * The agent's contract stays what the classifier established: do one thing, or
 * say why you will not. It does NOT auto-cascade - generating a prerequisite
 * nobody asked for would produce a controlled document requiring its own review
 * from its own approver. The plan is returned for a human to confirm.
 */
export async function assertPrerequisitesSatisfied(target: string): Promise<void> {
  const plan = await resolvePlan(target);

  if (plan.blocked) {
    throw new PrerequisiteError(plan, plan.message!);
  }

  const missing = plan.steps.filter(
    (s) => s.status === "must_generate" && s.documentType !== target,
  );
  if (missing.length > 0) {
    const names = missing.map((m) => m.documentType).join(", ");
    throw new PrerequisiteError(
      plan,
      `'${target}' requires an approved ${names}, and none exists. Generating it would ` +
        `produce a controlled document nobody asked for, needing its own review and its own ` +
        `approver. Confirm this plan first: ${plan.steps.map((s) => `${s.documentType} [${s.status}]`).join(" -> ")}`,
    );
  }
}