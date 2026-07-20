// src/platform/supervisor.ts
//
// The Supervisor (Stage 4 of the agent-platform control plane,
// docs/specs/SPEC-agent-platform-and-control-plane.md §2, §5).
//
// The launch plane — a SEPARATE concern from Discovery (registry) and the ID
// Server (authority). It ensures the agents a route needs are running and ready,
// launching them from their manifests when they are not, and it destroys idle
// agents on a TTL.
//
//   - ensureRunning(capability): if Discovery already has a live agent for the
//     capability, return it; otherwise launch one from its manifest, drive it to
//     READY (ingest-to-ready lives inside the launcher), and return it.
//   - concurrent ensureRunning for the same capability launches ONCE (dedupe).
//   - touch(guid) records activity; sweepIdle() destroys agents idle past the TTL.
//   - the process/container launcher is INJECTED (Launcher) so the supervision
//     logic is testable without spawning anything; a real launcher drops in
//     behind the same interface.

import type { CapabilityResolver } from "../orchestrator/discovery-registry.js";
import type { AgentManifest } from "./manifest.js";

export interface LaunchedAgent {
  guid: string;
  address: string;
}

/** How agents are actually started and stopped. Injected. */
export interface Launcher {
  /** Launch an agent from its manifest and RESOLVE ONLY when it is READY
   *  (registered and serving — ingest-to-ready happens inside). */
  launch(manifest: AgentManifest): Promise<LaunchedAgent>;
  /** Destroy an agent: SIGTERM -> drain -> exit. Ingested state persists. */
  stop(guid: string): Promise<void>;
}

/** Resolves the manifest that serves a capability. */
export interface ManifestSource {
  forCapability(capability: string): AgentManifest | null;
}

/** Index a set of manifests by the capabilities they advertise. */
export function manifestIndex(manifests: AgentManifest[]): ManifestSource {
  const byCap = new Map<string, AgentManifest>();
  for (const m of manifests) {
    for (const c of m.capabilities) if (!byCap.has(c)) byCap.set(c, m);
  }
  return { forCapability: (c) => byCap.get(c) ?? null };
}

export interface SupervisorOptions {
  /** Is a live agent already serving the capability? (Discovery-backed, Stage 1.) */
  resolver: CapabilityResolver;
  launcher: Launcher;
  manifests: ManifestSource;
  /** Idle-destroy TTL: an agent with no activity for this long is destroyed. */
  ttlMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Running {
  guid: string;
  address: string;
  capability: string;
  lastActivity: number;
}

export interface Supervisor {
  ensureRunning(capability: string): Promise<{ guid: string; address: string }>;
  touch(guid: string): void;
  sweepIdle(): Promise<string[]>;
  running(): { guid: string; address: string; capability: string }[];
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
  const now = opts.now ?? (() => Date.now());
  const running = new Map<string, Running>();
  // Dedupe concurrent launches of the same capability.
  const inflight = new Map<string, Promise<{ guid: string; address: string }>>();

  return {
    async ensureRunning(capability) {
      // 1. Already live in Discovery? Use it, and record the activity.
      const live = await opts.resolver.resolve(capability);
      if (live) {
        const existing = running.get(live.guid);
        if (existing) existing.lastActivity = now();
        else running.set(live.guid, { guid: live.guid, address: live.address, capability, lastActivity: now() });
        return { guid: live.guid, address: live.address };
      }

      // 2. Not running. Launch once, even under concurrent callers.
      const pending = inflight.get(capability);
      if (pending) return pending;

      const launch = (async () => {
        const manifest = opts.manifests.forCapability(capability);
        if (!manifest) {
          throw new Error(`Supervisor has no manifest for capability '${capability}'.`);
        }
        const agent = await opts.launcher.launch(manifest);
        running.set(agent.guid, { guid: agent.guid, address: agent.address, capability, lastActivity: now() });
        return { guid: agent.guid, address: agent.address };
      })();

      inflight.set(capability, launch);
      try {
        return await launch;
      } finally {
        inflight.delete(capability);
      }
    },

    touch(guid) {
      const r = running.get(guid);
      if (r) r.lastActivity = now();
    },

    async sweepIdle() {
      const cutoff = now() - opts.ttlMs;
      const destroyed: string[] = [];
      for (const [guid, r] of running) {
        if (r.lastActivity < cutoff) {
          await opts.launcher.stop(guid);
          running.delete(guid);
          destroyed.push(guid);
        }
      }
      return destroyed;
    },

    running() {
      return [...running.values()].map((r) => ({ guid: r.guid, address: r.address, capability: r.capability }));
    },
  };
}
