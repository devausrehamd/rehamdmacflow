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
import { currentDomain } from "./identity/index.js";

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

  // --- Authorisation, resolved once at the request boundary ---
  //
  // Resolved by requireAuth against the identity service and NEVER re-resolved
  // downstream. A single ask-path request touches the prose lane, the table
  // lane, and the SQL endpoint; all three must act on the same decision. A
  // permission that changes mid-request is a bug, not a feature.
  //
  // `labels` is the caller's effective access-label set for THIS domain.
  // An artifact is visible iff its access_labels intersect this set.
  labels: string[];
  /** Ties an answer to the exact authorisation decision that permitted it. */
  decisionId: string;
  /** sha256 of the policy that produced the decision. The audit anchor. */
  policyHash: string;
  /** The domain this deployment serves. An isolated agent serves exactly one. */
  domain: string;

  // --- Custody. Set at the boundary, read by every node that appends an event. ---
  //
  // correlationId crosses agent boundaries (supplied by an orchestrator or
  // minted here); runId is local to this agent's handling of this request.
  // Both ride in ctx so a node emits a custody event the same way it reads a
  // label - no extra plumbing through AgentState.
  correlationId: string;
  runId: string;
}

/** Build a context from a verified user identity (typically from a JWT payload). */
export function buildContext(
  user: { id: string; email: string; role: Role },
  entitlement: {
    labels: string[];
    decisionId: string;
    policyHash: string;
    domain: string;
  },
  custody: { correlationId: string; runId: string },
): RequestContext {
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
    labels: entitlement.labels,
    decisionId: entitlement.decisionId,
    policyHash: entitlement.policyHash,
    domain: entitlement.domain,
    correlationId: custody.correlationId,
    runId: custody.runId,
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
  return buildContext(
    { id: "system", email: "system@qms-agent.local", role: "admin" },
    {
      labels: ["engineering:internal", "engineering:restricted"],
      decisionId: "dec_system",
      policyHash: "system",
      domain: currentDomain(),
    },
    { correlationId: `cor_${randomBytes(12).toString("hex")}`, runId: `run_${randomBytes(12).toString("hex")}` },
  );
}

/**
 * Build a context for the agent's own LLM-driven work.
 * Uses the "service" role which can ask and draft but cannot approve,
 * reset, or modify decisions - so even a misbehaving agent cannot escalate.
 */
export function buildServiceContext(): RequestContext {
  return buildContext(
    { id: "agent", email: "agent@qms-agent.local", role: "service" },
    {
      labels: [],
      decisionId: "dec_service",
      policyHash: "service",
      domain: currentDomain(),
    },
    { correlationId: `cor_${randomBytes(12).toString("hex")}`, runId: `run_${randomBytes(12).toString("hex")}` },
  );
}