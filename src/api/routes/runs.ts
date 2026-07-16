// src/api/routes/runs.ts
//
// Read back what went in and out of every graph node for a run.
//
// This is the diagnostic surface: custody proves a run happened and in what
// order, this shows what each stage was actually given and actually produced,
// so a low score can be attributed - bad retrieval, a model ignoring what it
// was handed, a node that threw.
//
// ACCESS. These rows hold retrieved document text, and retrieval is filtered by
// the CALLER'S access labels at the time of the run. So a run's evidence is
// scoped to the person who ran it: showing it to another engineer would hand
// them content their own labels might not entitle them to, using a diagnostic
// endpoint as a way around the label check.
//
// Therefore: you may read your OWN runs with draft:view-any, and anyone else's
// only with audit:read (reviewer/admin) - the same permission that already
// governs the custody dossier, which is the closest existing analogue.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { db } from "../../db/client.js";
import { agent_run_steps } from "../../db/schema.js";
import { hasPermission } from "../../tiers.js";

export const runsRouter = Router();

/** Runs this caller may list: their own, unless they can read any audit. */
function canReadOthers(req: Request): boolean {
  return hasPermission(req.ctx!.user.role, "audit:read");
}

// --- List recent runs ---
runsRouter.get(
  "/api/v1/runs",
  requireAuth,
  requirePermission("draft:view-any"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mine = !canReadOthers(req);
      // One row per run: the first step carries the question, the last the
      // outcome. Aggregated in SQL rather than by fetching every step, since a
      // run's steps hold whole documents.
      const rows = await db
        .select({
          correlationId: agent_run_steps.correlation_id,
          steps: sql<number>`count(*)::int`,
          startedAt: sql<string>`min(${agent_run_steps.recorded_at})`,
          finishedAt: sql<string>`max(${agent_run_steps.recorded_at})`,
          totalLatencyMs: sql<number>`coalesce(sum(${agent_run_steps.latency_ms}), 0)::int`,
          errors: sql<number>`count(*) filter (where ${agent_run_steps.status} = 'error')::int`,
          userId: sql<string | null>`min(${agent_run_steps.user_id})`,
          mode: sql<string | null>`min(${agent_run_steps.mode})`,
        })
        .from(agent_run_steps)
        .where(mine ? eq(agent_run_steps.user_id, req.ctx!.user.id) : sql`true`)
        .groupBy(agent_run_steps.correlation_id)
        .orderBy(desc(sql`max(${agent_run_steps.recorded_at})`))
        .limit(100);

      res.json({ runs: rows, scope: mine ? "own" : "all" });
    } catch (err) {
      next(err);
    }
  },
);

// --- One run, every step, in order ---
runsRouter.get(
  "/api/v1/runs/:correlationId",
  requireAuth,
  requirePermission("draft:view-any"),
  async (req: Request<{ correlationId: string }>, res: Response, next: NextFunction) => {
    try {
      const { correlationId } = req.params;
      const steps = await db
        .select()
        .from(agent_run_steps)
        .where(eq(agent_run_steps.correlation_id, correlationId))
        .orderBy(agent_run_steps.seq);

      const first = steps[0];
      if (!first) {
        res.status(404).json({ error: "No recorded steps for that run." });
        return;
      }

      // Ownership is checked AFTER the lookup but the response is identical to
      // a miss, so this cannot be used to probe which correlation ids exist.
      if (!canReadOthers(req) && first.user_id !== req.ctx!.user.id) {
        res.status(404).json({ error: "No recorded steps for that run." });
        return;
      }

      res.json({
        correlationId,
        runId: first.run_id,
        queryId: first.query_id,
        userId: first.user_id,
        mode: first.mode,
        steps: steps.map((s) => ({
          seq: s.seq,
          node: s.node,
          status: s.status,
          error: s.error,
          latencyMs: s.latency_ms,
          recordedAt: s.recorded_at,
          input: s.input,
          output: s.output,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);
