// src/tiers.ts
//
// Single source of truth for tier and role definitions.
//
// A "tier" is a data domain. Today there is one tier - "operations" - and
// every role maps to it. When the system eventually splits into physical
// data isolation per domain (engineering / financial / facility / governance),
// this file changes; nothing else has to.
//
// A "role" is a permission set + a default tier + a list of accessible tiers.
// The role controls what a user can do; the tier controls what data they can
// see. They are deliberately separate concepts so that "engineer" and
// "reviewer" can share a tier (both see engineering data) while differing
// in what they can do with it (engineer drafts, reviewer approves).

import { config } from "./config.js";

// v1 has a single tier. Add more here when physical isolation is implemented.
export type DataTier = "operations";

export type Role = "engineer" | "reviewer" | "admin" | "service";

export interface TierConfig {
  qdrantUrl: () => string;
  qdrantCollection: () => string;
  redisHost: () => string;
  redisPort: () => number;
}

export interface RoleConfig {
  defaultTier: DataTier;
  accessibleTiers: DataTier[];
  permissions: string[];
}

// Tier-to-connection mapping. Lazy accessors so config changes during testing
// can be picked up. Future: split into multiple tiers, each with distinct
// connection details.
export const TIERS: Record<DataTier, TierConfig> = {
  operations: {
    qdrantUrl: () => config.qdrant.operations.url,
    qdrantCollection: () => config.qdrant.operations.collection,
    redisHost: () => config.redis.operations.host,
    redisPort: () => config.redis.operations.port,
  },
};

// Role-to-permission and role-to-tier mapping.
// Permissions use a "noun:verb" pattern for clarity.
// "*" in permissions means "all permissions" (admin only).
export const ROLES: Record<Role, RoleConfig> = {
  engineer: {
    defaultTier: "operations",
    accessibleTiers: ["operations"],
    permissions: [
      "ask",
      "draft:create",
      "draft:view-own",
      "facts:read",
      "decisions:read",
      "lessons:read",
      "projects:read",
    ],
  },
  reviewer: {
    defaultTier: "operations",
    accessibleTiers: ["operations"],
    permissions: [
      "ask",
      "draft:create",
      "draft:view-any",
      "draft:approve",
      "draft:reject",
      "facts:read",
      "facts:write",
      "decisions:read",
      "lessons:read",
      "lessons:write",
      "projects:read",
      "audit:read",
    ],
  },
  admin: {
    defaultTier: "operations",
    accessibleTiers: ["operations"],
    permissions: ["*"],
  },
  // The agent's own service account. Constrained to draft+ask so that even
  // a prompt-injected agent cannot escalate privilege.
  service: {
    defaultTier: "operations",
    accessibleTiers: ["operations"],
    permissions: [
      "ask",
      "draft:create",
      "draft:view-own",
      "facts:read",
      "decisions:read",
      "lessons:read",
      "projects:read",
    ],
  },
};

/** Check if a role has a specific permission. Admin's "*" matches anything. */
export function hasPermission(role: Role, permission: string): boolean {
  const config = ROLES[role];
  return config.permissions.includes("*") || config.permissions.includes(permission);
}

/** Get all tiers a user with this role can access. */
export function accessibleTiersFor(role: Role): DataTier[] {
  return ROLES[role].accessibleTiers;
}

/** Get the default tier for this role - where their writes go. */
export function defaultTierFor(role: Role): DataTier {
  return ROLES[role].defaultTier;
}

/** All known roles. Useful for validation and admin UIs. */
export function allRoles(): Role[] {
  return Object.keys(ROLES) as Role[];
}

/** All known tiers. Useful for iteration. */
export function allTiers(): DataTier[] {
  return Object.keys(TIERS) as DataTier[];
}