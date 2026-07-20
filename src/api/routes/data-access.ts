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
