// src/custody/dag.ts
//
// The provenance DAG that sits on top of the linear custody chain (Phase 2 of
// docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// A custody event references the content-addressed artifacts it consumed or
// gathered by listing their hashes in `payload.inputs`. That gives two
// complementary tamper-evidence guarantees:
//
//   - the CHAIN (ledger.verifyChain) proves the reference list in an event was
//     not edited, because `payload` is hashed into the entry;
//   - the CONTENT (artifacts.verifyArtifact) proves each referenced artifact was
//     not swapped, because an artifact's id IS its content hash.
//
// verifyDagReferences() walks the events and checks the second half. You cannot
// alter what a run consumed without one of the two verifiers catching it.
//
// recordGather() is the orchestrator's single entry point for the fan-in of a
// parallel research phase. It — not the researchers — writes custody.

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { custody_events } from "../db/schema.js";
import { currentDomain } from "../identity/index.js";
import { verifyArtifact } from "./artifacts.js";
import { appendEvent, type CustodyContext } from "./ledger.js";

/** The payload key under which an event lists the artifact hashes it references. */
export const DAG_INPUTS_KEY = "inputs";

/** Extract the artifact-hash references from an event payload (empty if none). */
export function dagInputs(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const v = (payload as Record<string, unknown>)[DAG_INPUTS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Record the fan-in of a parallel gather phase: one ordered `gather_complete`
 * event committing to exactly the artifacts gathered. Called by the
 * orchestrator only — researchers never reach custody (single-writer invariant).
 */
export async function recordGather(
  ctx: CustodyContext,
  artifactIds: string[],
  extra: Record<string, unknown> = {},
): Promise<{ seq: number; entryHash: string }> {
  return appendEvent(ctx, "gather_complete", { ...extra, [DAG_INPUTS_KEY]: artifactIds });
}

export interface DagVerification {
  ok: boolean;
  /** Events that referenced at least one artifact. */
  eventsWithRefs: number;
  /** Total artifact references checked. */
  artifactsChecked: number;
  /** Referenced artifacts that no longer content-match (missing or tampered). */
  broken: { seq: number; eventType: string; artifactId: string }[];
}

/**
 * Verify every artifact referenced by an event in this domain (optionally scoped
 * to one correlation) still content-matches its id. Pair with verifyChain for
 * full DAG tamper-evidence.
 */
export async function verifyDagReferences(opts: { correlationId?: string } = {}): Promise<DagVerification> {
  const domain = currentDomain();

  const rows = await db
    .select({ seq: custody_events.seq, event_type: custody_events.event_type, payload: custody_events.payload })
    .from(custody_events)
    .where(
      opts.correlationId
        ? sql`${custody_events.domain} = ${domain} AND ${custody_events.correlation_id} = ${opts.correlationId}`
        : sql`${custody_events.domain} = ${domain}`,
    )
    .orderBy(sql`${custody_events.seq} ASC`);

  const broken: DagVerification["broken"] = [];
  let eventsWithRefs = 0;
  let artifactsChecked = 0;

  for (const row of rows) {
    const ids = dagInputs(row.payload);
    if (ids.length === 0) continue;
    eventsWithRefs++;
    for (const id of ids) {
      artifactsChecked++;
      if (!(await verifyArtifact(id))) {
        broken.push({ seq: row.seq, eventType: row.event_type, artifactId: id });
      }
    }
  }

  return { ok: broken.length === 0, eventsWithRefs, artifactsChecked, broken };
}
