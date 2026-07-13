// src/observability/langfuse.ts
//
// Langfuse tracing integration. Optional and graceful: if Langfuse isn't
// configured (no keys), every function here degrades to a no-op and the
// agent runs exactly as it would without tracing.
//
// Two things make tracing work with minimal code:
//
//   1. Global async-context propagation. We initialise LangChain's
//      AsyncLocalStorage singleton so that a callback handler attached at
//      the top-level graph invocation automatically flows to every nested
//      llm.invoke() inside every node - the gate, planner, partial
//      generation, reconciliation - WITHOUT threading config through each
//      node by hand.
//
//   2. A single shared CallbackHandler. Created once from config, reused
//      across invocations. Passed via { callbacks: getLangfuseCallbacks() }.
//
// Trace identity: pass metadata with langfuseUserId / langfuseSessionId so
// traces are filterable by user and grouped by query (the sessionId is the
// queryId, so a Langfuse trace lines up 1:1 with a QueryRecord).

import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { CallbackHandler } from "langfuse-langchain";
import { config } from "../config.js";

// Enable automatic callback/context propagation across the async call tree.
// Safe to call once at module load. Without this, callbacks attached at the
// graph root would NOT reach nested llm.invoke calls inside nodes.
let contextInitialised = false;
function ensureContextPropagation(): void {
  if (contextInitialised) return;
  try {
    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
      new AsyncLocalStorage(),
    );
  } catch {
    // Already initialised elsewhere - fine
  }
  contextInitialised = true;
}

let handler: CallbackHandler | null = null;
let handlerResolved = false;

/** Returns the shared Langfuse handler, or null if tracing isn't configured. */
export function getLangfuseHandler(): CallbackHandler | null {
  if (handlerResolved) return handler;
  handlerResolved = true;

  const { publicKey, secretKey, baseUrl } = config.langfuse;
  if (!publicKey || !secretKey) {
    // Not configured - tracing off
    handler = null;
    return null;
  }

  ensureContextPropagation();

  handler = new CallbackHandler({
    publicKey,
    secretKey,
    baseUrl,
  });
  console.log(`Langfuse tracing enabled (${baseUrl})`);
  return handler;
}

/** Convenience: returns [handler] for spreading into a callbacks array, or []. */
export function getLangfuseCallbacks(): CallbackHandler[] {
  const h = getLangfuseHandler();
  return h ? [h] : [];
}

/**
 * Build the invocation config for an agent run, including callbacks and
 * Langfuse trace metadata. Spread the result into agent.stream/invoke.
 *
 * The metadata keys langfuseUserId / langfuseSessionId are recognised by the
 * Langfuse LangChain integration and become the trace's user and session.
 */
export function buildTraceConfig(params: {
  queryId: string;
  userId: string;
  tier: string;
  kind: string;
  signal?: AbortSignal;
}): Record<string, unknown> {
  const callbacks = getLangfuseCallbacks();
  return {
    callbacks,
    runName: `qms-${params.kind}`,
    metadata: {
      langfuseUserId: params.userId,
      langfuseSessionId: params.queryId,
      queryId: params.queryId,
      tier: params.tier,
      kind: params.kind,
    },
    ...(params.signal ? { signal: params.signal } : {}),
  };
}

/**
 * Flush pending traces to Langfuse. The handler batches in the background;
 * long-running processes flush periodically, but short-lived scripts (smoke
 * tests) must flush before exiting or traces are lost. Safe to call when
 * tracing is off (no-op).
 */
export async function flushLangfuse(): Promise<void> {
  const h = getLangfuseHandler();
  if (!h) return;
  try {
    await h.flushAsync();
  } catch (err) {
    console.warn("Langfuse flush failed:", err instanceof Error ? err.message : err);
  }
}