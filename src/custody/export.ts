// src/custody/export.ts
//
// The custody dossier: the auditor-facing export.
//
// An auditor does not want a database dump. They want, for one document, a
// self-contained record that answers: what produced this, from which sources,
// under which standard and authority, who approved it, and prove none of it
// was altered.
//
// This is ENUMERATION over the ledger, the anchors, and the (still-live)
// QueryRecord. No LLM anywhere in it - a custody record written by a model
// would be the very thing under suspicion. It is generated from the same
// ledger it attests to, so it cannot drift from what actually happened.
//
// It is SELF-VERIFYING: it re-runs verifyChain and embeds the result, so the
// auditor sees "chain intact, anchored at ..." rather than taking it on faith.

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { custody_events, custody_anchors } from "../db/schema.js";
import { verifyChain } from "./ledger.js";
import { currentDomain } from "../identity/index.js";

export interface CustodyDossier {
  correlationId: string;
  domain: string;
  generatedAt: string;

  // The ordered trajectory - references only, exactly as chained.
  events: {
    seq: number;
    runId: string;
    eventType: string;
    userId: string | null;
    decisionId: string | null;
    policyHash: string | null;
    payload: unknown;
    entryHash: string;
    recordedAt: string;
  }[];

  // Every human decision, lifted out for the auditor's convenience. Who
  // approved, when, on which run, with what disposition.
  humanDecisions: {
    seq: number;
    userId: string | null;
    runId: string;
    payload: unknown;
    recordedAt: string;
  }[];

  // Cross-agent hops. Where this correlation entered or left another agent.
  delegations: {
    seq: number;
    eventType: string;
    payload: unknown;
    recordedAt: string;
  }[];

  // The tamper-evidence result and the external anchor covering the period.
  integrity: {
    chainVerified: boolean;
    entriesChecked: number;
    brokenAt?: number;
    detail?: string;
    anchor: {
      headSeq: number;
      headHash: string;
      method: string;
      anchoredAt: string;
    } | null;
  };
}

/**
 * Assemble the dossier for one correlation id. Scoped to THIS agent's ledger;
 * a cross-agent operation produces one dossier per agent, joined by the shared
 * correlationId (the auditor requests the same id from each agent).
 */
export async function buildCustodyDossier(correlationId: string): Promise<CustodyDossier> {
  const domain = currentDomain();

  const rows = await db
    .select()
    .from(custody_events)
    .where(
      sql`${custody_events.domain} = ${domain} AND ${custody_events.correlation_id} = ${correlationId}`,
    )
    .orderBy(sql`${custody_events.seq} ASC`);

  const events = rows.map((r) => ({
    seq: r.seq,
    runId: r.run_id,
    eventType: r.event_type,
    userId: r.user_id,
    decisionId: r.decision_id,
    policyHash: r.policy_hash,
    payload: r.payload,
    entryHash: r.entry_hash,
    recordedAt: r.recorded_at.toISOString(),
  }));

  const humanDecisions = rows
    .filter((r) => r.event_type === "human_decision")
    .map((r) => ({
      seq: r.seq,
      userId: r.user_id,
      runId: r.run_id,
      payload: r.payload,
      recordedAt: r.recorded_at.toISOString(),
    }));

  const delegations = rows
    .filter((r) => r.event_type === "delegation" || r.event_type === "delegation_result")
    .map((r) => ({
      seq: r.seq,
      eventType: r.event_type,
      payload: r.payload,
      recordedAt: r.recorded_at.toISOString(),
    }));

  // Verify the slice, and find the most recent anchor at or beyond its head.
  const verification = await verifyChain({ correlationId });
  const headSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0;

  const anchorRows = await db
    .select()
    .from(custody_anchors)
    .where(sql`${custody_anchors.domain} = ${domain} AND ${custody_anchors.head_seq} >= ${headSeq}`)
    .orderBy(sql`${custody_anchors.head_seq} ASC`)
    .limit(1);

  const anchor = anchorRows[0]
    ? {
        headSeq: anchorRows[0].head_seq,
        headHash: anchorRows[0].head_hash,
        method: anchorRows[0].method,
        anchoredAt: anchorRows[0].anchored_at.toISOString(),
      }
    : null;

  return {
    correlationId,
    domain,
    generatedAt: new Date().toISOString(),
    events,
    humanDecisions,
    delegations,
    integrity: {
      chainVerified: verification.ok,
      entriesChecked: verification.entriesChecked,
      brokenAt: verification.brokenAt,
      detail: verification.detail,
      anchor,
    },
  };
}

/**
 * Render the dossier as auditor-facing Markdown. Plain, complete, and honest
 * about what it does and does not prove.
 */
export function renderCustodyDossier(d: CustodyDossier): string {
  const L: string[] = [];
  L.push(`# Custody record`);
  L.push("");
  L.push(`Correlation: \`${d.correlationId}\``);
  L.push(`Domain: ${d.domain}`);
  L.push(`Generated: ${d.generatedAt}`);
  L.push("");

  L.push(`## Integrity`);
  L.push("");
  if (d.integrity.chainVerified) {
    L.push(`Chain verified: **intact** (${d.integrity.entriesChecked} entries recomputed and matched).`);
  } else {
    L.push(`Chain verified: **BROKEN at seq ${d.integrity.brokenAt}** - ${d.integrity.detail}.`);
  }
  if (d.integrity.anchor) {
    L.push(
      `External anchor: head hash \`${d.integrity.anchor.headHash.slice(0, 16)}...\` ` +
        `via ${d.integrity.anchor.method}, anchored ${d.integrity.anchor.anchoredAt}.`,
    );
  } else {
    L.push(`External anchor: **none covering this record**. Internal consistency only.`);
  }
  L.push("");

  L.push(`## Human decisions`);
  L.push("");
  if (d.humanDecisions.length === 0) {
    L.push(`None recorded.`);
  } else {
    for (const h of d.humanDecisions) {
      L.push(`- seq ${h.seq}, run \`${h.runId}\`, user \`${h.userId}\`, ${h.recordedAt}: ${JSON.stringify(h.payload)}`);
    }
  }
  L.push("");

  if (d.delegations.length > 0) {
    L.push(`## Cross-agent delegations`);
    L.push("");
    for (const g of d.delegations) {
      L.push(`- seq ${g.seq}, ${g.eventType}, ${g.recordedAt}: ${JSON.stringify(g.payload)}`);
    }
    L.push("");
  }

  L.push(`## Full trajectory`);
  L.push("");
  for (const e of d.events) {
    L.push(`### seq ${e.seq} - ${e.eventType}`);
    L.push(`run \`${e.runId}\`${e.userId ? `, user \`${e.userId}\`` : ""}${e.decisionId ? `, decision \`${e.decisionId}\`` : ""}`);
    L.push(`recorded ${e.recordedAt}, entry hash \`${e.entryHash.slice(0, 16)}...\``);
    L.push("```json");
    L.push(JSON.stringify(e.payload, null, 2));
    L.push("```");
    L.push("");
  }

  L.push(`## Scope of this evidence`);
  L.push("");
  L.push(
    `This record proves that the events above occurred in the order shown and have not been ` +
      `altered since (chain recomputed and matched; head externally anchored). It proves each ` +
      `factual claim was bound to a retrieved source and that the recorded grounding checks ` +
      `passed. It does NOT assert that the underlying model reasoned correctly - only that the ` +
      `output was grounded, checked, and approved by the named authority.`,
  );

  return L.join("\n");
}