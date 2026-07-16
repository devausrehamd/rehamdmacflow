// src/api/routes/rubrics.ts
//
// The rubric API. Two clearly separated worlds:
//
//   COMMITTED (read-only) - the git-backed rubrics/*.json that govern real
//     evaluations and stamp custody. The API can READ them (so the GUI can use
//     one as a starting point) but never write them. Promotion to committed
//     happens through GIT, with human review - the API is not a deploy path.
//
//   DRAFTS (mutable) - provisional rubrics authored in the GUI, validated, and
//     exported to JSON for check-in. Stored in rubric_drafts. The evaluation
//     pipeline physically cannot load these, so a half-baked draft can never
//     judge a real document.
//
// Editing drafts needs `rubric:edit`. Reading committed rubrics needs the
// normal read permission.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ValidationError } from "../errors.js";
import { db } from "../../db/client.js";
import { rubric_drafts, rubric_draft_batches } from "../../db/schema.js";
import { listRubricTypes, getRubric } from "../../drafting/rubric-loader.js";
import { updateRubricsFromRelease, RubricUpdateError } from "../../drafting/rubric-release.js";
import { appendEvent } from "../../custody/ledger.js";
import { getActiveDiscoveryClient } from "../../discovery/register.js";
import { validateRubric } from "../../drafting/rubric-validate.js";
import { rubricSchema } from "../../drafting/rubric-schema.js";
import { runBatch } from "../../drafting/batch-runner.js";
import { compareBatches, type BatchStats } from "../../drafting/rubric-stats.js";

export const rubricsRouter = Router();

// ---- COMMITTED (read-only) ----

rubricsRouter.get(
  "/api/v1/rubrics",
  requireAuth,
  requirePermission("draft:view-any"),
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rubrics = listRubricTypes().map((type) => {
        const { rubric, contentHash } = getRubric(type);
        return {
          documentType: type,
          displayName: rubric.displayName,
          version: rubric.version,
          hash: contentHash,
          criteriaCount: rubric.criteria.length,
          hasRecipe: rubric.recipe.steps.length > 0,
          committed: true,
        };
      });
      res.json({ rubrics });
    } catch (err) { next(err); }
  },
);

rubricsRouter.get(
  "/api/v1/rubrics/:type",
  requireAuth,
  requirePermission("draft:view-any"),
  (req: Request<{ type: string }>, res: Response, next: NextFunction) => {
    try {
      if (!listRubricTypes().includes(req.params.type)) {
        res.status(404).json({ error: `No committed rubric '${req.params.type}'.` });
        return;
      }
      const { rubric, contentHash } = getRubric(req.params.type);
      res.json({ documentType: req.params.type, hash: contentHash, committed: true, rubric });
    } catch (err) { next(err); }
  },
);

// ---- RELEASE (pull the committed rubric set from git) ----
//
// The other half of promotion. A draft is exported and committed to git, where
// a human reviews it; this is how every other agent picks it up. It consumes
// what review produced rather than bypassing review, which is why it is allowed
// to exist at all - and why it pulls a pinned RELEASE ref rather than whatever
// happens to be on main.
//
// The standard governing evaluations changes here, so it is chained into
// custody: an auditor reading a verdict can see when the yardstick was swapped,
// by whom, and from which hash to which.

