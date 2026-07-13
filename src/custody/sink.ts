// src/custody/sink.ts
//
// Where custody events come to REST.
//
// The agent is ephemeral - spun up, torn down. Its local Postgres ledger dies
// with it. For an auditor to reconstruct a run months later, the provenance
// record must outlive the agent, which means it belongs in an EXTERNAL service,
// not the agent's own database.
//
// This is a pluggable sink. Every custody event flows through appendEvent, and
// appendEvent writes to the configured sink(s). Two implementations:
//
//   local  - the agent's Postgres ledger (fast, hash-chained, but ephemeral)
//   http   - POSTs each event to an external Provenance API (durable, host-
//            independent, the auditor's system of record)
//
// Both can run at once: local for the in-run hash chain and fast verification,
// http for the durable external record. Because it is an API, the same
// Provenance service serves many agents on many hosts - a torn-down agent's
// history is already safe in the external store.
//
// The event ENVELOPE carries what an auditor needs to pin a run to its exact
// conditions: agent version, model+version, rubric/policy hashes, run id, user
// id, and (for dispositions) approver id. These make the record reproducible
// and attributable independent of the agent that produced it.

export interface ProvenanceEnvelope {
  // Identity of the run
  correlationId: string;
  runId: string;
  domain: string;
  eventType: string;
  seq: number;
  prevHash: string;
  entryHash: string;

  // WHO
  userId: string | null;
  approverId?: string | null;
  decisionId: string | null;
  policyHash: string | null;

  // WHAT PRODUCED IT - the pinned conditions, so the run is reproducible and
  // attributable even after this agent instance is gone.
  agentVersion: string;
  modelVersion: string;
  rubricHash?: string | null;

  // The event body - references only, never content/PII (immutable store).
  payload: Record<string, unknown>;

  recordedAt: string;
}

export interface ProvenanceSink {
  readonly name: string;
  write(envelope: ProvenanceEnvelope): Promise<void>;
}

/**
 * The external Provenance API sink. POSTs each event to a durable service that
 * is the auditor's system of record. Fire-and-forget with a short timeout by
 * default - a slow external service must not stall generation - but failures
 * are surfaced so a persistently-down sink is noticed, not silently dropped.
 */
export class HttpProvenanceSink implements ProvenanceSink {
  readonly name = "http";
  constructor(
    private readonly endpoint: string,
    private readonly opts: { apiKey?: string; timeoutMs?: number; required?: boolean } = {},
  ) {}

  async write(envelope: ProvenanceEnvelope): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      if (!res.ok) {
        const msg = `Provenance API returned ${res.status}`;
        if (this.opts.required) throw new Error(msg);
        console.warn(`[provenance] ${msg} (non-fatal; local ledger still holds the event)`);
      }
    } catch (err) {
      const msg = `Provenance API POST failed: ${err instanceof Error ? err.message : err}`;
      // If the external record is REQUIRED, a failure must halt - otherwise a
      // torn-down agent could lose events. If advisory, warn and rely on local.
      if (this.opts.required) throw new Error(msg);
      console.warn(`[provenance] ${msg} (non-fatal; local ledger still holds the event)`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// The configured sinks. The local ledger is always written (in appendEvent
// itself); this list is the ADDITIONAL external mirrors.
let sinks: ProvenanceSink[] = [];

export function configureProvenanceSinks(configured: ProvenanceSink[]): void {
  sinks = configured;
}

export function getProvenanceSinks(): ProvenanceSink[] {
  return sinks;
}

/** Build sinks from env. QMS_PROVENANCE_API_URL enables the external mirror. */
export function provenanceSinksFromEnv(): ProvenanceSink[] {
  const url = process.env.QMS_PROVENANCE_API_URL;
  if (!url) return [];
  return [
    new HttpProvenanceSink(url, {
      apiKey: process.env.QMS_PROVENANCE_API_KEY,
      required: process.env.QMS_PROVENANCE_REQUIRED === "true",
      timeoutMs: Number(process.env.QMS_PROVENANCE_TIMEOUT_MS ?? 5000),
    }),
  ];
}