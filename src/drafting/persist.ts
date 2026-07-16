// src/drafting/persist.ts
//
// Persist the validated draft at the human-review halt.
//
// Until this runs, a generated section exists only as a value in the executor's
// in-memory bag - it vanishes when executeRecipe returns. This is the write
// that turns "the pipeline generated a section" into "the section exists": a
// durable, TYPED row keyed by correlation id that a reviewer, a renderer, and
// the disposition endpoint all read.
//
// It stores the VALIDATED rows (ValidatedRow[]) as jsonb - not markdown. The
// rows are the canonical artifact; every rendered format projects from them.

import { db } from "../db/client.js";
import { draft_sets, draft_documents } from "../db/schema.js";
import { getRubric } from "./rubric-loader.js";
import type { OutputBag, StepOutputs } from "./executor.js";
import type { RubricResult } from "./scoring.js";

export interface PersistedDraft {
  setId: string;
  documentIds: string[];
  status: string;
}

/**
 * Write every generated section in the bag to draft_documents, under one
 * draft_set marked pending_review. Idempotent per correlation id is NOT
 * assumed - a rerun creates a new set (rerun_count tracks lineage elsewhere).
 */
export async function persistDraft(opts: {
  documentType: string;
  subject: string | null;
  correlationId: string;
  originatingQueryId: string;
  /** WHO triggered generation. Recorded so the disposition endpoint can
   *  enforce APPROVER != AUTHOR. Undefined only when the run has no
   *  attributable user, in which case the set can never be approved. */
  authorId?: string;
  bag: OutputBag;
  rubricResult?: RubricResult;
}): Promise<PersistedDraft> {
  const loaded = getRubric(opts.documentType);

  // Create the set. Status is pending_review because we persist AT the halt,
  // i.e. generation finished and a human must now disposition it.
  const [set] = await db
    .insert(draft_sets)
    .values({
      originating_query_id: opts.originatingQueryId,
      author_id: opts.authorId ?? null,
      document_type: opts.documentType,
      subject: opts.subject,
      rubric_version: loaded.rubric.version,
      rubric_hash: loaded.contentHash,
      status: "pending_review",
    })
    .returning({ id: draft_sets.id });
  if (!set) throw new Error("Draft set insert returned no row; the draft was not persisted.");

  // Collect the criterion result once (it applies to the whole set/document).
  const criterionResults = opts.rubricResult
    ? {
        score: opts.rubricResult.score,
        gatePassed: opts.rubricResult.gatePassed,
        approved: opts.rubricResult.approved,
        reviewRequired: opts.rubricResult.reviewRequired,
        criticalFailures: opts.rubricResult.criticalFailures,
        primaryFailures: opts.rubricResult.primaryFailures,
        // The trajectory verdict, so a reviewer can see WHY a document was
        // auto-failed - "the FMEA procedure was never consulted" is the whole
        // reason a perfect-scoring draft is not approved, and omitting it here
        // would leave the reviewer staring at a high score with no explanation.
        trajectory: opts.rubricResult.trajectory ?? null,
        perCriterion: opts.rubricResult.perCriterion,
      }
    : null;

  const documentIds: string[] = [];

  // One draft_document per generated section in the bag.
  for (const [stepId, out] of Object.entries(opts.bag)) {
    if (!out || !("validation" in out)) continue;
    const v = (out as StepOutputs["generate_section"]).validation;

    // Coverage annotations for the reviewer - which fields fell short, and any
    // validation findings. Advisory; the numbers themselves live in `rows`.
    const gapCount = v.rows.reduce((n, r) => n + r.gaps.length, 0);
    const annotations = {
      rowCount: v.rows.length,
      gapCount,
      hasGaps: v.hasGaps,
      hasErrors: v.hasErrors,
      findings: v.findings,
    };

    const [doc] = await db
      .insert(draft_documents)
      .values({
        set_id: set.id,
        section_id: v.sectionId,
        title: `${loaded.rubric.displayName} - ${v.sectionId}`,
        rows: v.rows, // THE typed artifact
        content: null, // markdown projection rendered later, on demand
        correlation_id: opts.correlationId,
        criterion_results: criterionResults,
        annotations,
      })
      .returning({ id: draft_documents.id });
    if (!doc) throw new Error("Draft document insert returned no row.");

    documentIds.push(doc.id);
  }

  return { setId: set.id, documentIds, status: "pending_review" };
}