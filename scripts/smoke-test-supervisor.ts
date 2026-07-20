// scripts/smoke-test-supervisor.ts
//
// The Supervisor (Stage 4 of the agent-platform spec). Proves the launch-plane
// logic with an injected launcher, clock, and resolver — no real processes:
//
//   - ensureRunning returns an already-live agent WITHOUT launching
//   - ensureRunning launches from the manifest when none is live
//   - concurrent ensureRunning for one capability launches ONCE (dedupe)
//   - a capability with no manifest is a loud error
//   - TTL: an agent idle past the TTL is destroyed; touch() keeps it alive
//
// Pure: no network, DB, or LLM.
//
// Usage: npm run smoke:supervisor

import { capabilityResolver, type DiscoveredAgent } from "../src/orchestrator/discovery-registry.js";
import { parseManifest, type AgentManifest } from "../src/platform/manifest.js";
import { createSupervisor, manifestIndex, type Launcher } from "../src/platform/supervisor.js";

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

const manifest: AgentManifest = parseManifest({
  name: "qms-eng-research",
  role: "researcher",
  capabilities: ["research:qms"],
  identity: { idServerUrl: "http://localhost:3001", issuer: "rehamd-idserver", serviceTokenEnv: "IDSERVER_SERVICE_TOKEN" },
});
const manifests = manifestIndex([manifest]);

function liveAgent(): DiscoveredAgent {
  return { guid: "already-live", name: "qms", address: "http://live:4000", capabilities: ["research:qms"], mode: "production", gitCommit: "abc" };
}

/** A counting launcher. `delayMs` lets two concurrent launches overlap so the
 *  dedupe is observable. */
function stubLauncher(delay = 0): Launcher & { launched: string[]; stopped: string[] } {
  const l = {
    launched: [] as string[],
    stopped: [] as string[],
    async launch(m: AgentManifest) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const guid = `launched-${m.name}-${l.launched.length}`;
      l.launched.push(guid);
      return { guid, address: `http://${guid}:4000` };
    },
    async stop(guid: string) {
      l.stopped.push(guid);
    },
  };
  return l;
}

const TTL = 60_000;

async function main(): Promise<void> {
  console.log("=== Supervisor smoke test ===\n");

  // --- 1. Already live -> no launch ---
  {
    const launcher = stubLauncher();
    const sup = createSupervisor({ resolver: capabilityResolver(() => Promise.resolve([liveAgent()])), launcher, manifests, ttlMs: TTL, now: () => 1000 });
    const got = await sup.ensureRunning("research:qms");
    check("already-live capability resolves without launching", got.guid === "already-live" && launcher.launched.length === 0);
  }

  // --- 2. Not live -> launch from the manifest ---
  {
    const launcher = stubLauncher();
    const sup = createSupervisor({ resolver: capabilityResolver(() => Promise.resolve([])), launcher, manifests, ttlMs: TTL, now: () => 1000 });
    const got = await sup.ensureRunning("research:qms");
    check("missing capability is launched from its manifest", launcher.launched.length === 1 && got.guid === launcher.launched[0]);
    check("  the launched agent is tracked as running", sup.running().some((r) => r.guid === got.guid && r.capability === "research:qms"));
  }

  // --- 3. No manifest -> loud error ---
  {
    const sup = createSupervisor({ resolver: capabilityResolver(() => Promise.resolve([])), launcher: stubLauncher(), manifests, ttlMs: TTL, now: () => 1000 });
    let threw = false;
    try { await sup.ensureRunning("research:web"); } catch { threw = true; }
    check("capability with no manifest -> error", threw);
  }

  // --- 4. Concurrent ensureRunning -> launch once ---
  {
    const launcher = stubLauncher(15);
    const sup = createSupervisor({ resolver: capabilityResolver(() => Promise.resolve([])), launcher, manifests, ttlMs: TTL, now: () => 1000 });
    const [a, b] = await Promise.all([sup.ensureRunning("research:qms"), sup.ensureRunning("research:qms")]);
    check("concurrent ensureRunning launches ONCE (dedupe)", launcher.launched.length === 1);
    check("  both callers get the same agent", a.guid === b.guid);
  }

  // --- 5. TTL idle-destroy, and touch keeps alive ---
  {
    const launcher = stubLauncher();
    let clock = 1000;
    const sup = createSupervisor({ resolver: capabilityResolver(() => Promise.resolve([])), launcher, manifests, ttlMs: TTL, now: () => clock });
    const { guid } = await sup.ensureRunning("research:qms"); // lastActivity = 1000

    clock = 1000 + TTL - 1; // still within TTL
    check("agent within TTL is not swept", (await sup.sweepIdle()).length === 0 && sup.running().length === 1);

    sup.touch(guid); // activity at clock = 1000 + TTL - 1
    clock = clock + TTL - 1; // advance, but not a full TTL since the touch
    check("touch() keeps a busy agent alive", (await sup.sweepIdle()).length === 0);

    clock = clock + TTL + 1; // now well past the TTL since last activity
    const destroyed = await sup.sweepIdle();
    check("agent idle past the TTL is destroyed", destroyed.includes(guid) && launcher.stopped.includes(guid));
    check("  and removed from the running set", sup.running().length === 0);
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Supervisor is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
