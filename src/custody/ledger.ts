// src/custody/ledger.ts
//
// The append-only, hash-chained custody ledger.
//
// entry_hash = sha256( prev_hash || canonicalJson(event) )
//
// The chain is only as trustworthy as the canonicalisation is deterministic.
// Two runs of the same event MUST produce byte-identical input to the hash, or
// verification fails on honest data. So canonicalJson sorts keys recursively
// and is the single definition used by BOTH append and verify.
//
// GENESIS is a fixed constant. The first entry chains from it.
//
// This module has NO update and NO delete. That is the point: the only
// mutation is appendEvent, and it only ever adds. A custody record you can
// edit is not evidence.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { custody_events } from "../db/schema.js";
import { currentDomain } from "../identity/index.js";
import { getProvenanceSinks, type ProvenanceEnvelope } from "./sink.js";

// Pinned conditions stamped on every externally-mirrored event. The agent
// version comes from package.json at build; the model version from config. An
// auditor uses these to reproduce a run's exact conditions after the agent
// instance is gone.
export const AGENT_VERSION = process.env.QMS_AGENT_VERSION ?? "0.1.0";
export const MODEL_VERSION = process.env.OLLAMA_MODEL ?? "unknown";

export const GENESIS_HASH = "0".repeat(64);

export type CustodyEventType =
  | "run_started" // an agent begins handling a request
  | "retrieval" // chunks retrieved: ids, labels, scores - never text
  | "sql_query" // a QueryRequest executed: shape, executed SQL, row count
  | "generation" // a section generated: model+version, prompt hash, output hash
  | "judge" // a rubric category scored
  | "human_decision" // a gate: user, disposition, feedback
  | "delegation" // this agent called another agent (correlation crosses here)
  | "delegation_result" // the delegated agent returned
  | "document_finalized" // output bound by hash
  | "run_completed"
  // Fan-in of a parallel GATHER phase: the orchestrator collected N
  // content-addressed artifacts (from dumb researchers) and records them as one
  // ordered event. The artifact hashes live in `payload.inputs` (see the DAG
  // convention below), so this event commits to exactly which artifacts were
  // gathered. See custody/dag.ts and docs/specs/SPEC-agent-topology-and-custody-dag.md.
  | "gather_complete"
  // The deterministic readiness gate ran: whether the gathered input bundle was
  // complete enough for the thinker, and the specific gaps if not. References
  // only — input ids and reasons, never the gathered values.
  | "readiness_gate"
  // The actioner performed (or refused) an external write — the sole egress. The
  // channel, the outcome (sent / duplicate / refused), and why. This is the
  // record of what actually left the system.
  | "action_taken"
  // The released rubric set was pulled into this agent: from/to set hash, ref,
  // and which types moved. The STANDARD governing every later evaluation
  // changed here, so an auditor reading a verdict must be able to see when the
  // yardstick was swapped and who swapped it.
  | "rubric_set_updated";

export interface CustodyContext {
  correlationId: string;
  runId: string;
  userId?: string;
  /** Set on disposition events - WHO approved, distinct from who ran. */
  approverId?: string;
  decisionId?: string;
  policyHash?: string;
  /** The rubric hash governing this run, stamped for reproducibility. */
  rubricHash?: string;
}

/**
 * Canonical JSON: recursively key-sorted, no incidental whitespace. The chain
 * depends on this being identical across processes and time.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The exact bytes that get hashed for an entry. Shared by append and verify.
 *
 *  `mode` is OPTIONAL and must stay optional. Rows written before the mode
 *  column existed were hashed without the field, so it has to be absent from
 *  the canonical JSON - not null - for those entries to still verify. Callers
 *  pass `mode: undefined` (or omit it) for such rows; JSON.stringify drops
 *  undefined-valued keys, reproducing the original bytes exactly. Passing
 *  `null` here would change the hash and report the whole chain as broken. */
