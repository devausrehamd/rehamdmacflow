// src/context.ts
//
// RequestContext - the per-request identity and metadata that flows
// through every layer of the system.
//
// Every authenticated API request builds one. Every service call accepts one.
// The context tells downstream code who the user is, what tier they belong to,
// what tiers they can read from, and provides a stable request ID for log
// correlation across services.
//
// For scripts and the agent's own background work, buildSystemContext()
// provides a context bound to the "service" or "admin" role.

import { randomBytes } from "node:crypto";
import type { Role, DataTier } from "./tiers.js";
import { ROLES } from "./tiers.js";

export interface UserIdentity {
  id: string;
  email: string;
  role: Role;
  /** The user's default tier - where their writes go */
  tier: DataTier;
  /** All tiers this user can read from - usually [tier] but reviewers and admins may see more */
  accessibleTiers: DataTier[];
}

export interface RequestContext {
  user: UserIdentity;
  requestId: string;
  startedAt: Date;
}

/** Build a context from a verified user identity (typically from a JWT payload). */
export function buildContext(user: { id: string; email: string; role: Role }): RequestContext {
  const roleConfig = ROLES[user.role];
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tier: roleConfig.defaultTier,
      accessibleTiers: roleConfig.accessibleTiers,
    },
    requestId: `req_${randomBytes(8).toString("hex")}`,
    startedAt: new Date(),
  };
}

/**
 * Build a context for system-initiated work that isn't tied to a user request.
 * Used by scripts (migrations, ingestion runs from cron), the agent's
 * background tasks, and internal maintenance.
 *
 * Defaults to admin role for full access. For agent service work specifically,
 * use buildServiceContext() instead so the agent operates with constrained
 * permissions.
 */
export function buildSystemContext(): RequestContext {
  return buildContext({
    id: "system",
    email: "system@qms-agent.local",
    role: "admin",
  });
}

/**
 * Build a context for the agent's own LLM-driven work.
 * Uses the "service" role which can ask and draft but cannot approve,
 * reset, or modify decisions - so even a misbehaving agent cannot escalate.
 */
export function buildServiceContext(): RequestContext {
  return buildContext({
    id: "agent",
    email: "agent@qms-agent.local",
    role: "service",
  });
}