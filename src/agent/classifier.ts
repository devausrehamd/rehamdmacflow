// src/agent/classifier.ts
//
// Heuristic classifier that decides whether a question is a Q&A (ask mode)
// or a request to produce a document (draft mode).
//
// Heuristic instead of an LLM call because:
//   - Most requests fall clearly into one bucket
//   - Heuristic is instant; an LLM call adds 1-3 seconds
//   - The cost of misclassification is low - draft requests that look
//     like asks just get a Q&A response instead of a draft
//
// If accuracy becomes a problem, we can swap to an LLM-based classifier
// later without changing the call sites.

export type QueryMode = "ask" | "draft";

// Regex matches phrases like:
//   "draft an SDP for..."
//   "write a software verification plan"
//   "create a risk analysis"
//   "generate a procedure"
//   "produce a spec"
const DRAFT_PATTERN =
  /\b(draft|write|create|generate|produce|prepare|author)\s+(an?\s+|the\s+)?(sdp|svp|risk|sop|plan|specification|spec|procedure|protocol|document|report)/i;

export function classify(question: string): QueryMode {
  return DRAFT_PATTERN.test(question) ? "draft" : "ask";
}