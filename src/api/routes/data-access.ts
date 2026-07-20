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
import { insertRunStep, insertLlmCall } from "../../data/trace-store.js";
import { recordTrajectoryStep, recordTerminal } from "../../platform/trajectory-history.js";
import { getTierServices } from "../../services.js";
import { enforceLabels } from "../../identity/index.js";
import type { DataTier } from "../../tiers.js";

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

// ----- Diagnostic trace + DAG History (decision-13 refactor R2) -----
//
// The agent role used to write these tables directly (agent/instrument.ts,
// agent/llm-trace.ts, and the DAG-History mirror). They now POST here. user_id is
// stamped from the verified token, not the body — the same identity guarantee the
// custody endpoint makes. input/output arrive already redacted by the agent.

const runStepBody = z.object({
  correlationId: z.string().min(1),
  runId: z.string().min(1),
  queryId: z.string().optional(),
  node: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  latencyMs: z.number(),
  mode: z.string().optional(),
});

dataAccessRouter.post("/api/v1/data/run-steps", requireAuth, async (req, res, next) => {
  try {
    const parsed = runStepBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid run step.", issues: parsed.error.errors });
      return;
    }
    await insertRunStep({ ...parsed.data, userId: req.ctx!.user.id });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const llmCallBody = z.object({
  correlationId: z.string().min(1),
  runId: z.string().min(1),
  node: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
  completion: z.string().nullable().optional(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  latencyMs: z.number(),
  mode: z.string().optional(),
});

dataAccessRouter.post("/api/v1/data/llm-calls", requireAuth, async (req, res, next) => {
  try {
    const parsed = llmCallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid LLM call.", issues: parsed.error.errors });
      return;
    }
    await insertLlmCall({ ...parsed.data, userId: req.ctx!.user.id });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const trajectoryStepBody = z.object({
  correlationId: z.string().min(1),
  agentGuid: z.string().min(1),
  seq: z.number().int(),
  capability: z.string().optional(),
  kind: z.string().min(1),
  input: z.unknown(),
  outputRef: z.string().nullable().optional(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
});

dataAccessRouter.post("/api/v1/data/trajectory/steps", requireAuth, async (req, res, next) => {
  try {
    const parsed = trajectoryStepBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid trajectory step.", issues: parsed.error.errors });
      return;
    }
    await recordTrajectoryStep(parsed.data);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const trajectoryTerminalBody = z.object({
  correlationId: z.string().min(1),
  agentGuid: z.string().min(1),
  seq: z.number().int(),
  outcome: z.enum(["completed", "failed", "shutdown"]),
  finalRef: z.string().optional(),
  reason: z.string().optional(),
});

dataAccessRouter.post("/api/v1/data/trajectory/terminal", requireAuth, async (req, res, next) => {
  try {
    const parsed = trajectoryTerminalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid trajectory terminal.", issues: parsed.error.errors });
      return;
    }
    await recordTerminal(parsed.data);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ----- Vector search (decision-13 refactor R3) -----
//
// The agent's retrieval node used to hold a Qdrant client and search collections
// directly. It now POSTs here. This endpoint is the ONE place the authorisation
// filter is applied, and it is applied from the TOKEN, not the request: the
// caller names a tier and a query vector, and the server
//   1. rejects a tier the caller cannot access (min(user, agent), §6), and
//   2. AND-combines the access-label filter built from the verified token's
//      labels into the query — so restricted points are never fetched, and a
//      caller cannot widen its own access by omitting or forging the filter.
// `has_structured_table` is the only caller-supplied filter (the table lane).

const vectorSearchBody = z.object({
  tier: z.string().min(1),
  vector: z.array(z.number()),
  limit: z.number().int().positive().max(100),
  tableOnly: z.boolean().optional(),
});

dataAccessRouter.post("/api/v1/data/vector-search", requireAuth, async (req, res, next) => {
  try {
    const parsed = vectorSearchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid vector search.", issues: parsed.error.errors });
      return;
    }
    const { tier, vector, limit, tableOnly } = parsed.data;

    // Tier access is decided here, from the token — never trusted from the body.
    if (!req.ctx!.user.accessibleTiers.includes(tier as DataTier)) {
      res.status(403).json({ error: `No access to tier '${tier}'.` });
      return;
    }

    // The label filter is server-authoritative, built from the caller's verified
    // labels. Qdrant excludes points lacking the key, so an unlabelled point is
    // invisible to everyone — fail-closed by construction.
    const labelFilter = enforceLabels() ? [{ key: "access_labels", match: { any: req.ctx!.labels } }] : [];
    const must = [
      ...(tableOnly ? [{ key: "has_structured_table", match: { value: true } }] : []),
      ...labelFilter,
    ];

    const svc = getTierServices(tier as DataTier);
    const hits = await svc.qdrant.search(svc.qdrantCollection, {
      vector,
      limit,
      with_payload: true,
      ...(must.length > 0 ? { filter: { must } } : {}),
    });

    res.json({ hits: hits.map((h) => ({ id: h.id, score: h.score, payload: h.payload })) });
  } catch (err) {
    next(err);
  }
});

// ----- Query records (decision-13 refactor R4) -----
//
// QueryRecord (the per-request run state) used to reach the caller's tier Redis
// directly. It now GET/PUTs here. The Redis instance is resolved from the token's
// tier server-side, so a caller reaches only its own tier's store. The record is
// an opaque JSON blob to this endpoint; its shape is QueryRecord's concern.

const RECORD_KEY = (id: string) => `qms:queries:${id}`;

dataAccessRouter.get("/api/v1/data/query-records/:id", requireAuth, async (req, res, next) => {
  try {
    const { redis } = getTierServices(req.ctx!.user.tier);
    const raw = await redis.get(RECORD_KEY(String(req.params.id)));
    if (!raw) {
      res.status(404).json({ error: "Query record not found." });
      return;
    }
    res.json({ data: JSON.parse(raw) });
  } catch (err) {
    next(err);
  }
});

const queryRecordBody = z.object({
  data: z.record(z.unknown()),
  ttlSeconds: z.number().int().positive(),
});

dataAccessRouter.put("/api/v1/data/query-records/:id", requireAuth, async (req, res, next) => {
  try {
    const parsed = queryRecordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query record.", issues: parsed.error.errors });
      return;
    }
    const { redis } = getTierServices(req.ctx!.user.tier);
    await redis.set(RECORD_KEY(String(req.params.id)), JSON.stringify(parsed.data.data), "EX", parsed.data.ttlSeconds);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
