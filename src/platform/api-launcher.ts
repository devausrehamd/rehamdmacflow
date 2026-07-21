// src/platform/api-launcher.ts
//
// The Supervisor's Launcher, implemented as an HTTP client to the Provisioning API
// (SPEC-operational-control-plane.md, D2b). This is the last piece of the compute
// plane's decoupling: the Supervisor holds this client and a token, never a Docker
// or cloud SDK. `launch` becomes POST /instances, `stop` becomes DELETE — and
// whether an instance is a container or a VM is entirely the provider's concern
// behind the API.
//
// Two contract bridges:
//   - `launch` receives a parsed AgentManifest, but the Provisioning API
//     identifies a manifest by its file (agents/<name>.json). `manifestPath` maps
//     one to the other.
//   - `stop` is given the agent's GUID, but the provider destroys by its own
//     instance id. The launch response carries both, so this keeps a guid→instance
//     map to resolve it. (Restart-safe reconciliation — GET /instances vs Discovery
//     — is the Supervisor's sweep concern, D4.)

import { config } from "../config.js";
import type { Launcher, LaunchedAgent } from "./supervisor.js";
import type { AgentManifest } from "./manifest.js";

export interface ApiLauncherOptions {
  /** Provisioning API base URL; defaults to the co-located API. */
  baseUrl?: string;
  /** Bearer/service token the Provisioning API verifies. */
  token: string;
  /** Map a manifest to its agents/<name>.json path (the Provisioning API's ref). */
  manifestPath: (manifest: AgentManifest) => string;
}

export function apiLauncher(opts: ApiLauncherOptions): Launcher {
  const baseUrl =
    opts.baseUrl ??
    process.env.QMS_PROVISIONING_URL ??
    process.env.QMS_API_INTERNAL_URL ??
    `http://localhost:${config.api.port}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` };

  // guid -> the provider's instance id, captured from the launch response so stop
  // can address the right instance.
  const instanceByGuid = new Map<string, string>();

  return {
    async launch(manifest: AgentManifest): Promise<LaunchedAgent> {
      const res = await fetch(`${baseUrl}/api/v1/instances`, {
        method: "POST",
        headers,
        body: JSON.stringify({ manifest: opts.manifestPath(manifest) }),
      });
      if (!res.ok) {
        throw new Error(`ApiLauncher.launch failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { instanceId: string; guid: string; address: string };
      instanceByGuid.set(body.guid, body.instanceId);
      return { guid: body.guid, address: body.address };
    },

    async stop(guid: string): Promise<void> {
      const instanceId = instanceByGuid.get(guid);
      if (!instanceId) return; // not one we launched — nothing to stop
      const res = await fetch(`${baseUrl}/api/v1/instances/${instanceId}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`ApiLauncher.stop failed: ${res.status} ${await res.text()}`);
      }
      instanceByGuid.delete(guid);
    },
  };
}
