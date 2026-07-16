// src/api/routes/review.ts
//
// The review contract. The separate reviewer UI is a thin client over these
// three endpoints - it holds no rubrics, no custody, no generation. Every
// guarantee lives HERE, in the agent, not in the UI: a frontend bug cannot
// launder a value, because the frontend cannot write to the record. It can only
// submit a disposition the agent validates.
//
//   GET  /api/v1/drafts?status=pending_review     the review queue
//   GET  /api/v1/draft/:correlationId             rendered markdown + typed rows + verdict
//   POST /api/v1/draft/:correlationId/disposition { decision, editedRows?, reason }
//
// The disposition endpoint enforces the invariants that make this a QMS:
//   - APPROVER != AUTHOR (draft:approve, and not the originating user)
//   - a human edit is recorded as its own PROVENANCE - a field-level delta in
//     the custody chain, never re-scored as if the model produced it
//   - the decision is an immutable custody event (approverId, timestamp, reason)

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { producesControlledRecords } from "../../drafting/mode-gate.js";
import { db } from "../../db/client.js";
import { draft_sets, draft_documents } from "../../db/schema.js";
import { getRubric } from "../../drafting/rubric-loader.js";
import { sectionSchema } from "../../drafting/section-schema.js";
import { renderMarkdown } from "../../drafting/render-markdown.js";
import { computeHumanEdits, renderEditSummary } from "../../drafting/human-edit.js";
import { appendEvent } from "../../custody/ledger.js";
import type { ValidatedRow } from "../../drafting/section-validator.js";

export const reviewRouter = Router();

// --- The queue ---
reviewRouter.get(
  "/api/v1/drafts",
  requireAuth,
  requirePermission("draft:view-any"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = (req.query.status as string) ?? "pending_review";
      const rows = await db
        .select({
          setId: draft_sets.id,
          documentType: draft_sets.document_type,
          subject: draft_sets.subject,
          status: draft_sets.status,
          createdAt: draft_sets.created_at,
        })
        .from(draft_sets)
        .where(eq(draft_sets.status, status))
        .orderBy(sql`${draft_sets.created_at} DESC`)
        .limit(100);
      res.json({ drafts: rows });
    } catch (err) { next(err); }
  },
);

// --- Fetch one draft for review ---
reviewRouter.get(
  "/api/v1/draft/:correlationId",
  requireAuth,
  requirePermission("draft:view-any"),
  async (req: Request<{ correlationId: string }>, res: Response, next: NextFunction) => {
    try {
      const { correlationId } = req.params;
      const docs = await db
        .select()
        .from(draft_documents)
        .where(eq(draft_documents.correlation_id, correlationId));
      const firstDoc = docs[0];
      if (!firstDoc) { res.status(404).json({ error: "No draft for that correlation id." }); return; }

      const [set] = await db.select().from(draft_sets).where(eq(draft_sets.id, firstDoc.set_id));
      if (!set) { res.status(404).json({ error: "No draft set for that correlation id." }); return; }
      const { rubric } = getRubric(set.document_type);

      const rendered = docs.map((doc) => {
        const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === doc.section_id));
        const rows = (doc.rows as ValidatedRow[]) ?? [];
        return {
          documentId: doc.id,
          sectionId: doc.section_id,
          rows, // typed - the UI edits THESE, not the markdown
          markdown: renderMarkdown({
            displayName: rubric.displayName,
            section: spec,
            rows,
            status: set.status,
            correlationId,
            rubricResult: doc.criterion_results as never,
            annotations: doc.annotations as never,
          }),
          criterionResults: doc.criterion_results,
          annotations: doc.annotations,
          // Which fields the reviewer may edit: never computed (code owns those).
          editableFields: spec.fields.filter((f) => f.provenance !== "computed").map((f) => f.name),
          lockedFields: spec.fields.filter((f) => f.provenance === "computed").map((f) => f.name),
        };
      });

      res.json({ correlationId, documentType: set.document_type, status: set.status, documents: rendered });
    } catch (err) { next(err); }
  },
);