export function hashEntry(
  prevHash: string,
  event: {
    correlation_id: string;
    run_id: string;
    domain: string;
    event_type: string;
    user_id: string | null;
    decision_id: string | null;
    policy_hash: string | null;
    mode?: string;
    payload: unknown;
  },
): string {
  const material = prevHash + "|" + canonicalJson(event);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Append one event to the ledger, chaining from the current head.
 *
 * Serialised per domain by an advisory lock, so two concurrent appends cannot
 * read the same head and fork the chain. The lock + read-head + insert happen
 * in one transaction.
 *
 * SINGLE-WRITER INVARIANT. This is the ONLY custody writer, and only the
 * orchestrator (the executor / an ask route) may call it. Dumb role agents —
 * researchers, and later the exporter and actioner — return data and NEVER
 * write custody: the orchestrator hashes their output into an artifact and
 * records it here. Do not add a second writer for a role agent; the whole
 * point of the single writer is that the chain has one, serialisable, auditable
 * source of ordered truth. (See docs/specs/SPEC-agent-topology-and-custody-dag.md.)
 *
 * DAG CONVENTION. An event that references content-addressed artifacts carries
 * their hashes in `payload.inputs: string[]` — e.g. a `gather_complete` lists
 * the artifacts gathered, a `generation` lists the artifacts the thinker
 * consumed. Because `payload` is canonicalised into the entry hash, those
 * references are tamper-evident from the chain side; the artifacts themselves
 * are verified from the content side (custody/dag.ts + artifacts.verifyArtifact).
 */
export async function appendEvent(
  ctx: CustodyContext,
  eventType: CustodyEventType,
  payload: Record<string, unknown>,
): Promise<{ seq: number; entryHash: string }> {
  const domain = currentDomain();

  const result = await db.transaction(async (tx) => {
    // Advisory lock keyed on the domain string - serialises appends to this
    // ledger without blocking other domains.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${domain}))`);

    const headRows = await tx
      .select({ entry_hash: custody_events.entry_hash })
      .from(custody_events)
      .where(sql`${custody_events.domain} = ${domain}`)
      .orderBy(sql`${custody_events.seq} DESC`)
      .limit(1);

    const prevHash = headRows[0]?.entry_hash ?? GENESIS_HASH;

    const event = {
      correlation_id: ctx.correlationId,
      run_id: ctx.runId,
      domain,
      event_type: eventType,
      user_id: ctx.userId ?? null,
      decision_id: ctx.decisionId ?? null,
      policy_hash: ctx.policyHash ?? null,
      // The instance's mode, hashed in so it cannot be rewritten later. Every
      // new entry carries it; only pre-existing rows lack it.
      mode: config.mode,
      payload,
    };

    const entryHash = hashEntry(prevHash, event);

    const inserted = await tx
      .insert(custody_events)
      .values({ ...event, prev_hash: prevHash, entry_hash: entryHash })
      .returning({ seq: custody_events.seq });

    const row = inserted[0];
    // An append that returns no row means the event was not chained. Failing
    // loudly is the only safe option: silently carrying on would leave the
    // caller believing custody was recorded when it was not.
    if (!row) throw new Error("Custody append returned no row; the event was not recorded.");
    return { seq: row.seq, entryHash, prevHash };
  });

  // Mirror to external provenance sink(s). The agent is ephemeral; the external
  // record is what an auditor reads after this instance is gone. Local ledger
  // is already committed above, so a sink failure never loses the event locally.
  const sinks = getProvenanceSinks();
  if (sinks.length > 0) {
    const envelope: ProvenanceEnvelope = {
      correlationId: ctx.correlationId,
      runId: ctx.runId,
      domain,
      eventType,
      seq: result.seq,
      prevHash: result.prevHash,
      entryHash: result.entryHash,
      userId: ctx.userId ?? null,
      approverId: ctx.approverId ?? null,
      decisionId: ctx.decisionId ?? null,
      policyHash: ctx.policyHash ?? null,
      agentVersion: AGENT_VERSION,
      modelVersion: MODEL_VERSION,
      rubricHash: ctx.rubricHash ?? null,
      mode: config.mode,
      payload,
      recordedAt: new Date().toISOString(),
    };
    await Promise.all(sinks.map((s) => s.write(envelope)));
  }

  return { seq: result.seq, entryHash: result.entryHash };
}

export interface VerificationResult {
  ok: boolean;
  entriesChecked: number;
  /** seq of the first broken link, if any. */
  brokenAt?: number;
  detail?: string;
}

/**
 * Recompute the chain for a domain and confirm every link. This is what the
 * custody export runs so an auditor sees "chain intact" rather than taking it
 * on faith. O(n) over the ledger; scope by correlation for one operation.
 */
export async function verifyChain(
  opts: { correlationId?: string } = {},
): Promise<VerificationResult> {
  const domain = currentDomain();

  const rows = await db
    .select()
    .from(custody_events)
    .where(
      opts.correlationId
        ? sql`${custody_events.domain} = ${domain} AND ${custody_events.correlation_id} = ${opts.correlationId}`
        : sql`${custody_events.domain} = ${domain}`,
    )
    .orderBy(sql`${custody_events.seq} ASC`);

  let prev = GENESIS_HASH;
  let checked = 0;

  for (const row of rows) {
    // When scoped to a correlation the prev may legitimately be an entry
    // outside the slice; trust the stored prev_hash for the first row and
    // verify continuity from there.
    if (checked === 0) prev = row.prev_hash;

    if (row.prev_hash !== prev) {
      return { ok: false, entriesChecked: checked, brokenAt: row.seq, detail: "prev_hash discontinuity" };
    }
    const recomputed = hashEntry(row.prev_hash, {
      correlation_id: row.correlation_id,
      run_id: row.run_id,
      domain: row.domain,
      event_type: row.event_type,
      user_id: row.user_id,
      decision_id: row.decision_id,
      policy_hash: row.policy_hash,
      // Reconstruct EXACTLY as appended. A row from before the mode column has
      // mode NULL and was hashed with the field absent, so it must stay absent
      // here - `?? undefined` collapses null to omitted. Passing the null
      // straight through would fail every legacy entry.
      mode: row.mode ?? undefined,
      payload: row.payload,
    });
    if (recomputed !== row.entry_hash) {
      return { ok: false, entriesChecked: checked, brokenAt: row.seq, detail: "entry_hash mismatch (tampered payload)" };
    }
    prev = row.entry_hash;
    checked++;
  }

  return { ok: true, entriesChecked: checked };
}