// scripts/smoke-test-manifest-live.ts
//
// Stage 2 against a LIVE Discovery service: a manifest-derived Agent Card
// registers, and the ready-vs-up distinction is visible.
//
//   - agentCardFromManifest -> a card that registers with Discovery
//   - registering with health "healthy" advertises READY
//   - registering with health "unknown" advertises UP-but-not-ready
//   - the live registry returns the manifest's name + capabilities
//
// Isolated by a unique capability so real agents do not interfere. Cleans up.
//
// Needs Discovery running (:3005). No LLM, no DB.
//
// Usage: npm run integration:manifest

import { parseManifest, agentCardFromManifest } from "../src/platform/manifest.js";

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
const CAP = "test:manifest-ready";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (REGISTER_TOKEN) h.Authorization = `Bearer ${REGISTER_TOKEN}`;
  return h;
}

async function register(card: Record<string, unknown>, health: string): Promise<void> {
  const res = await fetch(`${DISCOVERY_URL}/v1/agents/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...card, health }),
  });
  if (!res.ok) {
    throw new Error(`register ${card.guid} failed (${res.status}) at ${DISCOVERY_URL}. Is Discovery running (./stack.sh start discovery)?`);
  }
}
async function deregister(guid: string): Promise<void> {
  await fetch(`${DISCOVERY_URL}/v1/agents/${guid}`, { method: "DELETE", headers: headers() }).catch(() => {});
}
interface AgentListEntry {
  guid: string;
  health?: string;
  name?: string;
  capabilities?: string[];
}
async function findAgent(guid: string): Promise<AgentListEntry | null> {
  const res = await fetch(`${DISCOVERY_URL}/v1/agents`);
  const body = (await res.json()) as { agents?: AgentListEntry[] };
  return (body.agents ?? []).find((a) => a.guid === guid) ?? null;
}

// A manifest with an isolating capability, built through the real schema.
const manifest = parseManifest({
  name: "test-manifest-agent",
  role: "researcher",
  capabilities: [CAP],
  identity: { idServerUrl: "http://localhost:3001", issuer: "rehamd-idserver", serviceTokenEnv: "IDSERVER_SERVICE_TOKEN" },
});

const readyGuid = `test_manifest_ready_${Date.now().toString(16)}`;
const upGuid = `test_manifest_up_${Date.now().toString(16)}`;

async function main(): Promise<void> {
  console.log("=== Agent manifest (live registration) integration test ===\n");

  try {
    const readyCard = agentCardFromManifest(manifest, { guid: readyGuid, address: "http://fixture-ready:4000", gitCommit: "0".repeat(40), mode: "production", configCommit: "c".repeat(40) });
    const upCard = agentCardFromManifest(manifest, { guid: upGuid, address: "http://fixture-up:4000", gitCommit: "0".repeat(40), mode: "production" });

    await register(readyCard, "healthy");
    await register(upCard, "unknown");
    check("both manifest-derived cards registered", true);

    const ready = await findAgent(readyGuid);
    check("ready agent appears in the live registry", ready !== null);
    check("  it advertises the manifest name and capability",
      ready?.name === "test-manifest-agent" && (ready?.capabilities ?? []).includes(CAP));
    check("  its health is READY (healthy)", ready?.health === "healthy");

    const up = await findAgent(upGuid);
    check("the up-but-not-ready agent is present but NOT ready", up !== null && up.health === "unknown");
  } finally {
    await deregister(readyGuid);
    await deregister(upGuid);
  }

  const gone = await findAgent(readyGuid);
  check("deregistered agent removed from the registry", gone === null);

  console.log("");
  if (failed === 0) console.log(`${GREEN}Manifest registration is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await deregister(readyGuid);
  await deregister(upGuid);
  process.exit(1);
});
