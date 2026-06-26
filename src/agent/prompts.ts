// src/agent/prompts.ts
//
// Prompt templates for the agent's LLM calls. Centralized here so prompt
// engineering happens in one file rather than scattered through node code.
//
// Three prompt builders:
//   - buildRetrievalQuery: rewrites a question for better retrieval (currently identity)
//   - buildPartialAnswerPrompt: per-tier "answer from this context"
//   - buildReconciliationPrompt: combines partials into a final answer

import type { RetrievedChunk } from "../queries.js";

/**
 * Rewrite a question for retrieval if needed.
 * v1: identity transform (pass through unchanged).
 * Future: HyDE pattern (generate hypothetical answer, embed that for retrieval),
 * query expansion, or multi-query retrieval.
 */
export function buildRetrievalQuery(question: string): string {
  return question;
}

/**
 * Build the prompt for generating a partial answer using chunks from one tier.
 *
 * The prompt is deliberately strict about grounding ("answer ONLY from
 * the context") to reduce hallucination. Citations by source number keep
 * the model honest about which chunk supported which claim.
 */
export function buildPartialAnswerPrompt(
  question: string,
  tier: string,
  chunks: RetrievedChunk[],
): string {
  const context = chunks
    .map((c, i) => {
      const src = c.source_path ?? "unknown";
      const sheet = c.sheet_name ? ` [sheet: ${c.sheet_name}]` : "";
      const rows = c.row_range ? ` [rows ${c.row_range[0]}-${c.row_range[1]}]` : "";
      return `[Source ${i + 1}: ${src}${sheet}${rows}]\n${c.text}`;
    })
    .join("\n\n---\n\n");

  return `You are answering a question using the following context from the "${tier}" information domain.

CONTEXT:
${context}

QUESTION: ${question}

Instructions:
- Answer based ONLY on the context above.
- If the context does not contain enough information, say so explicitly.
- Cite sources by their bracketed source numbers (e.g. "according to Source 1").
- Be concise but complete.
- If the question is about specific values or details, quote them exactly.`;
}

/**
 * Build the reconciliation prompt.
 *
 * In v1 with one tier, this is effectively a polish pass.
 * When tiers split, this becomes the federated synthesis step that
 * combines partial answers from multiple information domains.
 */
export function buildReconciliationPrompt(
  question: string,
  partialsByTier: Record<string, string>,
): string {
  const tiers = Object.keys(partialsByTier);

  // Single-tier case: just polish the partial for the final response.
  if (tiers.length === 1) {
    return `Polish the following answer to be clear, well-structured, and direct.

QUESTION: ${question}

DRAFT ANSWER:
${partialsByTier[tiers[0]]}

Return the polished answer. Preserve all citations exactly as written.`;
  }

  // Multi-tier case: reconciliation across information domains.
  const partials = tiers
    .map((tier) => `[Domain: ${tier}]\n${partialsByTier[tier]}`)
    .join("\n\n---\n\n");

  return `You are answering a question for a user with access to multiple information domains.

The partial answers below were each generated using only sources from one domain. Your job is to produce a final reconciled answer.

PARTIAL ANSWERS:
${partials}

QUESTION: ${question}

Instructions:
- Cite which domain each piece of information came from.
- Note explicitly when domains agree, disagree, or are silent on a point.
- Do NOT introduce information not present in the partial answers.
- Do NOT invent connections between domains that aren't stated.
- Preserve source citations from the partials.

RECONCILED ANSWER:`;
}