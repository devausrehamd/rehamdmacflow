// scripts/smoke-test-discovery-registry.ts
//
// Discovery-backed capability resolution (Stage 1 of the agent-platform spec).
// Proves the resolution logic the orchestrator will use to turn a capability into
// a live agent:
//
//   - available() is the union of capabilities across all live agents
//   - resolveAll returns every live agent advertising a capability
//   - resolve returns one, PREFERRING production over debug
//   - resolve falls back to a debug agent when no production agent serves it
//   - an unadvertised capability resolves to null
//   - an empty registry resolves to null / empty
//   - malformed Agent Cards are skipped, not fatal
//
// Pure: the agent list is injected, so there is no network, DB, or LLM.
//
// Usage: npm run smoke:discovery-registry

import { capabilityResolver, type DiscoveredAgent } from "../src/orchestrator/discovery-registry.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

function agent(over: Partial<DiscoveredAgent>): DiscoveredAgent {
  return { guid: "g", name: "n", address: "http://a", capabilities: [], mode: "production", gitCommit: "abc", ...over };
}

// A live registry: qms served by a production and a debug instance; web by one
// production; export only by a debug instance.
const fleet: DiscoveredAgent[] = [
  agent({ guid: "qms-prod", address: "http://qms-prod:4000", capabilities: ["research:qms", "research:web"], mode: "production" }),
  agent({ guid: "qms-debug", address: "http://qms-debug:4001", capabilities: ["research:qms"], mode: "debug" }),
  agent({ guid: "export-debug", address: "http://export:4001", capabilities: ["export:docx"], mode: "debug" }),
];
const from = (list: DiscoveredAgent[]) => () => Promise.resolve(list);

async function main(): Promise<void> {
  console.log("=== Discovery capability resolver smoke test ===\n");
  const r = capabilityResolver(from(fleet));

  // available() = union
  const avail = await r.available();
  check("available() is the union of all advertised capabilities",
    avail.size === 3 && ["research:qms", "research:web", "export:docx"].every((c) => avail.has(c)),
    [...avail].join(","));

  // resolveAll
  const all = await r.resolveAll("research:qms");
  check("resolveAll returns every live agent advertising it", all.length === 2);
  check("  including both production and debug instances",
    all.some((a) => a.mode === "production") && all.some((a) => a.mode === "debug"));

  // resolve prefers production
  const one = await r.resolve("research:qms");
  check("resolve returns a live agent", one !== null);
  check("resolve prefers production over debug", one?.mode === "production" && one.guid === "qms-prod");
  check("  and carries the address to reach it", one?.address === "http://qms-prod:4000");

  // resolve falls back to debug when no production agent serves it
  const exp = await r.resolve("export:docx");
  check("resolve falls back to debug when no production agent serves it",
    exp !== null && exp.mode === "debug" && exp.guid === "export-debug");

  // web is on one production agent only
  check("resolve picks the sole production web agent", (await r.resolve("research:web"))?.guid === "qms-prod");

  // unknown capability
  check("unadvertised capability -> null", (await r.resolve("act:email")) === null);
  check("unadvertised capability -> empty resolveAll", (await r.resolveAll("act:email")).length === 0);

  // empty registry
  const empty = capabilityResolver(from([]));
  check("empty registry -> available() empty", (await empty.available()).size === 0);
  check("empty registry -> resolve null", (await empty.resolve("research:qms")) === null);

  console.log("");
  if (failed === 0) console.log(`${GREEN}Capability resolver is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
