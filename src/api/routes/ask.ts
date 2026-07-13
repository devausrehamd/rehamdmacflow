// src/api/routes/ask.ts
//
// POST /api/v1/ask - Server-Sent Events stream of agent execution.
//
// Flow:
//   1. Validate payload, check auth and 'ask' permission
//   2. Classify mode (ask vs draft) - draft returns 400 in v1
//   3. Create a QueryRecord in Redis
//   4. Set SSE headers, start heartbeat
//   5. Stream agent graph execution - each node completion -> SSE event
//   6. Emit final result and done events
//   7. Cleanup on success, error, or client disconnect
//
// Event types emitted:
//   started      - { queryId, mode, question }
//   node-start   - { node }                 (not currently emitted; graph streams completions)
//   node-complete- { node, summary, latency_ms }
//   result       - { answer, tiers, citations? }
//   done         - { queryId, total_latency_ms, status }
//   error        - { message, queryId, total_latency_ms }
//
// Client testing:
//   curl -N -X POST http://localhost:4000/api/v1/ask \
//     -H "Authorization: Bearer $TOKEN" \
//     -H "Content-Type: application/json" \
//     -d '{"question":"what columns are in the risk register"}'

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ValidationError } from "../errors.js";
import { QueryRecord } from "../../queries.js";
import { CORRELATION_HEADER } from "../../custody/correlation.js";
import { appendEvent } from "../../custody/ledger.js";
import { createHash } from "node:crypto";
import { agent } from "../../agent/graph.js";
import { classify } from "../../agent/classifier.js";
import { buildTraceConfig, flushLangfuse } from "../../observability/langfuse.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

const askSchema = z.object({
  question: z.string().min(1).max(2000),
});

export const askRouter = Router();

