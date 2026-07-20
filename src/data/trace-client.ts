// src/data/trace-client.ts
//
// The agent-side client for the diagnostic trace + DAG-History write APIs
// (decision-13 refactor R2). An HTTP client with a bearer token and NO database
// access — the enforcement of "all database access is API-mediated" on the trace
// stores the agent role used to write directly:
//
//   - run steps   -> POST /api/v1/data/run-steps       (agent_run_steps)
//   - LLM calls   -> POST /api/v1/data/llm-calls        (agent_llm_calls)
//   - trajectory  -> POST /api/v1/data/trajectory/steps    (DAG History, §13.3)
//                    POST /api/v1/data/trajectory/terminal
//
// These are diagnostics and best-effort: a caller logs and continues on failure,
// exactly as the in-process writers swallowed their own errors — a trace write
// must never fail the run it observes. Input/output are redacted by the caller
// BEFORE they are handed here; no secret leaves the agent in a request body.

import { config } from "../config.js";

function baseUrl(): string {
  return process.env.QMS_API_INTERNAL_URL ?? `http://localhost:${config.api.port}`;
}

export interface RunStepPayload {
  correlationId: string;
  runId: string;
  queryId?: string;
  node: string;
  input: unknown;
  output: unknown;
  status: "ok" | "error";
  error?: string;
  latencyMs: number;
  mode?: string;
}

export interface LlmCallPayload {
  correlationId: string;
  runId: string;
  node?: string;
  model?: string;
  prompt: string;
  completion?: string | null;
  status: "ok" | "error";
  error?: string;
  latencyMs: number;
  mode?: string;
}

export interface TrajectoryStepPayload {
  correlationId: string;
  agentGuid: string;
  seq: number;
  capability?: string;
  kind: string;
  input?: unknown;
  outputRef?: string | null;
  status: "ok" | "error";
  error?: string;
}

export interface TrajectoryTerminalPayload {
  correlationId: string;
  agentGuid: string;
  seq: number;
  outcome: "completed" | "failed" | "shutdown";
  finalRef?: string;
  reason?: string;
}

export interface TraceApi {
  runStep(payload: RunStepPayload): Promise<void>;
  llmCall(payload: LlmCallPayload): Promise<void>;
  trajectoryStep(payload: TrajectoryStepPayload): Promise<void>;
  trajectoryTerminal(payload: TrajectoryTerminalPayload): Promise<void>;
}

/** Build a trace API client bound to a base URL and a caller bearer token. */
export function traceApi(url: string, token: string): TraceApi {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const post = async (path: string, body: unknown): Promise<void> => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  };
  return {
    runStep: (payload) => post("/api/v1/data/run-steps", payload),
    llmCall: (payload) => post("/api/v1/data/llm-calls", payload),
    trajectoryStep: (payload) => post("/api/v1/data/trajectory/steps", payload),
    trajectoryTerminal: (payload) => post("/api/v1/data/trajectory/terminal", payload),
  };
}

/** A trace client against the co-located Data Access API, bound to the caller's
 *  token. This is what a graph node or the LLM-trace callback uses. */
export function traceClient(token: string): TraceApi {
  return traceApi(baseUrl(), token);
}