rubricsRouter.post(
  "/api/v1/rubrics/update",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Synchronous and quick, but it swaps the rubric set out from under any
      // evaluation running right now. The pipeline reads rubrics per run, so
      // the exposure is small; when generation is wired, a run must pin its
      // rubric hash for its whole life rather than re-read mid-flight.
      const result = updateRubricsFromRelease();

      // Only record a custody event when something actually moved. An
      // already-up-to-date agent changed no standard and should not imply it.
      if (!result.upToDate) {
        await appendEvent(
          {
            correlationId: req.ctx!.correlationId,
            runId: req.ctx!.runId,
            userId: req.ctx!.user.id, // WHO re-standardised this agent
            decisionId: req.ctx!.decisionId,
            policyHash: req.ctx!.policyHash,
            rubricHash: result.toSetHash,
          },
          "rubric_set_updated",
          {
            ref: result.ref,
            refCommit: result.refCommit,
            fromSetHash: result.fromSetHash,
            toSetHash: result.toSetHash,
            changed: result.changed.filter((c) => c.change !== "unchanged"),
          },
        );

        // Re-announce: Discovery is still advertising the previous fingerprint
        // and capability list, and the GUI uses exactly those to tell a user
        // whether two agents serve the same rubrics. Best effort - a failure
        // here leaves the phone book stale, not the agent wrong.
        try {
          await getActiveDiscoveryClient()?.reregister();
        } catch {
          // deliberately swallowed; the update itself succeeded
        }
      }

      res.json(result);
    } catch (err) {
      if (err instanceof RubricUpdateError) {
        res.status(err.status).json({ error: err.message, detail: err.detail });
        return;
      }
      next(err);
    }
  },
);

// ---- DRAFTS (mutable staging) ----

rubricsRouter.get(
  "/api/v1/rubric-drafts",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await db
        .select({ id: rubric_drafts.id, documentType: rubric_drafts.document_type, status: rubric_drafts.status, updatedAt: rubric_drafts.updated_at })
        .from(rubric_drafts)
        .where(eq(rubric_drafts.author_id, req.ctx!.user.id))
        .orderBy(sql`${rubric_drafts.updated_at} DESC`);
      res.json({ drafts: rows });
    } catch (err) { next(err); }
  },
);

rubricsRouter.get(
  "/api/v1/rubric-drafts/:id",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [row] = await db.select().from(rubric_drafts)
        .where(and(eq(rubric_drafts.id, req.params.id), eq(rubric_drafts.author_id, req.ctx!.user.id)));
      if (!row) { res.status(404).json({ error: "No such draft." }); return; }
      // A draft is ALWAYS flagged provisional - it can never masquerade as committed.
      res.json({ id: row.id, documentType: row.document_type, status: row.status, committed: false, content: row.content, validation: row.validation });
    } catch (err) { next(err); }
  },
);

// Create or update a draft. VALIDATES on the way in and stores the result, but
// never commits - this only writes to the staging table.
rubricsRouter.post(
  "/api/v1/rubric-drafts",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, documentType, content } = req.body as { id?: string; documentType: string; content: unknown };
      if (!documentType || !content) throw new ValidationError("documentType and content are required.");

      const validation = validateRubric(content);
      const status = validation.valid ? "validated" : "draft";

      if (id) {
        const [existing] = await db.select().from(rubric_drafts)
          .where(and(eq(rubric_drafts.id, id), eq(rubric_drafts.author_id, req.ctx!.user.id)));
        if (!existing) { res.status(404).json({ error: "No such draft." }); return; }
        await db.update(rubric_drafts)
          .set({ content: content as object, status, validation, updated_at: new Date() })
          .where(eq(rubric_drafts.id, id));
        res.json({ id, status, committed: false, validation });
      } else {
        const [row] = await db.insert(rubric_drafts)
          .values({ document_type: documentType, author_id: req.ctx!.user.id, content: content as object, status, validation })
          .returning({ id: rubric_drafts.id });
        res.status(201).json({ id: row.id, status, committed: false, validation });
      }
    } catch (err) { next(err); }
  },
);

// Re-validate a stored draft on demand (e.g. after the committed set changed).
rubricsRouter.post(
  "/api/v1/rubric-drafts/:id/validate",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [row] = await db.select().from(rubric_drafts)
        .where(and(eq(rubric_drafts.id, req.params.id), eq(rubric_drafts.author_id, req.ctx!.user.id)));
      if (!row) { res.status(404).json({ error: "No such draft." }); return; }
      const validation = validateRubric(row.content);
      await db.update(rubric_drafts)
        .set({ status: validation.valid ? "validated" : "draft", validation, updated_at: new Date() })
        .where(eq(rubric_drafts.id, row.id));
      res.json({ id: row.id, validation });
    } catch (err) { next(err); }
  },
);

