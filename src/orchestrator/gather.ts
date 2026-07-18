// src/orchestrator/gather.ts
//
// The parallel gather fan-out (Phase 5 of the agent-topology / custody-DAG spec).
//
// Given a gather step's requests, dispatch each to its capability IN PARALLEL,
// and turn each provider's result into a content-addressed artifact. Dumb
// researchers: a provider returns data; THIS orchestration hashes and stores it
// (putArtifact). It does NOT write the custody chain — the executor records the
// single gather_complete over the returned artifact ids. That split is the
// single-writer invariant in code: this module imports the artifact store, never
// the ledger.
//
// Order-independence falls out for free: an artifact's id depends only on its own
// content, and Promise.all preserves request order in its results, so the id set
// and their order are the same regardless of which provider finishes first.

import { putArtifact, artifactId, type Artifact } from "../custody/artifacts.js";
import type { CapabilityRegistry, RunContext } from "./capabilities.js";

export interface GatherRequest {
  requires: string;
  produces: string;
  query?: unknown;
}

export interface GatheredInput {
  produces: string;
  capability: string;
  value: unknown;
  artifactId: string;
  sourceRef?: string;
}

export interface GatherOutcome {
  /** Every gathered artifact's id, in request order (for the one gather_complete). */
  artifactIds: string[];
  /** The gathered inputs, for the bag / readiness gate / thinker. */
  inputs: GatheredInput[];
}

/**
 * Fan out a gather step's requests to their capabilities in parallel, storing one
 * artifact per result. Throws if a capability has no provider (the recipe
 * pre-flight should have caught this earlier; this is the run-time backstop).
 */
export async function runGather(
  requests: GatherRequest[],
  registry: CapabilityRegistry,
  ctx: RunContext,
): Promise<GatherOutcome> {
  const inputs = await Promise.all(
    requests.map(async (req): Promise<GatheredInput> => {
      const provider = registry.resolve(req.requires);
      if (!provider) {
        throw new Error(`No provider advertises capability '${req.requires}' (gather cannot run).`);
      }

      const { result, sourceRef } = await provider.run(req.query, ctx);

      const artifact: Artifact = {
        producer: `${req.requires}@inproc`,
        capability: req.requires,
        query: req.query ?? null,
        result,
        producedAt: ctx.producedAt,
        ...(sourceRef ? { sourceRef } : {}),
      };

      // We build the artifact ourselves here, so id == artifactId(artifact) by
      // construction. The recompute matters when the provider is REMOTE and
      // returns a claimed id (trust-but-verify); resolving that is the executor's
      // job when it wires the remote registry.
      const id = await putArtifact(artifact);
      const check = artifactId(artifact);
      if (id !== check) {
        throw new Error(`Artifact id mismatch for '${req.requires}' (${id} != ${check}).`);
      }

      return { produces: req.produces, capability: req.requires, value: result, artifactId: id, sourceRef };
    }),
  );

  return { artifactIds: inputs.map((i) => i.artifactId), inputs };
}
