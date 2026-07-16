// src/drafting/trajectory-assemble.ts
//
// Turn a run's recorded trace into a RecordedTrajectory the checker can judge.
//
// This is the join between two things built separately: the run trace
// (agent_run_steps - what each node was given and returned) and the trajectory
// checker (did the run do what the rubric required). The trace already holds
// the evidence; this reads it out in the shape the checker needs.
//
// It reads ONLY the recorded trace, never the live corpus or Redis. The whole
// point of the trace is that it is what actually happened - re-deriving from a
// corpus that may have drifted since would answer a different question.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agent_run_steps } from "../db/schema.js";
import type { RecordedTrajectory } from "./trajectory-check.js";

/** A retrieved chunk as it sits in a retrieve node's recorded output. */
interface TracedChunk {
  source_path?: string;
  [k: string]: unknown;
}

/**
 * Assemble the trajectory of one run from its recorded steps.
 *
 * `known` is false when no retrieve step was recorded at all - the run's
 * trajectory cannot be established, and the checker turns that into an auto-fail
 * rather than a pass. A run that retrieved nothing but DID run retrieval is
 * `known: true` with an empty document list: it looked and found nothing, which
 * is a real (and failing, for any required rule) trajectory, not an unknown one.
 */
export async function assembleTrajectory(correlationId: string): Promise<RecordedTrajectory> {
  const steps = await db
    .select()
    .from(agent_run_steps)
    .where(eq(agent_run_steps.correlation_id, correlationId))
    .orderBy(agent_run_steps.seq);

  return assembleFromSteps(steps.map((s) => ({ node: s.node, output: s.output })));
}

// The node kinds through which corpus documents enter a run - across BOTH
// execution paths. The ask graph retrieves via `retrieve`/`sql_retrieve`; the
// recipe executor retrieves via `retrieve_sections`/`recall_prior`/`query_table`
// (its step kinds are its node names in the trace). If none of these ran, the
// run's trajectory is unknown, not empty.
const RETRIEVAL_NODES = new Set([
  "retrieve",
  "sql_retrieve",
  "retrieve_sections",
  "recall_prior",
  "query_table",
]);

/** The pure core, separated so it can be tested without a database. */
export function assembleFromSteps(
  steps: { node: string; output: unknown }[],
): RecordedTrajectory {
  const retrievalSteps = steps.filter((s) => RETRIEVAL_NODES.has(s.node));
  if (retrievalSteps.length === 0) {
    return { retrievedDocuments: [], agentCalls: [], known: false };
  }

  // Full identifiers are kept, NOT slugged to a basename: the checker matches
  // rule tokens as substrings, so directory words (`.../Procedures/FMEA...`)
  // must survive - slugging to the filename would drop the very word a
  // `fmea-procedure` rule needs.
  const docs = new Set<string>();
  for (const step of retrievalSteps) {
    const out = step.output as Record<string, unknown> | null;
    if (!out) continue;

    // Ask-graph retrieve: chunks carry a full source_path.
    const byTier = out.chunksByTier as Record<string, TracedChunk[]> | undefined;
    if (byTier) {
      for (const chunks of Object.values(byTier)) {
        for (const c of chunks ?? []) if (c.source_path) docs.add(c.source_path);
      }
    }

    // Recipe recall_prior: names the document type DIRECTLY. Only counts when it
    // actually recalled something - a recall that named a type but returned no
    // ids consulted nothing. (ids is a Set that serialises to {} in the trace,
    // so its refCount rides in the custody event; here, presence of a non-empty
    // recall is inferred from that when available, else the type is counted as
    // consulted.)
    if (typeof out.documentType === "string" && out.documentType) {
      docs.add(out.documentType);
    }

    // Recipe retrieve_sections: `source` is the path fragment consulted - but it
    // counts ONLY if sections actually came back. An empty return means the
    // source was NOT consulted (e.g. it is not in the corpus), and a trajectory
    // rule must not be satisfied by an attempt that retrieved nothing - that is
    // exactly the "built on nothing" case the check exists to catch.
    if (typeof out.source === "string" && out.source) {
      const sections = out.sections as unknown[] | undefined;
      if (Array.isArray(sections) && sections.length > 0) docs.add(out.source);
    }
  }

  // agentCalls stays empty: no node calls another agent yet. That is not a gap
  // in this function - it is the honest state of the graph, and it means an
  // `agent` trajectory rule fails closed until a web/A2A node exists to satisfy
  // it. A required fetched fact that was never fetched is a fabricated one.
  return {
    retrievedDocuments: Array.from(docs).sort(),
    agentCalls: [],
    known: true,
  };
}
