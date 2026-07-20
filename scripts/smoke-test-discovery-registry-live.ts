// scripts/smoke-test-discovery-registry-live.ts
//
// Stage 1 against a LIVE Discovery service: proves discoveryAgents() reads the
// real registry (GET /v1/agents) and the resolver resolves real Agent Cards.
//
// Registers two isolated fixture agents (unique capabilities, so any real agents
// already registered do not affect the assertions), resolves them through the
// HTTP path, then deregisters them.
//
// Needs Discovery running (:3005). No LLM, no DB.
//
// Usage: npm run integration:discovery-registry

import { capabilityResolver, discoveryAgents } from "../src/orchestrator/discovery-registry.js";

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

const DISCOVERY_URL = process.env.QMS_DISCOVERY_URL ?? "http://localhost:3005";
const REGISTER_TOKEN = process.env.DISCOVERY_REGISTER_TOKEN;

// Unique capabilities so this test is isolated from any real registered agents.
const CAP_A = "test:resolver-alpha";
const CAP_B = "test:resolver-beta";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (REGISTER_TOKEN) h.Authorization = `Bearer ${REGISTER_TOKEN}`;
  return h;
}

async function register(card: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${DISCOVERY_URL}/v1/agents/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(card),
  });
  if (!res.ok) {
    throw new Error(`register ${card.guid} failed (${res.status}) at ${DISCOVERY_URL}. Is Discovery running (./stack.sh start discovery)?`);
  }
}

async function deregister(guid: string): Promise<void> {
  await fetch(`${DISCOVERY_URL}/v1/agents/${guid}`, { method: "DELETE", headers: headers() }).catch(() => {});
}

const guidA = `test_resolver_a_${Date.now().toString(16)}`;
const guidB = `test_resolver_b_${Date.now().toString(16)}`;

async function main(): Promise<void> {
  console.log("=== Discovery capability resolver (live) integration test ===\n");
  const resolver = capabilityResolver(discoveryAgents(DISCOVERY_URL));

  try {
    await register({ guid: guidA, name: "resolver-fixture-a", gitCommit: "0".repeat(40), address: "http://fixture-a:4000", capabilities: [CAP_A, CAP_B], mode: "production" });
    await register({ guid: guidB, name: "resolver-fixture-b", gitCommit: "0".repeat(40), address: "http://fixture-b:4001", capabilities: [CAP_B], mode: "debug" });
    check("registered two fixture agents", true);

    const avail = await resolver.available();
    check("available() includes both fixture capabilities from the live registry", avail.has(CAP_A) && avail.has(CAP_B));

    const a = await resolver.resolve(CAP_A);
    check("resolve reads the real Agent Card (guid + address)", a?.guid === guidA && a.address === "http://fixture-a:4000");

    const bAll = await resolver.resolveAll(CAP_B);
    check("resolveAll returns both agents advertising the shared capability", bAll.length === 2 && bAll.some((x) => x.guid === guidA) && bAll.some((x) => x.guid === guidB));

    const b = await resolver.resolve(CAP_B);
    check("resolve prefers the production instance for the shared capability", b?.guid === guidA && b.mode === "production");
  } finally {
    await deregister(guidA);
    await deregister(guidB);
  }

  // After deregistration the fixture capabilities are gone from the live registry.
  const after = await resolver.available().catch(() => new Set<string>());
  check("deregistered fixtures no longer resolvable", !after.has(CAP_A) && !after.has(CAP_B));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Live capability resolution is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await deregister(guidA);
  await deregister(guidB);
  process.exit(1);
});
