// src/orchestrator/capability-select.ts
//
// The Talk Agent's capability selection (Stage 5 of the agent-platform control
// plane, docs/specs/SPEC-agent-platform-and-control-plane.md §4, decision 10).
//
// Given a request, the Talk Agent traverses a catalog of capabilities and selects
// the one closest to it. This is the non-deterministic seam of the flow, so it is
// bracketed: a deterministic match where the request maps cleanly, and a
// clarify flag below a confidence threshold rather than a silent wrong guess.
//
// This MVP selector is deterministic (intent + keyword match). An LLM ranker for
// close candidates drops in behind the same signature; the catalog is data.

export type CapabilityKind = "answer" | "draft";

export interface Capability {
  /** e.g. "research:qms" | "draft:capa". */
  id: string;
  kind: CapabilityKind;
  description: string;
  /** Words/aliases that indicate this capability. */
  keywords: string[];
}

export interface Selection {
  capability: Capability;
  /** 0..1 — how confident the selection is. */
  confidence: number;
  alternatives: { id: string; kind: CapabilityKind }[];
  /** True when the request does not map cleanly and clarification is warranted. */
  clarify: boolean;
}

/** The default catalog. `research:qms` answers questions from the corpus and
 *  structured data; the draft capabilities produce controlled documents. */
export const DEFAULT_CATALOG: Capability[] = [
  {
    id: "research:qms",
    kind: "answer",
    description: "Answer a question about the QMS from the corpus and structured data.",
    keywords: [],
  },
  { id: "draft:capa", kind: "draft", description: "Draft a CAPA (corrective/preventive action).", keywords: ["capa", "corrective action", "8d"] },
  { id: "draft:dfmea", kind: "draft", description: "Draft a design FMEA.", keywords: ["dfmea", "fmea", "failure mode"] },
  { id: "draft:risk-register", kind: "draft", description: "Draft a project risk register.", keywords: ["risk register"] },
];

const DRAFT_INTENT = /\b(draft|create|generate|write|produce|prepare|author)\b/;

/**
 * Select the capability closest to a request. Draft intent plus a known
 * document-type keyword selects that draft capability; an ordinary question
 * selects the research capability; anything too short or a draft with no known
 * type asks for clarification.
 */
export function selectCapability(question: string, catalog: Capability[] = DEFAULT_CATALOG): Selection {
  const q = question.trim().toLowerCase();
  const research = catalog.find((c) => c.id === "research:qms") ?? catalog.find((c) => c.kind === "answer")!;
  const draftCaps = catalog.filter((c) => c.kind === "draft");
  const alternativesOf = (chosen: Capability) =>
    catalog.filter((c) => c.id !== chosen.id).map((c) => ({ id: c.id, kind: c.kind }));

  // Too short / empty -> clarify.
  if (q.length < 3) {
    return { capability: research, confidence: 0, alternatives: alternativesOf(research), clarify: true };
  }

  if (DRAFT_INTENT.test(q)) {
    const match = draftCaps.find((c) => c.keywords.some((k) => q.includes(k)));
    if (match) {
      return { capability: match, confidence: 0.9, alternatives: alternativesOf(match), clarify: false };
    }
    // Draft intent but no known document type -> clarify which document.
    return { capability: research, confidence: 0.3, alternatives: alternativesOf(research), clarify: true };
  }

  // Default: answer the question.
  return { capability: research, confidence: 0.8, alternatives: alternativesOf(research), clarify: false };
}

/** A response-safe view of a selection (no internal keyword lists). */
export function describeSelection(s: Selection) {
  return {
    capability: s.capability.id,
    kind: s.capability.kind,
    description: s.capability.description,
    confidence: s.confidence,
    alternatives: s.alternatives,
  };
}
