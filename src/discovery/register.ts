// src/discovery/register.ts  (AGENT side)
//
// Self-registration with the Discovery service. On startup the agent announces
// its Agent Card (guid, gitCommit, address, observability url) and then
// heartbeats to keep its lease alive. On shutdown it deregisters.
//
// The GUID is generated ONCE and persisted, so a restarted agent keeps its
// identity (and its rubric drafts, keyed to it) rather than appearing as a
// brand-new agent. The git commit is read so the exact codebase is advertised.
//
// Discovery is soft state: if it restarts and forgets us, our next heartbeat
// 404s with { reregister: true } and we re-register - a Discovery bounce heals
// within one heartbeat interval without operator action.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname } from "node:path";

export interface RegisterConfig {
  discoveryUrl: string;
  name: string;
  address: string;
  observabilityUrl?: string;
  capabilities?: string[];
  registerToken?: string;
  guidFile?: string;
  heartbeatMs?: number;
}

function stableGuid(guidFile: string): string {
  if (existsSync(guidFile)) {
    const g = readFileSync(guidFile, "utf8").trim();
    if (g) return g;
  }
  const g = `agt_${randomUUID().replace(/-/g, "")}`;
  mkdirSync(dirname(guidFile), { recursive: true });
  writeFileSync(guidFile, g, "utf8");
  return g;
}

function gitCommit(): string {
  if (process.env.QMS_GIT_COMMIT) return process.env.QMS_GIT_COMMIT;
  try { return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

export class DiscoveryClient {
  private guid: string;
  private commit: string;
  private timer?: ReturnType<typeof setInterval>;
  private readonly heartbeatMs: number;

  constructor(private readonly cfg: RegisterConfig) {
    this.guid = stableGuid(cfg.guidFile ?? "./identity/agent-guid.txt");
    this.commit = gitCommit();
    this.heartbeatMs = cfg.heartbeatMs ?? 10000;
  }

  get agentGuid(): string { return this.guid; }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.cfg.registerToken ? { Authorization: `Bearer ${this.cfg.registerToken}` } : {}),
    };
  }

  private card() {
    return {
      guid: this.guid,
      name: this.cfg.name,
      gitCommit: this.commit,
      address: this.cfg.address,
      observabilityUrl: this.cfg.observabilityUrl,
      capabilities: this.cfg.capabilities ?? [],
    };
  }

  async start(): Promise<void> {
    await this.register();
    this.timer = setInterval(() => { void this.heartbeat(); }, this.heartbeatMs);
    const stop = () => { void this.stop(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  private async register(): Promise<void> {
    try {
      const res = await fetch(`${this.cfg.discoveryUrl}/v1/agents/register`, {
        method: "POST", headers: this.headers(), body: JSON.stringify(this.card()),
      });
      if (res.ok) console.log(`Discovery: registered as ${this.guid} (commit ${this.commit.slice(0, 8)})`);
      else console.warn(`Discovery: register returned ${res.status}`);
    } catch (err) {
      console.warn(`Discovery: register failed (${err instanceof Error ? err.message : err}); will retry on heartbeat`);
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      const res = await fetch(`${this.cfg.discoveryUrl}/v1/agents/${this.guid}/heartbeat`, {
        method: "POST", headers: this.headers(), body: JSON.stringify({ health: "healthy" }),
      });
      if (res.status === 404) await this.register();
    } catch {
      await this.register();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try {
      await fetch(`${this.cfg.discoveryUrl}/v1/agents/${this.guid}`, { method: "DELETE", headers: this.headers() });
      console.log("Discovery: deregistered on shutdown");
    } catch { /* best effort */ }
  }
}

export function discoveryFromEnv(): DiscoveryClient | null {
  const discoveryUrl = process.env.QMS_DISCOVERY_URL;
  if (!discoveryUrl) return null;
  return new DiscoveryClient({
    discoveryUrl,
    name: process.env.QMS_AGENT_NAME ?? "QMS Agent",
    address: process.env.QMS_AGENT_ADDRESS ?? `http://localhost:${process.env.API_PORT ?? 4000}`,
    observabilityUrl: process.env.LANGFUSE_BASE_URL,
    capabilities: (process.env.QMS_AGENT_CAPABILITIES ?? "").split(",").filter(Boolean),
    registerToken: process.env.QMS_DISCOVERY_TOKEN,
    heartbeatMs: Number(process.env.QMS_DISCOVERY_HEARTBEAT_MS ?? 10000),
  });
}