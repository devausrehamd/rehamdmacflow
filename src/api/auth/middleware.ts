// src/api/auth/middleware.ts
//
// requireAuth: verify a JWT, load the user, build a RequestContext,
// attach it to req.ctx.
//
// requirePermission: check that the authenticated user has a specific
// permission. Must be chained after requireAuth.
//
// requireRole: check exact role match. Admin can satisfy any role check.
// Used for the simple "this endpoint is for X role only" pattern.
//
// All three are designed to be composed in Express route definitions:
//   app.post("/api/v1/admin/users", requireAuth, requireRole("admin"), handler)

import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./jwt.js";
import { findUserById } from "./store.js";
import { buildContext } from "../../context.js";
import type { RequestContext } from "../../context.js";
import { hasPermission } from "../../tiers.js";
import type { Role } from "../../tiers.js";
import { AuthError, ForbiddenError } from "../errors.js";
import {
  getEntitlementProvider,
  currentDomain,
  isPermitted,
} from "../../identity/index.js";
import { resolveCorrelationId, newRunId, CORRELATION_HEADER } from "../../custody/correlation.js";

// Augment Express's Request to include our context.
// This makes req.ctx available throughout the request lifecycle with
// full type safety.
declare global {
  namespace Express {
    interface Request {
      ctx?: RequestContext;
      requestId?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AuthError("Missing Bearer token in Authorization header");
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new AuthError("Empty Bearer token");
    }

    const payload = verifyAccessToken(token);

    // Load user from DB to ensure they still exist and are active.
    // This is a database read on every authenticated request - acceptable
    // for now. If it becomes a bottleneck, we can cache user records in
    // Redis with short TTL (1 minute) for hot user lookups.
    const user = await findUserById(payload.sub);
    if (!user) {
      throw new AuthError("User no longer exists");
    }
    if (!user.is_active) {
      throw new AuthError("Account is deactivated");
    }

    // Authorisation. Signature verification happened locally, above - a forged
    // token never reaches here. Entitlement is a MUTABLE fact and is resolved
    // per request against the identity service, which is what buys immediate
    // revocation. Resolve ONCE; every node downstream reads ctx.labels.
    const entitlement = await getEntitlementProvider().resolve(
      user.id,
      currentDomain(),
      user.role,
    );

    if (!isPermitted(entitlement)) {
      // No labels, revoked, or the identity service was unreachable. All three
      // resolve to the same answer: serve nothing. Fail closed.
      throw new AuthError(
        `No access to the ${entitlement.domain} domain (decision ${entitlement.decisionId})`,
      );
    }

    // Correlation ties this work to any cross-agent operation. Inherit the
    // caller's id (an orchestrator) or mint one if this agent is the entry
    // point. Echoed back on the response so the caller can follow the thread.
    const { correlationId } = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    const runId = newRunId();
    res.setHeader(CORRELATION_HEADER, correlationId);

    // Build the context for downstream code
    req.ctx = buildContext(
      {
        id: user.id,
        email: user.email,
        role: user.role as Role,
      },
      {
        labels: entitlement.labels,
        decisionId: entitlement.decisionId,
        policyHash: entitlement.policyHash,
        domain: entitlement.domain,
      },
      { correlationId, runId },
    );

    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.ctx) {
      return next(new AuthError("requireAuth must be called before requirePermission"));
    }
    if (!hasPermission(req.ctx.user.role, permission)) {
      return next(new ForbiddenError(`Permission '${permission}' required`));
    }
    next();
  };
}

/**
 * Require a specific role. Admin satisfies any role check (since admin
 * has the "*" permission). Other roles must match exactly.
 */
export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.ctx) {
      return next(new AuthError("requireAuth must be called before requireRole"));
    }
    if (req.ctx.user.role === "admin") {
      return next();
    }
    if (req.ctx.user.role !== role) {
      return next(new ForbiddenError(`Role '${role}' required, you have '${req.ctx.user.role}'`));
    }
    next();
  };
}