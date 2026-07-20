// src/api/routes/orchestrator.ts
//
// The Talk Agent / orchestrator endpoint (Stage 5 of the agent-platform control
// plane, docs/specs/SPEC-agent-platform-and-control-plane.md §4).
//
// POST /api/v1/orchestrator/ask — the user-facing front door. It:
//   1. authenticates the caller (requireAuth), starting a session (correlationId,
//      userId) — one per question;
//   2. SELECTS the capability closest to the request from the catalog, and
//      surfaces the selection in the response (the "confirm" is transparency, not
//      a hidden decision);
//   3. ORCHESTRATES the answer. For the MVP the research capability runs the
//      capable agent graph (the researcher), threading the caller's bearer token
//      so retrieval and SQL run under the caller's entitlements (min(user, agent)).
//      Remote dispatch via the Supervisor + a capability invocation endpoint, and
//      draft capabilities via executeRecipe, are the evolution behind this seam.
//
// Non-streaming JSON so the GUI and a test can consume it directly.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { selectCapability, describeSelection } from "../../orchestrator/capability-select.js";
import { QueryRecord } from "../../queries.js";
import { agent } from "../../agent/graph.js";
import { buildTraceConfig, flushLangfuse } from "../../observability/langfuse.js";

export const orchestratorRouter = Router();

const askBody = z.object({ question: z.string().min(1) });

orchestratorRouter.post("/api/v1/orchestrator/ask", requireAuth, async (req, res, next) => {
  try {
    const parsed = askBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A non-empty 'question' is required." });
      return;
    }
    const question = parsed.data.question;
    const selection = selectCapability(question);

    // Below the confidence threshold: ask for clarification rather than guess.
    if (selection.clarify) {
      res.json({
        correlationId: req.ctx!.correlationId,
        selection: describeSelection(selection),
        needsClarification: true,
        answer: null,
      });
      return;
    }

    // MVP orchestration: the research capability answers by running the graph.
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : undefined;
    const query = await QueryRecord.create(req.ctx!, { kind: "ask", question });
    const controller = new AbortController();

    const stream = await agent.stream(
      { queryId: query.id, ctx: req.ctx!, question, authToken: bearer },
      buildTraceConfig({
        queryId: query.id,
        userId: req.ctx!.user.id,
        tier: req.ctx!.user.tier,
        kind: "orchestrator-ask",
        signal: controller.signal,
      }),
    );
    // Drive the graph to completion; the finalize node writes the answer.
    for await (const _event of stream) {
      void _event;
    }
    await flushLangfuse().catch(() => {});

    const finalQuery = await QueryRecord.load(req.ctx!, query.id);
    const answer = finalQuery?.toJSON().final_answer ?? "";

    res.json({
      correlationId: req.ctx!.correlationId,
      queryId: query.id,
      selection: describeSelection(selection),
      answer,
    });
  } catch (err) {
    next(err);
  }
});
