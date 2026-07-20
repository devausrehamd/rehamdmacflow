// src/data/trace-store.ts
//
// The server-side writer for the two diagnostic trace tables — agent_run_steps
// (what went in and out of every node) and agent_llm_calls (every prompt and
// completion). This module OWNS the database access; it is imported only by the
// Data Access API route (routes/data-access.ts), never by an agent-role module.
//
// It exists because the agent-role writers (agent/instrument.ts, agent/llm-trace.ts)
// used to hold a db client and INSERT directly. Under decision 13 the agent role
// carries no database client: it redacts and POSTs, and the INSERT happens here.
//
// The per-run `seq` is resolved inside the INSERT (MAX+1 for the correlation), so
// there is no counter to keep in memory and nothing to get wrong if calls overlap
// — exactly as the in-process writers did before.

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agent_run_steps, agent_llm_calls } from "../db/schema.js";

export interface RunStepInsert {
  correlationId: string;
  runId: string;
  queryId?: string | null;
  node: string;
  /** Already redacted by the caller before it left the agent. */
  input?: unknown;
  output?: unknown;
  status: "ok" | "error";
  error?: string | null;
  latencyMs: number;
  userId?: string | null;
  mode?: string | null;
}

export async function insertRunStep(step: RunStepInsert): Promise<void> {
  await db.insert(agent_run_steps).values({
    correlation_id: step.correlationId,
    run_id: step.runId,
    query_id: step.queryId ?? null,
    seq: sql`(SELECT COALESCE(MAX(s.seq), 0) + 1 FROM agent_run_steps s WHERE s.correlation_id = ${step.correlationId})`,
    node: step.node,
    input: (step.input ?? null) as object,
    output: (step.output ?? null) as object,
    status: step.status,
    error: step.error ?? null,
    latency_ms: Math.round(step.latencyMs),
    user_id: step.userId ?? null,
    mode: step.mode ?? null,
  });
}

export interface LlmCallInsert {
  correlationId: string;
  runId: string;
  node?: string | null;
  model?: string | null;
  prompt: string;
  completion?: string | null;
  status: "ok" | "error";
  error?: string | null;
  latencyMs: number;
  userId?: string | null;
  mode?: string | null;
}

export async function insertLlmCall(call: LlmCallInsert): Promise<void> {
  await db.insert(agent_llm_calls).values({
    correlation_id: call.correlationId,
    run_id: call.runId,
    node: call.node ?? null,
    seq: sql`(SELECT COALESCE(MAX(c.seq), 0) + 1 FROM agent_llm_calls c WHERE c.correlation_id = ${call.correlationId})`,
    model: call.model ?? null,
    prompt: call.prompt,
    completion: call.completion ?? null,
    status: call.status,
    error: call.error ?? null,
    latency_ms: Math.round(call.latencyMs),
    user_id: call.userId ?? null,
    mode: call.mode ?? null,
  });
}
