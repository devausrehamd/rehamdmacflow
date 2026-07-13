// src/identity/http-provider.ts
//
// The real thing: resolve entitlements per request against the shared identity
// service. Immediate revocation - a subject removed from a group at 09:14 is
// denied at 09:14, not whenever a token happened to expire.
//
// Identity is the ONE thing that is legitimately shared across isolated domain
// agents: a subject and their entitlements have no owning domain. Domain DATA
// is never shared. This service holds users, groups, memberships, and the
// group-to-label policy - and no domain data, ever.
//
// Fails CLOSED. If the service is unreachable, we do not serve data. That is
// the price of immediate revocation, and it is the correct price for a QMS.

import { randomUUID } from "node:crypto";
import { denyAll, EntitlementError, type Entitlement, type EntitlementProvider } from "./types.js";

export interface HttpProviderConfig {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs: number;
}

export class HttpEntitlementProvider implements EntitlementProvider {
  readonly kind = "http" as const;

  constructor(private readonly config: HttpProviderConfig) {}

  async resolve(
    subject: string,
    domain: string,
    _serverDerivedRole?: string, // ignored: the service resolves the role itself
  ): Promise<Entitlement> {
    const fallbackDecisionId = `dec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const url =
      `${this.config.baseUrl.replace(/\/$/, "")}/v1/entitlements` +
      `?subject=${encodeURIComponent(subject)}&domain=${encodeURIComponent(domain)}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.serviceToken) {
      headers.Authorization = `Bearer ${this.config.serviceToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });

      if (res.status === 404) {
        // Subject unknown to the identity service. Deny, and say so precisely.
        return denyAll(subject, domain, "unknown", "unknown", fallbackDecisionId, "unknown");
      }
      if (!res.ok) {
        throw new EntitlementError("unavailable", `Identity service returned ${res.status}`);
      }

      const body = (await res.json()) as Partial<Entitlement>;
      if (!Array.isArray(body.labels) || typeof body.status !== "string") {
        throw new EntitlementError("unavailable", "Identity service returned a malformed decision");
      }

      return {
        subject,
        domain,
        labels: body.labels,
        status: body.status as Entitlement["status"],
        policyVersion: body.policyVersion ?? "unknown",
        policyHash: body.policyHash ?? "unknown",
        decisionId: body.decisionId ?? fallbackDecisionId,
        resolvedAt: body.resolvedAt ?? new Date().toISOString(),
      };
    } catch (err) {
      // Unreachable, timed out, malformed. Serve nothing.
      console.error(
        `identity: resolution failed for subject ${subject} in ${domain}: ${err instanceof Error ? err.message : err}`,
      );
      return denyAll(subject, domain, "unknown", "unknown", fallbackDecisionId, "unknown");
    } finally {
      clearTimeout(timer);
    }
  }
}