// Export a VALID draft as clean JSON to check into git. Refuses to export an
// invalid draft - git should only ever receive schema-valid rubrics.
rubricsRouter.get(
  "/api/v1/rubric-drafts/:id/export",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [row] = await db.select().from(rubric_drafts)
        .where(and(eq(rubric_drafts.id, req.params.id), eq(rubric_drafts.author_id, req.ctx!.user.id)));
      if (!row) { res.status(404).json({ error: "No such draft." }); return; }
      const validation = validateRubric(row.content);
      if (!validation.valid) {
        res.status(422).json({ error: "Draft is not valid; fix errors before exporting to git.", validation });
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${row.document_type}.json"`);
      res.send(JSON.stringify(row.content, null, 2));
    } catch (err) { next(err); }
  },
);

// ---- k-SAMPLING BATCHES (the steering loop) ----
//
// A single judge run has ~40% variance, so the editor steers by pass RATES over
// k runs, not single verdicts. These endpoints run batches and compare them so
// the editor can see whether a wording change moved a criterion beyond the
// noise - and which criteria are coin-flips (ambiguous wording) to fix.

// Run a batch of k judge passes against a document's text.
rubricsRouter.post(
  "/api/v1/rubric-drafts/:id/score-batch",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { documentText, documentRef, k } = req.body as { documentText: string; documentRef: string; k?: number };
      if (!documentText || !documentRef) throw new ValidationError("documentText and documentRef are required.");
      const runs = Math.min(Math.max(k ?? 10, 1), 30); // clamp 1..30

      const [draft] = await db.select().from(rubric_drafts)
        .where(and(eq(rubric_drafts.id, req.params.id), eq(rubric_drafts.author_id, req.ctx!.user.id)));
      if (!draft) { res.status(404).json({ error: "No such draft." }); return; }

      // The draft must at least parse to be judged.
      const parsed = rubricSchema.safeParse(draft.content);
      if (!parsed.success) { res.status(422).json({ error: "Draft rubric does not parse; fix validation errors first." }); return; }

      const { stats } = await runBatch(parsed.data, documentText, runs);
      const [row] = await db.insert(rubric_draft_batches)
        .values({ draft_id: draft.id, document_ref: documentRef, k: runs, stats })
        .returning({ id: rubric_draft_batches.id, created_at: rubric_draft_batches.created_at });

      res.status(201).json({ batchId: row.id, k: runs, documentRef, stats });
    } catch (err) { next(err); }
  },
);

// The trajectory: batches for this draft, newest first, with a comparison
// between the two most recent (did the last change move a rate beyond noise?).
rubricsRouter.get(
  "/api/v1/rubric-drafts/:id/batches",
  requireAuth,
  requirePermission("rubric:edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await db.select().from(rubric_draft_batches)
        .where(eq(rubric_draft_batches.draft_id, req.params.id))
        .orderBy(sql`${rubric_draft_batches.created_at} DESC`)
        .limit(20);

      // Compare the two most recent batches on the SAME document, if present.
      let comparison = null;
      const sameDoc = rows.filter((r) => rows[0] && r.document_ref === rows[0].document_ref);
      if (sameDoc.length >= 2) {
        comparison = compareBatches(sameDoc[1].stats as BatchStats, sameDoc[0].stats as BatchStats);
      }

      res.json({
        batches: rows.map((r) => ({ batchId: r.id, documentRef: r.document_ref, k: r.k, stats: r.stats, createdAt: r.created_at })),
        latestComparison: comparison,
      });
    } catch (err) { next(err); }
  },
);