// --- Disposition ---
reviewRouter.post(
  "/api/v1/draft/:correlationId/disposition",
  requireAuth,
  requirePermission("draft:approve"),
  async (req: Request<{ correlationId: string }>, res: Response, next: NextFunction) => {
    try {
      const { correlationId } = req.params;
      const { decision, reason, edits } = req.body as {
        decision: "approve" | "reject" | "rerun";
        reason?: string;
        // Optional per-document edits: { documentId: { rowIndex: {field: value} } }
        edits?: Record<string, Record<string, unknown>[]>;
      };
      if (!["approve", "reject", "rerun"].includes(decision)) {
        throw new ValidationError("decision must be approve, reject, or rerun.");
      }

      // A debug instance may be running against uncommitted draft rubrics, so
      // nothing it produced can become a controlled record. Rejecting and
      // rerunning stay available - those are how you iterate - but APPROVAL is
      // refused outright. Approval is the act that makes a document count.
      if (decision === "approve" && !producesControlledRecords()) {
        throw new ForbiddenError(
          "This agent runs in debug mode; its output is provisional and cannot be approved. " +
            "Approve on a production-mode agent.",
        );
      }

      const docs = await db.select().from(draft_documents).where(eq(draft_documents.correlation_id, correlationId));
      const firstDoc = docs[0];
      if (!firstDoc) { res.status(404).json({ error: "No draft for that correlation id." }); return; }
      const [set] = await db.select().from(draft_sets).where(eq(draft_sets.id, firstDoc.set_id));
      if (!set) { res.status(404).json({ error: "No draft set for that correlation id." }); return; }

      // APPROVER != AUTHOR. The person approving must not be the one who
      // triggered generation - the independent check IS the control.
      //
      // This previously compared `originating_query_id` (a qry_<hex>) against a
      // user id, which can never match, so the control silently never fired.
      // The author is now recorded explicitly on the set.
      //
      // FAIL CLOSED on an unknown author: a set written before author_id
      // existed cannot prove the approver is independent, so it cannot be
      // approved. Unprovable independence is not independence.
      if (!set.author_id) {
        throw new ForbiddenError(
          "This draft has no recorded author, so approver independence cannot be established. It cannot be approved.",
        );
      }
      if (set.author_id === req.ctx!.user.id) {
        throw new ForbiddenError("The approver must not be the author of the draft.");
      }

      const { rubric, contentHash } = getRubric(set.document_type);
      const custody = {
        correlationId,
        runId: req.ctx!.runId,
        userId: set.author_id, // the AUTHOR - a real user id, not a query id
        approverId: req.ctx!.user.id, // WHO is approving - distinct, and verified above
        decisionId: req.ctx!.decisionId,
        policyHash: req.ctx!.policyHash,
        rubricHash: contentHash,
      };

      // Apply and RECORD human edits as their own provenance.
      const editSummaries: string[] = [];
      let anyComputedOverride = false;
      if (edits) {
        for (const doc of docs) {
          const submitted = edits[doc.id];
          if (!submitted) continue;
          const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === doc.section_id));
          const result = computeHumanEdits(spec, (doc.rows as ValidatedRow[]) ?? [], submitted);
          if (result.edits.length === 0) continue;
          anyComputedOverride ||= result.hasComputedOverride;

          // Store the edited rows as a NEW value; the original is preserved in
          // the custody event's delta. Provenance of edited fields is human.
          await db.update(draft_documents)
            .set({ rows: result.editedRows, annotations: { ...(doc.annotations as object), humanEdited: true, provenanceOverrides: result.provenanceOverrides } })
            .where(eq(draft_documents.id, doc.id));

          editSummaries.push(renderEditSummary(result));
          // The edit delta is its own custody event - the exact field-level
          // record of what a human changed, attributable to the approver.
          await appendEvent(custody, "human_decision", {
            kind: "human_edit",
            documentId: doc.id,
            sectionId: doc.section_id,
            edits: result.edits,
            hasComputedOverride: result.hasComputedOverride,
          });
        }
      }

      // The disposition itself - immutable, attributed, chained.
      const newStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "regenerating";
      await db.update(draft_sets)
        .set({ status: newStatus, disposition: decision === "approve" ? "ok" : decision === "reject" ? "abort" : "rerun", disposition_reason: reason ?? null, updated_at: new Date() })
        .where(eq(draft_sets.id, set.id));

      await appendEvent(custody, "human_decision", {
        kind: "disposition",
        decision,
        reason: reason ?? null,
        editsApplied: editSummaries.length,
        computedOverride: anyComputedOverride,
      });

      res.json({
        correlationId,
        decision,
        status: newStatus,
        editsRecorded: editSummaries.length,
        warning: anyComputedOverride ? "A human overrode a code-computed field; recorded in custody." : undefined,
      });
    } catch (err) { next(err); }
  },
);