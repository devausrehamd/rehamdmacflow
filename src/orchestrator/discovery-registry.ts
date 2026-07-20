// src/orchestrator/discovery-registry.ts
//
// Discovery-backed capability resolution (Stage 1 of the agent-platform control
// plane, docs/specs/SPEC-agent-platform-and-control-plane.md).
//
// A recipe step names a CAPABILITY ("research:qms"), not an address. This module
// resolves a capability to a live agent that advertises it, by reading Discovery's
// registry (GET /v1/agents). It is the remote counterpart to the in-process
// registry from Phase 5: same idea (bind on capability), a real registry behind it.
//
// Resolution only. The runnable remote provider that DISPATCHES to the resolved
// address arrives with the agent invocation endpoint in a later stage; here the
// concern is strictly "who can do X, where, and is it live?".
//
// The agent list is injected (a function returning the current live agents), so
// the resolution logic is testable with a fixture and no network. `discoveryAgents`
// is the production source, backed by Discovery over HTTP.

/** One live agent as resolved from Discovery's Agent Card. */
export interface DiscoveredAgent {
  guid: string;
  name: string;
  /** Where to reach it right now (a Discovery lease, refreshed by heartbeat). */
  address: string;
  capabilities: string[];
  /** debug output can never be approved, so production is preferred when resolving. */
  mode: "production" | "debug";
  gitCommit: string;
}

export interface CapabilityResolver {
  /** The union of capabilities advertised by all live agents — feeds the recipe
   *  capability pre-flight (validateRecipe). */
  available(): Promise<Set<string>>;
  /** Every live agent advertising the capability (for fan-out / load choice). */
  resolveAll(capability: string): Promise<DiscoveredAgent[]>;
  /** One live agent advertising the capability, preferring production, or null. */
  resolve(capability: string): Promise<DiscoveredAgent | null>;
}

/**
 * Build a resolver over a function that returns the current live agents. Inject a
 * fixture in tests; inject `discoveryAgents(url)` in production.
 */
export function capabilityResolver(fetchAgents: () => Promise<DiscoveredAgent[]>): CapabilityResolver {
  return {
    async available() {
      const set = new Set<string>();
      for (const a of await fetchAgents()) for (const c of a.capabilities) set.add(c);
      return set;
    },

    async resolveAll(capability) {
      return (await fetchAgents()).filter((a) => a.capabilities.includes(capability));
    },

    async resolve(capability) {
      const matches = (await fetchAgents()).filter((a) => a.capabilities.includes(capability));
      if (matches.length === 0) return null;
      // Prefer a production instance; a debug instance's output can never be
      // approved, so it is only a fallback when no production agent serves this.
      return matches.find((a) => a.mode === "production") ?? matches[0]!;
    },
  };
}

/**
 * The live-agents source backed by Discovery. Reads GET /v1/agents (which already
 * excludes agents whose lease has expired) and maps each Agent Card to a
 * DiscoveredAgent, skipping any malformed entry.
 */
export function discoveryAgents(baseUrl: string): () => Promise<DiscoveredAgent[]> {
  return async () => {
    const res = await fetch(`${baseUrl}/v1/agents`);
    if (!res.ok) {
      throw new Error(`Discovery returned ${res.status} at ${baseUrl}/v1/agents`);
    }
    const body = (await res.json()) as { agents?: unknown[] };
    const raw = Array.isArray(body.agents) ? body.agents : [];
    return raw.map(toDiscoveredAgent).filter((a): a is DiscoveredAgent => a !== null);
  };
}

/** Structurally map one Agent Card to a DiscoveredAgent; null if it lacks the
 *  fields resolution requires (guid, address). Capabilities default to empty. */
function toDiscoveredAgent(card: unknown): DiscoveredAgent | null {
  if (!card || typeof card !== "object") return null;
  const c = card as Record<string, unknown>;
  if (typeof c.guid !== "string" || typeof c.address !== "string") return null;
  const capabilities = Array.isArray(c.capabilities)
    ? c.capabilities.filter((x): x is string => typeof x === "string")
    : [];
  return {
    guid: c.guid,
    name: typeof c.name === "string" ? c.name : c.guid,
    address: c.address,
    capabilities,
    mode: c.mode === "debug" ? "debug" : "production",
    gitCommit: typeof c.gitCommit === "string" ? c.gitCommit : "unknown",
  };
}
