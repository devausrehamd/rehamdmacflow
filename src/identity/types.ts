// src/identity/types.ts
//
// The entitlement contract. This is the shape a REMOTE identity service
// returns, and the local provider returns it identically - so the audit trail
// written today survives the switch to a real service unchanged.
//
// Authentication and authorisation are split deliberately:
//   - signature verification stays LOCAL (a public key, no network call).
//     A forged token is rejected in-process and never reaches this module.
//   - entitlement resolution is REMOTE (a mutable fact, asked per request).
//
// The service returns effective LABELS, never groups. The group-to-label
// mapping is policy, and policy lives in exactly one place. An agent applies
// what it is handed and knows nothing of the group taxonomy.

/** A resolved authorisation decision for one subject, in one domain, at one instant. */
export interface Entitlement {
  subject: string;
  /** The domain this decision is scoped to. An agent learns only its own labels. */
  domain: string;
  /** Effective access labels. Empty means: this subject sees nothing here. */
  labels: string[];
  /** active = serve. revoked/unknown = deny. Never infer from an empty label set. */
  status: "active" | "revoked" | "unknown";

  // --- Provenance. Recorded in the QueryRecord beside the retrieved chunk ids. ---
  /** Human-readable policy version, e.g. "0.1.0-local". */
  policyVersion: string;
  /** sha256 of the policy artifact that produced this decision. The audit anchor. */
  policyHash: string;
  /** Unique per resolution. Ties an answer to the exact decision that permitted it. */
  decisionId: string;
  resolvedAt: string;
}

export class EntitlementError extends Error {
  constructor(
    public readonly code: "unavailable" | "denied" | "misconfigured",
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

export interface EntitlementProvider {
  readonly kind: "local" | "http";

  /**
   * Resolve what `subject` may see in `domain`, right now.
   *
   * `serverDerivedRole` is a hint used only by the local provider, which has
   * no user store of its own to consult. It MUST come from a server-side
   * lookup (as requireAuth already does) and MUST NEVER be taken from the
   * request body or a header. A remote service ignores it and resolves the
   * role itself from the subject.
   *
   * Fails CLOSED: any error resolves to no labels, never to open access.
   */
  resolve(
    subject: string,
    domain: string,
    serverDerivedRole?: string,
  ): Promise<Entitlement>;
}

/** A decision that grants nothing. The safe answer to every failure. */
export function denyAll(
  subject: string,
  domain: string,
  policyVersion: string,
  policyHash: string,
  decisionId: string,
  status: "revoked" | "unknown" = "unknown",
): Entitlement {
  return {
    subject,
    domain,
    labels: [],
    status,
    policyVersion,
    policyHash,
    decisionId,
    resolvedAt: new Date().toISOString(),
  };
}

/** Is this decision permitted to serve data at all? */
export function isPermitted(e: Entitlement): boolean {
  return e.status === "active" && e.labels.length > 0;
}