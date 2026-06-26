// src/agent/nodes/finalize.ts
//
// Sentinel node at the end of the graph. Verifies the query is in the
// expected terminal state and acts as a hook point for future extensions
// (notifications, downstream triggers, draft-mode HITL transitions).
//
// Currently does only verification. Kept as its own node so the graph
// structure remains clear and so we don't have to restructure when
// finalization grows real responsibilities.

import { QueryRecord } from "../../queries.js";
import type { AgentStateType } from "../state.js";

export async function finalize(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId } = state;

  const record = await QueryRecord.load(ctx, queryId);
  if (!record) {
    throw new Error(`QueryRecord ${queryId} not found at finalize`);
  }

  // Sanity check: by the time we hit finalize, reconcile should have set
  // the status to "complete". If it hasn't, something went wrong upstream.
  if (record.status !== "complete") {
    throw new Error(
      `QueryRecord ${queryId} at finalize has status '${record.status}', expected 'complete'`,
    );
  }

  return {};
}