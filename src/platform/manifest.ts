// src/platform/manifest.ts
//
// The agent manifest (Stage 2 of the agent-platform control plane,
// docs/specs/SPEC-agent-platform-and-control-plane.md §3b, §5).
//
// AgentAsSoftware: a generic runtime specialises itself at boot from a versioned
// manifest. The manifest declares what the agent IS (role, capabilities), how it
// verifies callers (identity / ID Server), what it may access (permissions), and
// what it ingests. It is validated at load — a config-driven system must reject
// bad config at boot, not at run.
//
// Boot-from-git-tag: the manifest is configured from a git tag equal to the agent
// name; `loadManifest` pins the commit it was read from into `configCommit`, so a
// run records exactly which configuration produced it (reproducibility). Fetching
// a remote config repo at a tag is a later refinement; the pinned-commit contract
// is here now.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { z } from "zod";

export const AGENT_ROLES = ["researcher", "thinker", "exporter", "actioner"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

const ingestionSourceSchema = z.object({
  uri: z.string().min(1),
  // A chain of converter ids resolved by (from -> to). Empty = no conversion.
  pipeline: z.array(z.string().min(1)).default([]),
});

export const manifestSchema = z.object({
  // == the git tag this agent is configured from.
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES),
  // What it advertises to Discovery. At least one.
  capabilities: z.array(z.string().min(1)).min(1),

  // How it verifies the caller's JWT (§6). The secret itself is injected via the
  // named env var, never committed to the manifest.
  identity: z.object({
    idServerUrl: z.string().url(),
    issuer: z.string().min(1),
    serviceTokenEnv: z.string().min(1),
  }),

  // Maximum operational scope; effective data access is min(user, this). "all"
  // is a scope, not a bypass (§6). A single label, a list, or "all".
  permissions: z.union([z.string().min(1), z.array(z.string().min(1))]).default([]),

  // What it ingests, and how its indexed state is treated (§5, §10).
  ingestion: z
    .object({
      sources: z.array(ingestionSourceSchema).default([]),
      schedule: z.enum(["on-boot", "cron", "webhook"]).default("on-boot"),
      state: z.enum(["persistent", "ephemeral"]).default("persistent"),
    })
    .default({ sources: [], schedule: "on-boot", state: "persistent" }),

  resources: z
    .object({
      cpu: z.number().int().positive().default(1),
      memoryMb: z.number().int().positive().default(1024),
    })
    .default({ cpu: 1, memoryMb: 1024 }),
});

export type AgentManifest = z.infer<typeof manifestSchema>;

/** Validate a manifest object (throws a ZodError on bad config). */
export function parseManifest(raw: unknown): AgentManifest {
  return manifestSchema.parse(raw);
}

export interface LoadedManifest {
  manifest: AgentManifest;
  /** The git commit the manifest was read at — pinned for reproducibility. */
  configCommit: string;
  source: string;
}

/**
 * Load and validate a manifest from a file, pinning the git commit it was read at.
 * `opts.commit` overrides the pin (used by tests, and by a launcher that already
 * resolved the tag). An unversioned file pins as "uncommitted".
 */
export function loadManifest(path: string, opts: { commit?: string } = {}): LoadedManifest {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return { manifest, configCommit: opts.commit ?? gitCommitOf(path), source: path };
}

function gitCommitOf(path: string): string {
  try {
    return execSync(`git log -1 --format=%H -- "${path}"`, { encoding: "utf8" }).trim() || "uncommitted";
  } catch {
    return "uncommitted";
  }
}

/** The runtime facts a manifest cannot know (assigned when the instance boots). */
export interface AgentRuntime {
  guid: string;
  /** Where to reach this instance now (a Discovery lease). */
  address: string;
  /** The CODE commit of the running binary — distinct from the config commit. */
  gitCommit: string;
  mode?: "production" | "debug";
  /** The pinned config commit, advertised for reproducibility (§9). */
  configCommit?: string;
}

/**
 * Build the Agent Card an agent registers with Discovery from its manifest plus
 * its runtime facts. Pure. `group` is the role, so instances of the same kind
 * cluster. `configCommit` is included forward-compatibly (Discovery stores it once
 * its schema is extended).
 */
export function agentCardFromManifest(manifest: AgentManifest, rt: AgentRuntime): Record<string, unknown> {
  return {
    guid: rt.guid,
    name: manifest.name,
    gitCommit: rt.gitCommit,
    address: rt.address,
    mode: rt.mode ?? "production",
    group: manifest.role,
    capabilities: manifest.capabilities,
    ...(rt.configCommit ? { configCommit: rt.configCommit } : {}),
  };
}
