// src/custody/correlation.ts
//
// The correlation id ties one logical unit of work together ACROSS agents.
//
// When the orchestrator delegates to a domain agent, it passes a correlation
// id. The domain agent records it on every custody event it writes and RETURNS
// it. So a cross-domain deliverable - "a DFMEA (engineering) feeding an export
// control list (trade compliance)" - has a single thread an auditor can follow
// through both agents' ledgers, even though the agents share no database.
//
// Two ids, deliberately distinct:
//
//   correlationId  crosses agent boundaries. Supplied by the caller (the
//                  orchestrator) or minted here if this agent is the entry
//                  point. STABLE for the whole cross-agent operation.
//
//   runId          is local to ONE agent's handling of ONE request. Fresh
//                  every time. Two agents working the same correlationId have
//                  different runIds; a rerun within one agent gets a new runId
//                  but keeps the correlationId.
//
// An auditor reconstructs a distributed operation by correlationId, and a
// single agent's work by runId.

import { randomBytes } from "node:crypto";

const CORRELATION_HEADER = "x-qms-correlation-id";

/** A correlation id supplied by a caller, or a fresh one if this is the entry point. */
export function resolveCorrelationId(headerValue?: string | string[] | null): {
  correlationId: string;
  inherited: boolean;
} {
  const supplied = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (supplied && /^cor_[0-9a-f]{16,}$/.test(supplied)) {
    return { correlationId: supplied, inherited: true };
  }
  return { correlationId: `cor_${randomBytes(12).toString("hex")}`, inherited: false };
}

/** A run id, unique to this agent's handling of this request. */
export function newRunId(): string {
  return `run_${randomBytes(12).toString("hex")}`;
}

/** The header name, exported so the A2A client and server agree on it. */
export { CORRELATION_HEADER };