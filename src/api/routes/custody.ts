// src/api/routes/custody.ts
//
// The auditor-facing export endpoint.
//
//   GET /api/v1/custody/:correlationId          -> JSON dossier
//   GET /api/v1/custody/:correlationId?format=md -> rendered Markdown
//
// Reading a custody record is itself a privileged action - the record names
// who approved what. Gated by the "custody" permission (reviewer and admin),
// and every access is itself... not yet chained, but see the note below.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { buildCustodyDossier, renderCustodyDossier } from "../../custody/export.js";
import { ValidationError } from "../errors.js";

export const custodyRouter = Router();

custodyRouter.get(
  "/api/v1/custody/:correlationId",
  requireAuth,
  requirePermission("audit:read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { correlationId } = req.params;
      if (!/^cor_[0-9a-f]{16,}$/.test(correlationId)) {
        throw new ValidationError("Malformed correlation id.");
      }

      const dossier = await buildCustodyDossier(correlationId);

      if (dossier.events.length === 0) {
        res.status(404).json({ error: "No custody record for that correlation id in this domain." });
        return;
      }

      if (req.query.format === "md") {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="custody-${correlationId}.md"`,
        );
        res.send(renderCustodyDossier(dossier));
        return;
      }

      res.json(dossier);
    } catch (err) {
      next(err);
    }
  },
);