askRouter.post(
  "/api/v1/ask",
  requireAuth,
  requirePermission("ask"),
  async (req, res, next) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(new ValidationError("Invalid ask payload", parsed.error.format()));
    }
    const { question } = parsed.data;

    // Classifier - draft mode not yet implemented in v1
    const mode = classify(question);
    if (mode === "draft") {
      return next(
        new ValidationError(
          "Draft mode not yet implemented. Use ask mode (questions, not document generation requests).",
        ),
      );
    }

    // Set SSE headers BEFORE writing anything to the response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Disable nginx buffering if this is ever behind nginx
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (event: string, data: object): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat keeps the connection alive through proxies that
    // would otherwise close idle HTTP connections (typically after 30-60s)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    // If the client disconnects mid-stream, abort the graph to save compute
    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const startTime = Date.now();
    let queryId: string | null = null;

    try {
      // Custody context was resolved at the boundary and rides in ctx. The
      // correlation id is already on the response header (middleware set it).
      const custodyCtx = {
        correlationId: req.ctx!.correlationId,
        runId: req.ctx!.runId,
        userId: req.ctx!.user.id,
        decisionId: req.ctx!.decisionId,
        policyHash: req.ctx!.policyHash,
      };

      // First custody event: this agent began handling this request. Payload is
      // references only - the question is the user's own input, not retrieved
      // content, so it is recorded; no retrieved text ever enters the chain.
      await appendEvent(custodyCtx, "run_started", {
        kind: "ask",
        requestId: req.ctx!.requestId,
      });

      // Create the QueryRecord BEFORE streaming so its ID can be returned
      // in the first event
      const query = await QueryRecord.create(req.ctx!, {
        kind: "ask",
        question,
      });
      queryId = query.id;
      sendEvent("started", {
        queryId: query.id,
        mode,
        question,
        correlationId: req.ctx!.correlationId,
      });

      // Stream the graph execution. The user's bearer token is threaded into
      // the agent state so the SQL retrieval node can call the data API as the
      // user (tier permissions enforced there). This token stays in-memory in
      // the LangGraph state and is never written to the persisted QueryRecord.
      const bearerToken = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : undefined;

      const initialState = {
        queryId: query.id,
        ctx: req.ctx!,
        question,
        authToken: bearerToken,
      };

      const nodeStartTimes: Record<string, number> = {};

      const stream = await agent.stream(initialState, {
        ...buildTraceConfig({
          queryId: query.id,
          userId: req.ctx!.user.id,
          tier: req.ctx!.user.tier,
          kind: "ask",
          signal: abortController.signal,
        }),
      });

      for await (const event of stream) {
        // Each event is { nodeName: stateUpdate }
        // For most graphs there's one entry per event but iterate just in case
        for (const [nodeName, update] of Object.entries(event)) {
          const now = Date.now();
          const startedAt = nodeStartTimes[nodeName] ?? startTime;
          const latency = now - startedAt;
          nodeStartTimes[nodeName] = now;

          sendEvent("node-complete", {
            node: nodeName,
            latency_ms: latency,
            summary: summarizeNode(nodeName, update as Record<string, unknown>),
          });
        }
      }

      // Load the final QueryRecord to get the answer and metadata
      const finalQuery = await QueryRecord.load(req.ctx!, query.id);
      if (!finalQuery) {
        throw new Error("QueryRecord disappeared after agent completion");
      }
      const data = finalQuery.toJSON();

      // Custody: bind the answer by hash and record which chunks grounded it.
      // References only - the answer HASH, not its text (the text is in the
      // QueryRecord); chunk IDS, not chunk content. This closes the chain for
      // this run and is what the export later verifies.
      const answerText = data.final_answer ?? "";
      const chunkIds: string[] = [];
      for (const tier of Object.values(data.tiers)) {
        for (const c of (tier as { chunks?: { id: string }[] }).chunks ?? []) {
          chunkIds.push(c.id);
        }
      }
      await appendEvent(
        {
          correlationId: req.ctx!.correlationId,
          runId: req.ctx!.runId,
          userId: req.ctx!.user.id,
          decisionId: req.ctx!.decisionId,
          policyHash: req.ctx!.policyHash,
        },
        "run_completed",
        {
          queryId: query.id,
          status: "complete",
          answerHash: createHash("sha256").update(answerText, "utf8").digest("hex"),
          groundedInChunkIds: chunkIds,
          sqlQueryCount: (data.sql_results ?? []).length,
          totalLatencyMs: Date.now() - startTime,
        },
      );

      sendEvent("result", {
        answer: data.final_answer,
        tiers: Object.keys(data.tiers),
      });

      sendEvent("done", {
        queryId: query.id,
        total_latency_ms: Date.now() - startTime,
        status: "complete",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendEvent("error", {
        message,
        queryId,
        total_latency_ms: Date.now() - startTime,
      });

      // Mark the QueryRecord as failed so the audit shows the failure
      if (queryId) {
        try {
          const failedQuery = await QueryRecord.load(req.ctx!, queryId);
          await failedQuery?.setError(message);
        } catch {
          // ignore - we're already in the error path
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.end();
      }
      // Deliver this query's trace promptly. Fire-and-forget so it doesn't
      // delay the response; no-op when tracing is off.
      void flushLangfuse();
    }
  },
);

/**
 * Build a small summary of a node's state update for the SSE event.
 * Avoids sending the entire chunk list (which can be large) in the event;
 * the client can fetch the full QueryRecord via API later if needed.
 */
function summarizeNode(nodeName: string, update: Record<string, unknown>): object {
  if (nodeName === "understand" && update.understanding) {
    const u = update.understanding as {
      questionType?: string;
      rephrasings?: string[];
      tableRelevant?: boolean;
    };
    return {
      question_type: u.questionType,
      rephrasings: u.rephrasings?.length ?? 0,
      table_relevant: u.tableRelevant,
    };
  }

  if (nodeName === "retrieve" && update.chunksByTier) {
    const counts: Record<string, number> = {};
    const chunksByTier = update.chunksByTier as Record<string, unknown[]>;
    for (const [tier, chunks] of Object.entries(chunksByTier)) {
      counts[tier] = chunks.length;
    }
    return { chunks_per_tier: counts };
  }

  if (nodeName === "draft" && update.partialsByTier) {
    const lengths: Record<string, number> = {};
    const partials = update.partialsByTier as Record<string, string>;
    for (const [tier, partial] of Object.entries(partials)) {
      lengths[tier] = partial.length;
    }
    return { partial_chars_per_tier: lengths };
  }

  if (nodeName === "sql_retrieve" && update.sqlResults) {
    const results = update.sqlResults as Record<string, { rowCount: number }>;
    const tablesQueried = Object.keys(results).length;
    const totalRows = Object.values(results).reduce((sum, r) => sum + r.rowCount, 0);
    return { tables_queried: tablesQueried, total_rows: totalRows };
  }

  if (nodeName === "reconcile" && typeof update.finalAnswer === "string") {
    return { answer_chars: update.finalAnswer.length };
  }

  return {};
}