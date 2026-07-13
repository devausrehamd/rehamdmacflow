 // src/identity/local-provider.ts
//
// Stands in for the identity service. Resolves entitlements from the fixed,
// git-versioned policy in identity/policy.json.
//
// It is a SEAM, not a design. It returns exactly the shape the real service
// will return - decision id, policy version, policy hash - so the audit trail
// written today needs no migration when the service arrives. Swapping to HTTP
// changes one line in index.ts.
//
// It must never be used in production silently. See index.ts for the guard.

import { randomUUID } from "node:crypto";
import { loadPolicy, resolveLabels } from "./policy.js";
import { denyAll, type Entitlement, type EntitlementProvider } from "./types.js";

export class LocalEntitlementProvider implements EntitlementProvider {
  readonly kind = "local" as const;

  async resolve(
    subject: string,
    domain: string,
    serverDerivedRole?: string,
  ): Promise<Entitlement> {
    const decisionId = `dec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    let loaded;
    try {
      loaded = loadPolicy();
    } catch {
      // No policy, no grants. Fail closed.
      return denyAll(subject, domain, "unknown", "unknown", decisionId, "unknown");
    }

    const labels = resolveLabels(loaded.policy, subject, domain, serverDerivedRole);

    // An empty label set is a valid "active" decision meaning "sees nothing
    // here" - distinct from "we could not resolve you". isPermitted() treats
    // both as deny, but the audit record keeps them apart.
    return {
      subject,
      domain,
      labels,
      status: "active",
      policyVersion: loaded.policy.policyVersion,
      policyHash: loaded.hash,
      decisionId,
      resolvedAt: new Date().toISOString(),
    };
  }
}