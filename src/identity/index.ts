// src/identity/index.ts
//
// Chooses the entitlement provider. One line changes when the identity
// service lands:  QMS_IDENTITY_MODE=http
//
// Env:
//   QMS_IDENTITY_MODE          local | http      (default: local)
//   QMS_IDENTITY_URL           base url of the identity service (http mode)
//   QMS_IDENTITY_SERVICE_TOKEN service credential for the agent (http mode)
//   QMS_IDENTITY_TIMEOUT_MS    default 2000
//   QMS_DOMAIN                 this deployment's domain, e.g. "engineering"
//   QMS_ALLOW_LOCAL_IDENTITY   explicit opt-in to run local mode in production

import { LocalEntitlementProvider } from "./local-provider.js";
import { HttpEntitlementProvider } from "./http-provider.js";
import type { EntitlementProvider } from "./types.js";

export * from "./types.js";
export { loadPolicy, resolveLabels } from "./policy.js";

let provider: EntitlementProvider | null = null;

/** This deployment's domain. An isolated agent serves exactly one. */
export function currentDomain(): string {
  return process.env.QMS_DOMAIN ?? "engineering";
}

/**
 * Is label enforcement active?
 *
 * Enforcement and label PRODUCTION must ship separately. Qdrant's `must`
 * filter excludes points lacking access_labels, so switching this on before a
 * reindex has written labels blacks out the entire corpus. The safe order is:
 *   1. ingest writes labels          (this flag off - zero risk)
 *   2. reindex
 *   3. preflight: zero unlabelled points
 *   4. flip this flag
 * Rollback is the same flag.
 */
export function enforceLabels(): boolean {
  return process.env.QMS_ENFORCE_LABELS === "true";
}

export function getEntitlementProvider(): EntitlementProvider {
  if (provider) return provider;

  const mode = (process.env.QMS_IDENTITY_MODE ?? "local").toLowerCase();

  if (mode === "http") {
    const baseUrl = process.env.QMS_IDENTITY_URL;
    if (!baseUrl) {
      throw new Error("QMS_IDENTITY_MODE=http requires QMS_IDENTITY_URL");
    }
    provider = new HttpEntitlementProvider({
      baseUrl,
      serviceToken: process.env.QMS_IDENTITY_SERVICE_TOKEN,
      timeoutMs: Number(process.env.QMS_IDENTITY_TIMEOUT_MS ?? 2000),
    });
    console.log(`Identity: resolving entitlements against ${baseUrl}`);
    return provider;
  }

  // Local mode: fixed credentials from a git-versioned policy file.
  // It must never be reached in production by accident - a fixed policy
  // cannot revoke anyone.
  const isProd = process.env.NODE_ENV === "production";
  const allowed = process.env.QMS_ALLOW_LOCAL_IDENTITY === "true";
  if (isProd && !allowed) {
    throw new Error(
      "Refusing to use the LOCAL identity provider in production. " +
        "It reads fixed credentials from identity/policy.json and cannot revoke access. " +
        "Set QMS_IDENTITY_MODE=http, or QMS_ALLOW_LOCAL_IDENTITY=true to override deliberately.",
    );
  }

  console.warn(
    "Identity: using the LOCAL provider (fixed credentials from identity/policy.json). " +
      "Revocation is not possible. Set QMS_IDENTITY_MODE=http when the identity service exists.",
  );
  provider = new LocalEntitlementProvider();
  return provider;
}

/** Test hook - forget the memoised provider. */
export function resetEntitlementProvider(): void {
  provider = null;
}