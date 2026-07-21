// src/platform/compute-provider-select.ts
//
// The single config-driven swap point (SPEC-operational-control-plane.md,
// decision 7). QMS_COMPUTE_PROVIDER selects the substrate; a cloud provider is one
// new case here and one env change in production. Nothing above the Provisioning
// API changes.

import { dockerProvider } from "./docker-provider.js";
import type { ComputeProvider } from "./compute-provider.js";

let cached: ComputeProvider | null = null;

export function computeProviderFromEnv(): ComputeProvider {
  if (cached) return cached;
  const kind = (process.env.QMS_COMPUTE_PROVIDER ?? "docker").toLowerCase();
  switch (kind) {
    case "docker":
      cached = dockerProvider();
      break;
    // case "fly":  cached = flyProvider();  break;   // drops in behind the same interface
    // case "ec2":  cached = ec2Provider();  break;
    default:
      throw new Error(`Unknown QMS_COMPUTE_PROVIDER '${kind}' (expected: docker)`);
  }
  return cached;
}

/** For tests: inject a provider (e.g. a stub) and reset between cases. */
export function setComputeProvider(provider: ComputeProvider | null): void {
  cached = provider;
}
