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

/** Slug a corpus path down to a type-ish identifier: the basename, normalised.
 *  "08_Governance/Procedures/CAPA_Procedure_Rev3.docx" -> "capa-procedure-rev3".
 *  Kept as a slug (not split to tokens) because the checker tokenises it - this
 *  just strips the directory and the extension so the filename is what matches. */
function pathToSlug(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

/** The pure core, separated so it can be tested without a database. */
export function assembleFromSteps(
  steps: { node: string; output: unknown }[],
): RecordedTrajectory {
  // A retrieval node is where corpus documents enter the run. If none ran, the
  // trajectory is unknown - we cannot say what was or was not consulted.
  const retrievalSteps = steps.filter((s) => s.node === "retrieve" || s.node === "sql_retrieve");
  if (retrievalSteps.length === 0) {
    return { retrievedDocuments: [], agentCalls: [], known: false };
  }

  const slugs = new Set<string>();
  for (const step of retrievalSteps) {
    const byTier = (step.output as { chunksByTier?: Record<string, TracedChunk[]> } | null)?.chunksByTier;
    if (!byTier) continue;
    for (const chunks of Object.values(byTier)) {
      for (const c of chunks ?? []) {
        if (c.source_path) slugs.add(pathToSlug(c.source_path));
      }
    }
  }

  // agentCalls stays empty: no node calls another agent yet. That is not a gap
  // in this function - it is the honest state of the graph, and it means an
  // `agent` trajectory rule fails closed until a web/A2A node exists to satisfy
  // it. A required fetched fact that was never fetched is a fabricated one.
  return {
    retrievedDocuments: Array.from(slugs).sort(),
    agentCalls: [],
    known: true,
  };
}
