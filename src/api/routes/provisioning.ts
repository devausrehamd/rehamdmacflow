// src/api/routes/provisioning.ts
//
// The Provisioning API (SPEC-operational-control-plane.md §5, D2a) — the stable,
// provider-agnostic contract for instance lifecycle. The Supervisor's ApiLauncher
// (D2b) calls these routes; behind them a single ComputeProvider (Docker now, a
// cloud VM later) is selected by QMS_COMPUTE_PROVIDER. This process holds no Docker
// or cloud SDK on the caller side — the provider owns it, exactly as the Data
// Access API owns the database (decision 13, applied to compute).

import { Router } from "express";
import { z } from "zod";
import { existsSync } from "node:fs";
import { requireAuth } from "../auth/middleware.js";
import { computeProviderFromEnv } from "../../platform/compute-provider-select.js";

export const provisioningRouter = Router();

// A manifest reference, constrained to the agents/ registry so a caller cannot
// point the provider at an arbitrary file.
const provisionBody = z.object({
  manifest: z.string().regex(/^agents\/[\w.-]+\.json$/, "manifest must be agents/<name>.json"),
  env: z.record(z.string()).optional(),
});

// POST /api/v1/instances — provision an agent instance; resolves only when ready.
provisioningRouter.post("/api/v1/instances", requireAuth, async (req, res, next) => {
  try {
    const parsed = provisionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid instance spec.", issues: parsed.error.errors });
      return;
    }
    if (!existsSync(parsed.data.manifest)) {
      res.status(400).json({ error: `Manifest not found: ${parsed.data.manifest}` });
      return;
    }
    const provider = computeProviderFromEnv();
    const instance = await provider.provision(parsed.data);
    res.status(201).json({ provider: provider.kind, ...instance });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/instances — every instance the provider owns (reconciliation).
provisioningRouter.get("/api/v1/instances", requireAuth, async (_req, res, next) => {
  try {
    res.json({ provider: computeProviderFromEnv().kind, instances: await computeProviderFromEnv().list() });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/instances/:id — one instance's status/health.
provisioningRouter.get("/api/v1/instances/:id", requireAuth, async (req, res, next) => {
  try {
    res.json(await computeProviderFromEnv().status(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/instances/:id — stop and destroy (idempotent).
provisioningRouter.delete("/api/v1/instances/:id", requireAuth, async (req, res, next) => {
  try {
    await computeProviderFromEnv().destroy(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
