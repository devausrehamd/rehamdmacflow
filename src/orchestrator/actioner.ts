// src/orchestrator/actioner.ts
//
// The actioner role (Phase 6 of docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// The actioner is the ONLY role with external write side effects — sending an
// email, writing to an external DB — and therefore the sole egress choke point.
// Concentrating egress in one small, audited role is a security property, not
// tidiness: two invariants are enforced HERE, before any transport is touched:
//
//   - GATED. It refuses unless an approver is present AND distinct from the
//     author. This is the same approver != author rule the review flow enforces
//     server-side; reasoning (the thinker) can propose, but only an independently
//     approved payload leaves the system.
//   - IDEMPOTENT. The same idempotencyKey delivers at most once. A repeat returns
//     a "duplicate" receipt without re-sending, so a retried or replayed run
//     cannot double-send.
//
// The transport is injected and stubbed here; a real one hits an email server or
// external database. Real transports are a later milestone.

import type { CapabilityProvider, RunContext } from "./capabilities.js";

export interface ActionRequest {
  channel: string;
  payload: unknown;
  /** Who produced the payload (the run author). */
  authorId?: string;
  /** Who approved egress. MUST be present and != authorId or the send is refused. */
  approverId?: string;
  /** De-dupe key: same key delivers at most once. */
  idempotencyKey: string;
}

export interface Receipt {
  status: "sent" | "duplicate" | "refused";
  channel: string;
  idempotencyKey: string;
  reason?: string;
  sentAt?: string;
}

/** The actual delivery. The stub records; a real transport performs external I/O. */
export interface Transport {
  deliver(req: ActionRequest, ctx: RunContext): Promise<void>;
}

/**
 * Build an actioner for one channel as a capability provider (`act:<channel>`).
 * `seen` holds the delivered idempotency keys; inject a shared/persistent store
 * for real use, or let it default to per-instance memory for the stub.
 */
export function makeActioner(channel: string, transport: Transport, seen: Set<string> = new Set()): CapabilityProvider {
  return {
    capability: `act:${channel}`,
    async run(query, ctx) {
      const req = query as ActionRequest;

      // GATE first — a refused send must not consume the idempotency key.
      if (!req.approverId || req.approverId === req.authorId) {
        const receipt: Receipt = {
          status: "refused",
          channel,
          idempotencyKey: req.idempotencyKey,
          reason: "egress requires an approver distinct from the author",
        };
        return { result: receipt };
      }

      // IDEMPOTENCY — deliver at most once per key.
      if (seen.has(req.idempotencyKey)) {
        const receipt: Receipt = { status: "duplicate", channel, idempotencyKey: req.idempotencyKey };
        return { result: receipt };
      }

      await transport.deliver(req, ctx);
      seen.add(req.idempotencyKey);
      const receipt: Receipt = { status: "sent", channel, idempotencyKey: req.idempotencyKey, sentAt: ctx.producedAt };
      return { result: receipt };
    },
  };
}
