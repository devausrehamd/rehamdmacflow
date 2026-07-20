// src/api/routes/data-access.ts
//
// The Data Access API (Stage 0 of the agent-platform control plane,
// docs/specs/SPEC-agent-platform-and-control-plane.md §1 governing principle,
// decision 13).
//
// THE RULE: all database access is API-mediated. Every read and write goes
// through a REST endpoint; no caller holds a direct database client, and agents
// carry no database credentials — even against a local database. The endpoint is
// the one place where the caller is authenticated, permissions are applied, and
// the access is audited, and it decouples callers from storage (load-balancing,
// relocation).
//
// This router establishes the pattern on the artifact store (the simplest store:
// content-addressed put/get). Every other store follows the same shape: a router
// that OWNS the DB access, behind requireAuth. The existing read data API
// (routes/data.ts) is the read-side precedent; this adds the write side.
//
// A caller (an agent) uses src/data/artifact-client.ts — an HTTP client with a
// bearer token — never putArtifact/getArtifact directly.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { putArtifact, getArtifact, type Artifact } from "../../custody/artifacts.js";
import { appendEvent, type CustodyContext, type CustodyEventType } from "../../custody/ledger.js";

export const dataAccessRouter = Router();

const artifactBody = z.object({
  producer: z.string().min(1),
  capability: z.string().min(1),
  query: z.unknown(),
  result: z.unknown(),
  producedAt: z.string().min(1),
  sourceRef: z.string().optional(),
});

// Write an artifact THROUGH the API. requireAuth authenticates the caller and
// builds req.ctx (identity + entitlements) before any DB access — the single
// gate the rule requires. The audit middleware records who called.
dataAccessRouter.post("/api/v1/data/artifacts", requireAuth, async (req, res, next) => {
  try {
    const parsed = artifactBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid artifact.", issues: parsed.error.errors });
      return;
    }
    const hash = await putArtifact(parsed.data as Artifact);
    res.status(201).json({ hash });
  } catch (err) {
    next(err);
  }
});

// Read an artifact by its content hash.
dataAccessRouter.get("/api/v1/data/artifacts/:hash", requireAuth, async (req, res, next) => {
  try {
    const hash = String(req.params.hash);
    const artifact = await getArtifact(hash);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found." });
      return;
    }
    res.json({ hash, artifact });
  } catch (err) {
    next(err);
  }
});

// ----- Custody ledger (decision-13 refactor R1) -----
//
// Append one event to the hash-chained custody ledger THROUGH the API. The
// DB-owning writer (appendEvent: per-domain advisory lock, single chain, external
// mirror) lives in custody/ledger.ts and is imported only here; agent-role
// callers use src/data/custody-client.ts. The domain is process-level
// (currentDomain), so an in-process route append records the same chain a node
// would have written directly.

const custodyEventType = z.enum([
  "run_started",
  "retrieval",
  "sql_query",
  "generation",
  "judge",
  "human_decision",
  "delegation",
  "delegation_result",
  "document_finalized",
  "run_completed",
  "gather_complete",
  "readiness_gate",
  "action_taken",
  "rubric_set_updated",
]);

const custodyEventBody = z.object({
  ctx: z.object({
    correlationId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().optional(),
    approverId: z.string().optional(),
    decisionId: z.string().optional(),
    policyHash: z.string().optional(),
    rubricHash: z.string().optional(),
  }),
  eventType: custodyEventType,
  payload: z.record(z.unknown()),
});

dataAccessRouter.post("/api/v1/data/custody/events", requireAuth, async (req, res, next) => {
  try {
    const parsed = custodyEventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid custody event.", issues: parsed.error.errors });
      return;
    }
    // The authenticated caller is the authority for WHO recorded the event, not
    // the body: userId is stamped from the verified token. Every other custody
    // field is the caller's operation context and rides through the body.
    const ctx: CustodyContext = {
      ...parsed.data.ctx,
      userId: req.ctx!.user.id,
    };
    const result = await appendEvent(ctx, parsed.data.eventType as CustodyEventType, parsed.data.payload);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
