// src/orchestrator/capabilities.ts
//
// Capability dispatch (Phase 5 of docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// A recipe step names a CAPABILITY ("research:qms"), not an address. The
// orchestrator resolves the capability to a provider through a registry. Today
// the registry is in-process (local provider functions); later it resolves to a
// remote agent via Discovery. The gather orchestration does not care which,
// because both satisfy this one interface — that is the whole point of binding
// on capability instead of address.
//
// A provider is a DUMB role agent: it takes a query and returns data. It never
// writes custody, never hashes or stores an artifact, never touches the chain.
// The orchestrator does all of that. Keep it that way — a provider that imports
// the ledger has broken the single-writer invariant.

/** Ambient context handed to a provider for one run. */
export interface RunContext {
  correlationId: string;
  runId: string;
  /** ISO timestamp stamped on gathered artifacts. Injectable so a test can make
   *  an artifact's content (and therefore its id) reproducible. */
  producedAt: string;
}

/** A single-responsibility role agent bound to one capability. Returns data only. */
export interface CapabilityProvider {
  capability: string;
  run(query: unknown, ctx: RunContext): Promise<{ result: unknown; sourceRef?: string }>;
}

/** Resolves a capability id to a provider, and enumerates what is available (the
 *  set the recipe capability pre-flight checks against). */
export interface CapabilityRegistry {
  resolve(capability: string): CapabilityProvider | null;
  available(): Set<string>;
}

/**
 * An in-process registry: capabilities served by local provider functions. The
 * remote (Discovery-resolved) registry lands later and satisfies the same
 * interface, so nothing downstream changes when it does.
 */
export function inProcessRegistry(providers: CapabilityProvider[]): CapabilityRegistry {
  const map = new Map(providers.map((p) => [p.capability, p]));
  return {
    resolve: (capability) => map.get(capability) ?? null,
    available: () => new Set(map.keys()),
  };
}
