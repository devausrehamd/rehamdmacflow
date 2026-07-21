// scripts/smoke-test-provisioning-live.ts
//
// The Provisioning API + Docker provider (operational control plane, D2a), end to
// end. Proves that instance lifecycle is API-mediated and provider-backed:
//
//   - POST /api/v1/instances provisions a researcher and resolves only when it is
//     READY — the response carries its GUID and address, and it is live in Discovery
//   - GET /api/v1/instances/:id reports it running and healthy
//   - DELETE /api/v1/instances/:id destroys it (idempotently)
//   - the API is the gate: an unauthenticated provision is rejected (401)
//
// The Supervisor never appears here — this is the contract it will call (D2b).
// Swapping Docker for a cloud VM is one provider class behind this same API.
//
// Needs: Colima/Docker, Discovery :3005, ID Server :3001, and the agent image
// (qms-agent:d0; built here if missing). Slow — it starts a real container.
//
// Usage: npm run integration:provisioning

import type { Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "../src/api/server.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
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

const TEST_PORT = 4121;
const BASE = `http://localhost:${TEST_PORT}`;
const DISCOVERY = process.env.QMS_DISCOVERY_URL ?? "http://localhost:3005";
const IMAGE = process.env.QMS_AGENT_IMAGE ?? "qms-agent:d0";
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

interface Instance { provider?: string; instanceId?: string; guid?: string; address?: string; status?: string }

async function ensureImage(): Promise<void> {
  try {
    await pexec("docker", ["image", "inspect", IMAGE]);
  } catch {
    console.log(`  building ${IMAGE} (missing) …`);
    await pexec("docker", ["build", "-t", IMAGE, "."], { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  }
}

async function inDiscovery(guid: string): Promise<boolean> {
  const res = await fetch(`${DISCOVERY}/v1/agents`).catch(() => null);
  if (!res || !res.ok) return false;
  const body = (await res.json()) as { agents?: { guid: string }[] };
  return (body.agents ?? []).some((a) => a.guid === guid);
}

async function main(): Promise<void> {
  console.log("=== Provisioning API + Docker provider (live) ===\n");
  let server: Server | null = null;
  let instanceId: string | undefined;

  try {
    await pexec("docker", ["info"]); // fail fast if Docker is down
    await ensureImage();

    const app = createServer();
    await new Promise<void>((resolve) => { server = app.listen(TEST_PORT, () => resolve()); });

    // Gate: no token -> 401.
    const unauth = await fetch(`${BASE}/api/v1/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: "agents/researcher.json" }),
    });
    check("unauthenticated provision is rejected (401)", unauth.status === 401, `got ${unauth.status}`);

    const token = await idServerLogin(LOGIN_USER, LOGIN_PASS);
    check("logged in for a bearer token", Boolean(token));
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    // Provision a researcher through the API (resolves when ready — can take ~15s).
    console.log("  provisioning a researcher container through the API …");
    const res = await fetch(`${BASE}/api/v1/instances`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ manifest: "agents/researcher.json" }),
    });
    const instance = res.ok ? ((await res.json()) as Instance) : {};
    instanceId = instance.instanceId;
    check("POST /instances returns 201", res.status === 201, `got ${res.status}`);
    check("  it reports the docker provider", instance.provider === "docker");
    check("  it resolved to a ready instance with a GUID + address", instance.status === "ready" && Boolean(instance.guid) && Boolean(instance.address));
    check("  the instance is live in Discovery", instance.guid ? await inDiscovery(instance.guid) : false);

    // Status.
    const statusRes = await fetch(`${BASE}/api/v1/instances/${instanceId}`, { headers: auth });
    const status = (await statusRes.json()) as { running?: boolean; health?: string };
    check("GET /instances/:id reports it running + healthy", status.running === true && status.health === "healthy");

    // Destroy.
    const del = await fetch(`${BASE}/api/v1/instances/${instanceId}`, { method: "DELETE", headers: auth });
    check("DELETE /instances/:id returns ok", del.ok);
    const gone = (await (await fetch(`${BASE}/api/v1/instances/${instanceId}`, { headers: auth })).json()) as { running?: boolean };
    check("  the instance is destroyed (no longer running)", gone.running === false);
    instanceId = undefined; // destroyed; nothing to clean up
  } finally {
    if (instanceId) await pexec("docker", ["rm", "-f", instanceId]).catch(() => {});
    if (server) await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Compute provisioning is API-mediated.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
