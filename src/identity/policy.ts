// src/identity/policy.ts
//
// Loads the fixed local entitlement policy and hashes it. The hash is stamped
// on every decision the policy governs, exactly as rubric_hash is stamped on
// every review round - so the standard applied is reconstructable from git
// long after the policy has moved on.
//
// Git is the source of truth. This file is read once at startup.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const policySchema = z.object({
  policyVersion: z.string().min(1),
  description: z.string().default(""),
  /** role -> effective labels */
  roles: z.record(z.string(), z.array(z.string())),
  /** subject id -> additive labels, for per-person grants */
  subjects: z
    .record(z.string(), z.object({ labels: z.array(z.string()), note: z.string().optional() }))
    .default({}),
});

export type Policy = z.infer<typeof policySchema>;

export interface LoadedPolicy {
  policy: Policy;
  hash: string;
  sourcePath: string;
}

const POLICY_PATH = process.env.QMS_IDENTITY_POLICY ?? "identity/policy.json";

let cache: LoadedPolicy | null = null;

export function loadPolicy(path: string = POLICY_PATH): LoadedPolicy {
  if (cache && cache.sourcePath === path) return cache;

  if (!existsSync(path)) {
    throw new Error(
      `Identity policy not found at '${path}'. The local entitlement provider cannot resolve anything without it.`,
    );
  }

  const raw = readFileSync(path, "utf8");
  const parsed = policySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Identity policy ${path} failed validation:\n${parsed.error.toString()}`);
  }

  cache = {
    policy: parsed.data,
    hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    sourcePath: path,
  };
  return cache;
}

/**
 * Effective labels for a role plus any per-subject grants, scoped to one
 * domain. Scoping is a prefix match on "<domain>:" - so resolving the
 * accounting domain returns only accounting labels, and the accounting agent
 * never learns what the subject may see in engineering. Least disclosure
 * between agents, not only between users.
 */
export function resolveLabels(
  policy: Policy,
  subject: string,
  domain: string,
  role: string | undefined,
): string[] {
  const fromRole = role ? (policy.roles[role] ?? []) : [];
  const fromSubject = policy.subjects[subject]?.labels ?? [];

  const prefix = `${domain}:`;
  const all = new Set([...fromRole, ...fromSubject]);
  return [...all].filter((l) => l.startsWith(prefix)).sort();
}