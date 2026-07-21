// scripts/smoke-test-api-launcher-live.ts
//
// The ApiLauncher (operational control plane, D2b): the Supervisor's Launcher as a
// client to the Provisioning API. Proves the Supervisor can spawn and reap a role
// agent WITHOUT any Docker knowledge — it holds only this launcher and a token:
//
//   - launch(manifest) provisions a researcher and resolves when ready, returning
//     its GUID + address; the agent is live in Discovery and answers /health
//   - stop(guid) destroys it — the address stops answering
//
// This is exactly what the Supervisor's ensureRunning calls (D4). Needs
// Colima/Docker, Discovery, ID Server, and the agent image (qms-agent:d0).
//
// Usage: npm run integration:api-launcher

import type { Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "../src/api/server.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
import { apiLauncher } from "../src/platform/api-launcher.js";
import { loadManifest } from "../src/platform/manifest.js";
import { idServerLogin } from "./_login.js";

const pexec = promisify(execFile);
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

const TEST_PORT = 4122;
const BASE = `http://localhost:${TEST_PORT}`;
const DISCOVERY = process.env.QMS_DISCOVERY_URL ?? "http://localhost:3005";
const IMAGE = process.env.QMS_AGENT_IMAGE ?? "qms-agent:d0";
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

async function healthy(address: string): Promise<boolean> {
  return fetch(`${address}/health`).then((r) => r.ok).catch(() => false);
}
async function inDiscovery(guid: string): Promise<boolean> {
  const res = await fetch(`${DISCOVERY}/v1/agents`).catch(() => null);
  if (!res || !res.ok) return false;
  const body = (await res.json()) as { agents?: { guid: string }[] };
  return (body.agents ?? []).some((a) => a.guid === guid);
}

async function main(): Promise<void> {
  console.log("=== ApiLauncher (live) — the Supervisor spawns/reaps without Docker knowledge ===\n");
  let server: Server | null = null;
  let launchedGuid: string | undefined;

  try {
    await pexec("docker", ["info"]);
    try { await pexec("docker", ["image", "inspect", IMAGE]); }
    catch { console.log(`  building ${IMAGE} …`); await pexec("docker", ["build", "-t", IMAGE, "."], { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }); }

    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });
    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));

    const manifest = loadManifest("agents/researcher.json").manifest;
    const launcher = apiLauncher({ baseUrl: BASE, token: token!, manifestPath: (m) => `agents/${m.role}.json` });

    // --- launch ---
    console.log("  launching a researcher through the ApiLauncher …");
    const agent = await launcher.launch(manifest);
    launchedGuid = agent.guid;
    check("launch returns a GUID + address", Boolean(agent.guid) && Boolean(agent.address));
    check("  the agent is live in Discovery", await inDiscovery(agent.guid));
    check("  and answers /health at its address", await healthy(agent.address));

    // --- stop ---
    await launcher.stop(agent.guid);
    launchedGuid = undefined;
    // The container is destroyed ungracefully, so it stops answering immediately
    // (Discovery drops it later on lease expiry).
    let up = true;
    for (let i = 0; i < 5 && up; i++) { up = await healthy(agent.address); if (up) await new Promise((r) => setTimeout(r, 1000)); }
    check("stop destroys the instance (its address stops answering)", !up);
  } finally {
    void launchedGuid;
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
    // Belt-and-suspenders: reap any instance this run started (incl. a failure
    // before stop). Tests run sequentially, so clearing our label is safe.
    await pexec("bash", ["-c", "docker ps -aq --filter label=qms.instance=1 | xargs -r docker rm -f"]).catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}The Supervisor can spawn and reap role agents through the API.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
