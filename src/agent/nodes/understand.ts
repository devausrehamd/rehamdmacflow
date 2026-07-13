// src/agent/nodes/understand.ts
//
// The query-understanding node. Runs first, before retrieval. Produces the
// QueryUnderstanding that the retrieve node uses to build multiple search
// queries (rephrasings, HyDE, entities/keywords) plus the table-targeted lane.

import { understandQuery } from "../understand.js";
import type { AgentStateType } from "../state.js";

export async function understand(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const understanding = await understandQuery(state.question);
  return { understanding };
}