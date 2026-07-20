// src/agent/llm-trace.ts
//
// Capture every prompt sent to the model and every completion that came back.
//
// Attached ONCE to the shared client in clients.ts, as a LangChain callback.
// Every `llm.invoke` in the codebase - draft, reconcile, the SQL planner, the
// section generator, the judge - flows through that one client, so instrumenting
// it captures all of them. Recording at each call site instead would mean seven
// edits today and a silent gap the first time someone adds an eighth.
//
// Attribution comes from the run scope the node wrapper publishes, so a call
// made by a helper several layers beneath a node still lands on that node.
// Calls with no run scope (the k-sampling judge, the startup health check) are
// NOT recorded here: they are not part of a graph run, and the batch judge
// already records its own verdicts and rationales via rubric_draft_batches.
// Writing them with a null correlation would produce rows that can never be
// tied to anything.

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { config } from "../config.js";
import { traceClient } from "../data/trace-client.js";
import { currentRunScope, type RunScope } from "./instrument.js";

/** A call in flight: LangChain hands us the prompt on start and the completion
 *  on end, keyed by its own run id, so the two halves are joined here. */
interface Pending {
  prompt: string;
  startedAt: number;
  scope: RunScope;
  model?: string;
}

export class LlmTraceCallback extends BaseCallbackHandler {
  name = "qms-llm-trace";
  // Errors in a callback must never take down the model call it is observing.
  override awaitHandlers = false;
  override raiseError = false;

  private pending = new Map<string, Pending>();

  /** Chat models (ChatOpenAI) report through here rather than handleLLMStart. */
  override async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
  ): Promise<void> {
    this.start(runId, flattenMessages(messages), modelOf(llm));
  }

  /** Kept for completeness: a non-chat model would report through this. */
  override async handleLLMStart(llm: Serialized, prompts: string[], runId: string): Promise<void> {
    this.start(runId, prompts.join("\n\n"), modelOf(llm));
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const p = this.pending.get(runId);
    if (!p) return;
    this.pending.delete(runId);
    await this.record(p, textOf(output), "ok", undefined);
  }

  override async handleLLMError(err: unknown, runId: string): Promise<void> {
    const p = this.pending.get(runId);
    if (!p) return;
    this.pending.delete(runId);
    // A failed call is the most interesting one in the table: the prompt that
    // broke the model is exactly what you want to read.
    await this.record(p, null, "error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }

  private start(runId: string, prompt: string, model?: string): void {
    const scope = currentRunScope();
    // No scope: not part of a graph run. Skip rather than write an
    // unattributable row.
    if (!scope) return;
    this.pending.set(runId, { prompt, startedAt: Date.now(), scope, model });
  }

  private async record(p: Pending, completion: string | null, status: "ok" | "error", error?: string): Promise<void> {
    // The token rides in the run scope the node wrapper published; without it the
    // call cannot be written via the API. Skip rather than lose the run — the
    // batch judge and health check run with no scope and never reach here.
    const token = p.scope.authToken;
    if (!token) {
      console.warn("[llm-trace] no auth token in scope; LLM call not recorded");
      return;
    }
    try {
      // Recorded THROUGH the Data Access API (decision 13): no db client here.
      // The seq is resolved server-side inside the INSERT.
      await traceClient(token).llmCall({
        correlationId: p.scope.correlationId,
        runId: p.scope.runId,
        node: p.scope.node,
        model: p.model ?? config.ollama.model,
        prompt: p.prompt,
        completion,
        status,
        error,
        latencyMs: Date.now() - p.startedAt,
        mode: config.mode,
      });
    } catch (err) {
      // Never fail a model call because its diagnostic write failed - but say
      // so loudly, because a dropped write is a silent hole in the trace.
      console.error("[llm-trace] failed to record LLM call:", err);
    }
  }
}

/** The prompt as the model received it: every message, in order, labelled by
 *  role. Roles matter - a system message and a human message are not
 *  interchangeable when you are working out what the model was actually told. */
function flattenMessages(messages: BaseMessage[][]): string {
  return messages
    .flat()
    .map((m) => {
      const role = m.getType?.() ?? "message";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

function textOf(output: LLMResult): string {
  return output.generations.flat().map((g) => g.text).join("\n");
}

function modelOf(llm: Serialized): string | undefined {
  const kwargs = (llm as { kwargs?: Record<string, unknown> }).kwargs;
  const model = kwargs?.model ?? kwargs?.modelName;
  return typeof model === "string" ? model : undefined;
}
