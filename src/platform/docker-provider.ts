// src/platform/docker-provider.ts
//
// The Docker implementation of ComputeProvider (SPEC-operational-control-plane.md,
// D2a). Provisions an agent as a local container using the D0 image and role-boot
// flow, now behind the provider contract. A cloud provider replaces THIS file and
// nothing else (decision 7).
//
// It holds no long-lived state: an instance is a container named `qms-inst-*` and
// labelled `qms.instance=1`, and its GUID is read back from Discovery by matching
// the unique address the container was told to advertise. So a restart of whatever
// runs this provider can still `list()` and reconcile the running instances.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { ComputeProvider, InstanceSpec, InstanceStatus, ProvisionedInstance } from "./compute-provider.js";

const pexec = promisify(execFile);

const DOCKER = process.env.QMS_DOCKER_BIN ?? "docker";
const IMAGE = process.env.QMS_AGENT_IMAGE ?? "qms-agent:d0";
// How a container reaches host services. host.docker.internal on Docker Desktop /
// Colima; overridable for other substrates.
const HOST_ALIAS = process.env.QMS_CONTAINER_HOST ?? "host.docker.internal";
const LABEL = "qms.instance=1";

function discoveryUrl(): string {
  return process.env.QMS_DISCOVERY_URL ?? "http://localhost:3005";
}

// Service configuration forwarded into every instance, with localhost rewritten
// to the host alias so the container reaches host-run services. Instance-specific
// values (address, manifest, ports) are set separately and NOT rewritten.
const FORWARD_ENV = [
  "QMS_DISCOVERY_URL", "QMS_DISCOVERY_TOKEN",
  "QMS_IDENTITY_MODE", "QMS_IDENTITY_URL", "QMS_IDENTITY_ISSUER", "QMS_IDENTITY_SERVICE_TOKEN", "QMS_IDENTITY_TIMEOUT_MS",
  "QMS_SERVICE_TOKEN", "JWT_SECRET",
  "OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_EMBED_MODEL",
  "QDRANT_URL", "QDRANT_OPERATIONS_URL", "QDRANT_OPERATIONS_COLLECTION", "QDRANT_COLLECTION",
  "REDIS_HOST", "REDIS_PORT", "REDIS_OPERATIONS_HOST", "REDIS_OPERATIONS_PORT",
  "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DATABASE",
  "POSTGRES_READONLY_USER", "POSTGRES_READONLY_PASSWORD", "DATABASE_URL",
  "QMS_DOMAIN", "QMS_ENFORCE_LABELS",
  "LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "QMS_PROVENANCE_API_URL",
  "ACCESS_TOKEN_TTL_MINUTES", "REFRESH_TOKEN_TTL_DAYS", "LOG_LEVEL", "QMS_FOLDER",
  "QMS_RUBRICS_RELEASE_REF", "QMS_QDRANT_COLLECTION_OVERRIDE",
];

async function docker(args: string[], timeoutMs = 60000): Promise<string> {
  const { stdout } = await pexec(DOCKER, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function forwardedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARD_ENV) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v.replace(/\b(?:localhost|127\.0\.0\.1)\b/g, HOST_ALIAS);
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(address: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${address}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1500);
  }
  throw new Error(`instance at ${address} never became healthy within ${timeoutMs}ms`);
}

interface DiscoveryCard { guid: string; address: string; health?: string }

async function discoveryAgents(): Promise<DiscoveryCard[]> {
  const res = await fetch(`${discoveryUrl()}/v1/agents`);
  if (!res.ok) return [];
  const body = (await res.json()) as { agents?: DiscoveryCard[] };
  return body.agents ?? [];
}

/** Read the GUID Discovery assigned to the agent that advertised `address`. */
async function correlateGuid(address: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await discoveryAgents().catch(() => [])).find((a) => a.address === address);
    if (found?.guid) return found.guid;
    await sleep(1500);
  }
  throw new Error(`agent at ${address} did not register with Discovery within ${timeoutMs}ms`);
}

export function dockerProvider(): ComputeProvider {
  return {
    kind: "docker",

    async provision(spec: InstanceSpec): Promise<ProvisionedInstance> {
      const port = await getFreePort();
      const address = `http://localhost:${port}`;
      const name = `qms-inst-${randomUUID().slice(0, 8)}`;

      const env: Record<string, string> = {
        ...forwardedEnv(),
        QMS_MODE: "production",
        API_PORT: "4000",
        QMS_MANIFEST: `/app/${spec.manifest}`,
        QMS_AGENT_ADDRESS: address,
        QMS_AGENT_NAME: name,
        QMS_AGENT_GROUP: name,
        QMS_AGENT_GUID_FILE: "/tmp/agent-guid.txt",
        // The instance's OWN Data Access API, inside the container (decision 13).
        QMS_API_INTERNAL_URL: "http://localhost:4000",
        ...(spec.env ?? {}),
      };
      const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

      await docker(["run", "-d", "--name", name, "-p", `${port}:4000`, "--label", LABEL, ...envFlags, IMAGE]);

      try {
        await waitHealthy(address, Number(process.env.QMS_PROVISION_HEALTH_MS ?? 90_000));
        const guid = await correlateGuid(address, Number(process.env.QMS_PROVISION_REGISTER_MS ?? 45_000));
        return { instanceId: name, guid, address, status: "ready" };
      } catch (err) {
        // Surface why it never came up, then never leak a half-started container.
        const logs = await docker(["logs", "--tail", "30", name]).catch(() => "(logs unavailable)");
        await docker(["rm", "-f", name]).catch(() => {});
        throw new Error(`provision failed: ${err instanceof Error ? err.message : err}\n--- container logs ---\n${logs}`);
      }
    },

    async destroy(instanceId: string): Promise<void> {
      await docker(["rm", "-f", instanceId]).catch(() => {}); // idempotent
    },

    async status(instanceId: string): Promise<InstanceStatus> {
      const running = await docker(["inspect", "-f", "{{.State.Running}}", instanceId])
        .then((s) => s === "true")
        .catch(() => false);
      if (!running) return { instanceId, running: false, health: "unknown" };
      // Resolve the mapped host port, then probe health.
      const mapped = await docker(["port", instanceId, "4000"]).catch(() => "");
      const port = mapped.split(":").pop()?.trim();
      const address = port ? `http://localhost:${port}` : undefined;
      let health: InstanceStatus["health"] = "unknown";
      if (address) {
        health = await fetch(`${address}/health`).then((r) => (r.ok ? "healthy" : "unhealthy")).catch(() => "unhealthy");
      }
      return { instanceId, running: true, address, health };
    },

    async list(): Promise<InstanceStatus[]> {
      const out = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]).catch(() => "");
      const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
      return Promise.all(names.map((n) => this.status(n)));
    },
  };
}
