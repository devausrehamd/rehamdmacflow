// src/agent/nodes/grounding-notice.ts
//
// The call-it-out node (grounding gate, increment 1). When the planner decoded a
// term the schema does not define — a filter whose value falls outside its
// column's domain — the sql_retrieve node refused to execute it and recorded the
// decode failure. Rather than answer around it (which would silently drop the
// user's intent) or report a misleading count, this node states plainly what
// could not be mapped, lists the fields that CAN be queried, and asks for a
// grounded rephrase. Deterministic — no LLM, so it cannot invent a value.

import { QueryRecord } from "../../queries.js";
import type { AgentStateType } from "../state.js";
import { composeGroundingNotice } from "../grounding.js";

export async function groundingNotice(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId, groundingIssues } = state;

  const queryRecord = await QueryRecord.load(ctx, queryId);
  if (!queryRecord) {
    throw new Error(`QueryRecord ${queryId} not found in grounding_notice node`);
  }

  const answer = composeGroundingNotice(groundingIssues ?? []);
  await queryRecord.setFinalAnswer(answer, 0);
  return { finalAnswer: answer };
}
