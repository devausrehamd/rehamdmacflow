// src/platform/trajectory-history.ts
//
// The DAG History store (Stage 3 of the agent-platform control plane,
// docs/specs/SPEC-agent-platform-and-control-plane.md §7).
//
// A durable, write-ahead, per-agent trajectory. It answers "what did each agent
// do internally, and where did it stop?" - the forensic/completeness record,
// distinct from the tamper-evident custody chain (authority). Each agent writes
// its OWN lane keyed (correlationId, agentGuid, seq); appends are idempotent, so
// a retried write is a no-op and no two writers contend.
//
// WRITE-AHEAD, not write-on-shutdown: a step is appended as it completes, which
// is the durability guarantee - a SIGKILL/OOM/power-loss skips any shutdown
// handler, so this is what survives an agent VM being destroyed. The terminal
// record (good or bad) closes a run; its ABSENCE next to an expired lease is the
// signal that an agent died mid-operation at the last recorded seq.
//
// This module is the local (Postgres) sink. An http sink to a peer History
// service - the fully external endpoint - drops in behind the same functions,
// exactly as custody/sink.ts mirrors the chain.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agent_trajectory } from "../db/schema.js";

export interface TrajectoryStep {
  correlationId: string;
  agentGuid: string;
  /** This agent's own monotonic counter for this run. No global counter. */
  seq: number;
  capability?: string;
  kind: string;
  /** References only (query shape, source path) — never raw data. */
  input?: unknown;
  /** Content hash produced by this step, or null. */
  outputRef?: string | null;
  status: "ok" | "error";
  error?: string;
}

/**
 * Append one step. Idempotent on (correlationId, agentGuid, seq): a duplicate is
 * a no-op (ON CONFLICT DO NOTHING), so the agent-side WAL may retry freely.
 */
export async function recordTrajectoryStep(step: TrajectoryStep): Promise<void> {
  await db
    .insert(agent_trajectory)
    .values({
      correlation_id: step.correlationId,
      agent_guid: step.agentGuid,
      seq: step.seq,
      capability: step.capability ?? null,
      kind: step.kind,
      input: step.input ?? null,
      output_ref: step.outputRef ?? null,
      status: step.status,
      error: step.error ?? null,
    })
    .onConflictDoNothing();
}

export type TerminalOutcome = "completed" | "failed" | "shutdown";

export interface TerminalRecord {
  correlationId: string;
  agentGuid: string;
  seq: number;
  outcome: TerminalOutcome;
  finalRef?: string;
  reason?: string;
}

/** Close an agent's run with a terminal marker (success or failure). Idempotent. */
export async function recordTerminal(t: TerminalRecord): Promise<void> {
  await db
    .insert(agent_trajectory)
    .values({
      correlation_id: t.correlationId,
      agent_guid: t.agentGuid,
      seq: t.seq,
      kind: "__terminal__",
      status: t.outcome === "failed" ? "error" : "ok",
      terminal: true,
      outcome: t.outcome,
      output_ref: t.finalRef ?? null,
      reason: t.reason ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Mirror a recordRunStep-shaped step into the durable trajectory. This is the
 * write-ahead mirror: an agent calls it for each graph node as it completes.
 * Best-effort — a mirror failure never fails the run it reports on, exactly as
 * recordRunStep guards its own write.
 */
export async function mirrorRunStep(args: {
  correlationId: string;
  agentGuid: string;
  seq: number;
  node: string;
  capability?: string;
  input?: unknown;
  outputRef?: string | null;
  status: "ok" | "error";
  error?: string;
}): Promise<void> {
  await recordTrajectoryStep({
    correlationId: args.correlationId,
    agentGuid: args.agentGuid,
    seq: args.seq,
    capability: args.capability,
    kind: args.node,
    input: args.input,
    outputRef: args.outputRef,
    status: args.status,
    error: args.error,
  }).catch((err) => console.error("[trajectory] write-ahead mirror failed:", err));
}

/** Every recorded row for a correlation, ordered by agent then seq. */
export async function readTrajectory(correlationId: string) {
  return db
    .select()
    .from(agent_trajectory)
    .where(eq(agent_trajectory.correlation_id, correlationId))
    .orderBy(agent_trajectory.agent_guid, agent_trajectory.seq);
}

export interface AgentStopPoint {
  agentGuid: string;
  lastSeq: number;
  /** True if a terminal marker was written; false means it stopped mid-operation. */
  terminated: boolean;
  outcome: string | null;
}

/**
 * Reconciliation: per agent in a run, the last recorded seq and whether it
 * terminated. An agent with `terminated: false` and an expired Discovery lease
 * died mid-operation at `lastSeq`.
 */
export async function whereDidItStop(correlationId: string): Promise<AgentStopPoint[]> {
  const rows = await readTrajectory(correlationId);
  const byAgent = new Map<string, AgentStopPoint>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent_guid) ?? { agentGuid: r.agent_guid, lastSeq: -1, terminated: false, outcome: null };
    cur.lastSeq = Math.max(cur.lastSeq, r.seq);
    if (r.terminal) {
      cur.terminated = true;
      cur.outcome = r.outcome ?? null;
    }
    byAgent.set(r.agent_guid, cur);
  }
  return [...byAgent.values()];
}

/**
 * Resume point: the last successful step for an agent that produced an artifact.
 * A stopped run replays from here (the content-addressed artifact still exists)
 * instead of redoing the expensive work — the atomicity property.
 */
export async function resumePoint(
  correlationId: string,
  agentGuid: string,
): Promise<{ seq: number; outputRef: string } | null> {
  const rows = await db
    .select()
    .from(agent_trajectory)
    .where(
      and(
        eq(agent_trajectory.correlation_id, correlationId),
        eq(agent_trajectory.agent_guid, agentGuid),
        eq(agent_trajectory.status, "ok"),
      ),
    )
    .orderBy(desc(agent_trajectory.seq));
  for (const r of rows) {
    if (r.output_ref) return { seq: r.seq, outputRef: r.output_ref };
  }
  return null;
}
