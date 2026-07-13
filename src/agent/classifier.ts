// src/agent/classifier.ts
//
// Routes a request to a pipeline. A ROUTER, not a planner: it answers "which
// pipeline", never "how many tasks".
//
// It is deliberately deterministic and deliberately defensive. The old version
// was a regex over a hard-coded noun list, which had two failure modes:
//
//   1. The noun list drifted from the document types you can actually draft.
//      "generate a DFMEA" classified as ASK, because `dfmea` was not a noun in
//      the regex - even though a DFMEA rubric existed. The request for a
//      controlled document silently received a paragraph.
//
//   2. It could not see a multi-deliverable request at all. "Generate a DFMEA
//      and an Export Control Document" is not one task, and answering it as
//      one is worse than refusing.
//
// So: draftable nouns are derived from the RUBRIC REGISTRY (if you can
// evaluate it, you can draft it - one source of truth), and anything the
// classifier cannot resolve to exactly one document type becomes AMBIGUOUS and
// is returned to the human as a question rather than guessed at.
//
// Decomposition of a multi-deliverable request belongs to the orchestrator,
// which delegates atomic tasks to domain agents. A domain agent's job is to
// refuse work it cannot do unambiguously.

import {
  countDeliverables,
  hasDraftVerb,
  hasUnverifiedPremise,
  type AliasMatch,
} from "./intent.js";

export type QueryMode = "ask" | "draft" | "ambiguous";

export type Classification =
  | { mode: "ask" }
  | {
      mode: "draft";
      documentType: string;
      matchedAlias: string;
      /** The request rests on a hedged premise that must be verified first. */
      unverifiedPremise: boolean;
    }
  | {
      mode: "ambiguous";
      reason: "multiple_deliverables" | "unknown_document_type";
      /** Document types named, when the problem is that there is more than one. */
      candidates: AliasMatch[];
      message: string;
    };

export function classify(question: string): Classification {
  const { recognised, unrecognised, unrecognisedNouns } = countDeliverables(question);
  const draftVerb = hasDraftVerb(question);

  // No draft verb: it is a question about documents, not a request to make one.
  // Mentioning "capa" while asking what the CAPA procedure says is an ASK.
  if (!draftVerb) return { mode: "ask" };

  // Count EVERY deliverable named, not just the ones with a rubric. Counting
  // only recognised types would let "a DFMEA and an Export Control Document"
  // pass as a single-deliverable request, silently dropping the one this agent
  // cannot produce.
  const total = recognised.length + unrecognised;

  if (total > 1) {
    const known = recognised.map((t) => t.documentType);
    const named = [...known, ...unrecognisedNouns].join(", ");
    const unknownNote =
      unrecognised > 0
        ? ` I have no rubric for ${unrecognised === 1 ? "one of them" : "some of them"}, ` +
          `so I cannot evaluate what I would produce.`
        : "";
    return {
      mode: "ambiguous",
      reason: "multiple_deliverables",
      candidates: recognised,
      message:
        `This request names ${total} deliverables (${named}). Each has its own procedure, ` +
        `rubric, and approver, so I will not produce them as one task.${unknownNote} ` +
        `Ask for one at a time, or route this through the orchestrator.`,
    };
  }

  const types = recognised;

  // A draft verb naming nothing I can evaluate. Refusing is the safe answer:
  // a document type with no rubric is a document type whose output cannot be
  // judged, and an unjudged controlled document is worse than none.
  if (types.length === 0) {
    return {
      mode: "ambiguous",
      reason: "unknown_document_type",
      candidates: [],
      message:
        `I can see you want a document produced, but not which kind. This agent can ` +
        `draft only document types it can also evaluate. Name the deliverable explicitly.`,
    };
  }

  return {
    mode: "draft",
    documentType: types[0].documentType,
    matchedAlias: types[0].matchedAlias,
    unverifiedPremise: hasUnverifiedPremise(question),
  };
}