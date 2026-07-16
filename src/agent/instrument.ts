// src/agent/instrument.ts
//
// Record what went INTO and OUT OF every graph node.
//
// Wrapping the nodes generically, rather than editing each one, is deliberate:
// a node added later is instrumented by being added to the graph, so the
// evidence cannot quietly develop holes as the graph grows. The alternative -
// a recordStep() call inside each node - is one forgotten line away from a
// stage that silently reports nothing.
//
// WHY THIS EXISTS AT ALL. Custody proves what happened but holds references
// only, so it can say section 4.2 was retrieved and never what 4.2 said. That
// makes the two diagnoses an engineer actually needs to separate - "the model
// ignored a value that was retrieved" vs "the value was never retrieved" -
// indistinguishable in the record. This table is the content side of that
// split: erasable, outside the hash chain, droppable on a retention schedule
// without touching custody's integrity.

import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { agent_run_steps } from "../db/schema.js";

/**
 * Which run, and which node, is executing right now.
 *
 * The prompt an LLM sees is assembled INSIDE a node and handed straight to the
 * client, so it never appears in the graph state and a state-level wrapper
 * cannot see it. Rather than thread a context argument through every node and
 * every call site - which the next call site would forget - the node wrapper
 * publishes its identity here, and the LLM client's callback reads it. Any
 * `llm.invoke` made anywhere beneath a node is therefore attributable to that
 * node, including from helpers several layers down.
 *
 * Empty outside a graph run (e.g. the k-sampling judge, which is not a graph
 * node). Callers must treat "no store" as "not part of a run", never as an
 * error - the batch judge records its own evidence through rubric_draft_batches.
 */
export interface RunScope {
  correlationId: string;
  runId: string;
  node: string;
  userId?: string;
}

const runScope = new AsyncLocalStorage<RunScope>();

/** The run/node executing on this async context, if any. */
export function currentRunScope(): RunScope | undefined {
  return runScope.getStore();
}

/**
 * Keys whose VALUES must never be written to this table.
 *
 * The graph state carries the caller's live bearer token (ask.ts puts it there
 * so downstream nodes can call the data API as the user). Storing it would put
 * working credentials in a diagnostic table that engineers browse in a GUI -
 * a far worse leak than the one this table was built to close.
 *
 * Matched case-insensitively on the key NAME, at every depth, so a token nested
 * inside a config blob is caught too. Redaction happens on the way IN: filtering
 * on read would leave the secret sitting in the database.
 */
const SECRET_KEY = /(^|_|\b)(authtoken|token|secret|password|passwd|authorization|apikey|api_key|bearer|credential)s?($|_|\b)/i;

const REDACTED = "[redacted]";

/**
 * Deep copy with secret-named keys replaced.
 *
 * Values are replaced rather than keys dropped: a missing key reads as "the
 * node never had one", while `[redacted]` says "it had one and we refused to
 * store it". The difference matters when you are reading this to work out what
 * a node was given.
 */
export function redact(value: unknown, depth = 0): unknown {
  // Depth cap guards against a cyclic or pathological state blowing the stack
  // during what is only ever a diagnostic write.
  if (depth > 12) return "[too deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** The bits of graph state that identify the run. Read structurally so the
 *  wrapper stays ignorant of what any particular node does. */
interface RunIdentity {
  correlationId: string;
  runId: string;
  queryId?: string;
  userId?: string;
}

function identify(state: unknown): RunIdentity | null {
  const s = state as { ctx?: { correlationId?: string; runId?: string; user?: { id?: string } }; queryId?: string };
  const correlationId = s?.ctx?.correlationId;
  const runId = s?.ctx?.runId;
  // No correlation id means the row could never be tied back to a run or its
  // custody record, which is the only thing that makes it evidence. Skip rather
  // than write something unattributable.
  if (!correlationId || !runId) return null;
  return { correlationId, runId, queryId: s.queryId, userId: s?.ctx?.user?.id };
}

async function recordStep(args: {
  id: RunIdentity;
  node: string;
  input: unknown;
  output: unknown;
  status: "ok" | "error";
  error?: string;
  latencyMs: number;
}): Promise<void> {
  // seq is resolved in the INSERT rather than counted in memory: no per-run
  // counter to leak, and nothing to get wrong if the graph ever stops being
  // linear.
  await db.insert(agent_run_steps).values({
    correlation_id: args.id.correlationId,
    run_id: args.id.runId,
    query_id: args.id.queryId ?? null,
    seq: sql`(SELECT COALESCE(MAX(s.seq), 0) + 1 FROM agent_run_steps s WHERE s.correlation_id = ${args.id.correlationId})`,
    node: args.node,
    input: redact(args.input) as object,
    output: args.output === undefined ? null : (redact(args.output) as object),
    status: args.status,
    error: args.error ?? null,
    latency_ms: Math.round(args.latencyMs),
    user_id: args.id.userId ?? null,
    mode: config.mode,
  });
}

/**
 * Wrap a graph node so its input, output, latency and failure are recorded.
 *
 * The node's behaviour is untouched: the same value is returned and any error
 * is rethrown unchanged. A failure to WRITE evidence is logged and swallowed -
 * a diagnostic table must never be able to fail a user's request. That is a
 * real trade: a dropped write means a step silently missing from the trace, so
 * it is logged loudly rather than passed over in silence.
 */
export function instrument<S, A extends unknown[], R>(
  node: string,
  fn: (state: S, ...args: A) => Promise<R> | R,
): (state: S, ...args: A) => Promise<R> {
  // Generic over the node's own argument tuple so the wrapper is signature-
  // preserving: LangGraph hands nodes a RunnableConfig as well as state, and a
  // wrapper that flattened that would fail to typecheck against addNode.
  return async (state: S, ...args: A): Promise<R> => {
    const id = identify(state);
    const startedAt = Date.now();

    // Publish who we are for the duration of the node, so any LLM call made
    // beneath it - however deep - can be attributed back to this node and run.
    const scope: RunScope | undefined = id
      ? { correlationId: id.correlationId, runId: id.runId, node, userId: id.userId }
      : undefined;
    const withScope = <T>(f: () => Promise<T>): Promise<T> =>
      scope ? runScope.run(scope, f) : f();

    try {
      const output = await withScope(() => Promise.resolve(fn(state, ...args)));
      if (id) {
        await recordStep({ id, node, input: state, output, status: "ok", latencyMs: Date.now() - startedAt }).catch(
          (err: unknown) => console.error(`[instrument] failed to record step '${node}':`, err),
        );
      }
      return output;
    } catch (err) {
      // A node that threw is the most interesting row in the table - record it
      // BEFORE rethrowing, or the trace stops exactly where the answer is.
      if (id) {
        await recordStep({
          id,
          node,
          input: state,
          output: undefined,
          status: "error",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          latencyMs: Date.now() - startedAt,
        }).catch((e: unknown) => console.error(`[instrument] failed to record failed step '${node}':`, e));
      }
      throw err;
    }
  };
}
