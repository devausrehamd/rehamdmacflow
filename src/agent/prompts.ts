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
import { renderSqlResults, type SqlResultForPrompt } from "./sql-render.js";

// Re-exported so existing importers of this type from prompts.js keep working.
export type { SqlResultForPrompt };

// A table blurb has two parts: a prose description (good for the answering
// model to know the table exists and what it holds) and a schema section -
// the "query manual" containing the table id and "query the data API using
// structured query primitives" instructions. That schema section is guidance
// for the PLANNER, not content for the answer. If it reaches the answering
// prompt, the model tends to describe HOW to query instead of using the
// exact data. So we strip it: keep the prose, drop everything from the
// schema marker onward.
const BLURB_SCHEMA_MARKER = "Structured data available. SQL table id:";

function stripBlurbSchema(text: string): string {
  const idx = text.indexOf(BLURB_SCHEMA_MARKER);
  if (idx === -1) return text; // not a blurb, or format changed - leave as-is
  return text.slice(0, idx).trimEnd();
}

// A model that is told to cite sometimes emits a TEMPLATE placeholder instead of
// a real reference — "[Insert relevant citation here]", "[relevant citation]",
// "[Source]" — especially on a "no data" answer where it has nothing specific to
// point at. The prompts forbid this, but a 7B is not reliable, so this is the
// deterministic net: it matches a placeholder bracket (one carrying a template
// word and NO source number, or an empty "[Source]") while leaving a real
// "[Source 8: …]" untouched.
const CITATION_PLACEHOLDER =
  /\[(?![^\]]*\d)[^\]]*\b(?:insert|citation|placeholder|add|your|tbd|todo|xxx)\b[^\]]*\]|\[\s*sources?\s*\]/gi;

/** Does this text contain a placeholder citation rather than a real one? */
export function hasPlaceholderCitation(text: string): boolean {
  CITATION_PLACEHOLDER.lastIndex = 0;
  return CITATION_PLACEHOLDER.test(text);
}

/**
 * Replace any placeholder citation with a real one built from the sources that
 * were actually retrieved. A "no data" answer keeps its wording but gains a
 * citation with information — the sources that were reviewed — rather than a
 * template. With no sources at all, it says so plainly. Real "[Source N: …]"
 * citations are left untouched; only placeholders are rewritten.
 */
export function repairCitation(answer: string, sourcePaths: string[]): string {
  if (!hasPlaceholderCitation(answer)) return answer;
  const distinct = [...new Set(sourcePaths.filter(Boolean))];
  const replacement =
    distinct.length > 0
      ? distinct.map((p) => `[Source: ${p}]`).join(", ")
      : "no matching source in the retrieved context";
  return answer.replace(CITATION_PLACEHOLDER, replacement);
}

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
  sqlResults?: SqlResultForPrompt[],
): string {
  const context = chunks
    .map((c, i) => {
      const src = c.source_path ?? "unknown";
      const sheet = c.sheet_name ? ` [sheet: ${c.sheet_name}]` : "";
      const rows = c.row_range ? ` [rows ${c.row_range[0]}-${c.row_range[1]}]` : "";
      return `[Source ${i + 1}: ${src}${sheet}${rows}]\n${stripBlurbSchema(c.text)}`;
    })
    .join("\n\n---\n\n");

  // Exact data from SQL takes precedence over prose inference. The
  // presentation layer (sql-render) turns the rows into prose the model
  // reads reliably - no raw JSON reaches the prompt.
  let exactDataSection = "";
  if (sqlResults && sqlResults.length > 0) {
    const rendered = renderSqlResults(sqlResults);
    exactDataSection = `\n\nEXACT DATA — this comes from precise database queries and is DEFINITIVE. It is the authoritative answer to the question. Use these exact numbers and values; do NOT say information is missing when it appears here:\n\n${rendered}\n`;
  }

  return `You are answering a question using the following context from the "${tier}" information domain.

CONTEXT:
${context}${exactDataSection}

QUESTION: ${question}

Instructions:
- If EXACT DATA is provided above, it IS the answer - state it directly and confidently. Never say information is unavailable when exact data is present.
- Otherwise answer from the context, and only say information is missing if neither the context nor exact data covers it.
- End with a "Citation:" line that names the REAL sources above by their bracketed labels, e.g. "Citation: [Source 2], [Source 5]". Cite the sources that support your answer; for a figure from EXACT DATA, cite the [Source N] of the table it came from.
- A "no data" answer still cites what was searched: if the sources above do not contain the answer, list the sources you reviewed, e.g. "Citation: reviewed [Source 1], [Source 3]; none record an owner named 'Singh'."
- NEVER write placeholder or template text such as "[Insert citation here]", "[relevant citation]", "[Source]", or an empty citation. Every citation must reference a real [Source N] shown above.
- Be concise and direct. If the question asks "how many", give the number.`;
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
${partialsByTier[tiers[0]!]}

Return the polished answer. Preserve all specific numbers, counts, and values EXACTLY - never soften a definite figure into "some" or "insufficient information". Preserve every real source citation exactly as written. NEVER output placeholder or template text such as "[Insert citation here]" or an empty citation; if the draft ends in a placeholder, replace it with the actual [Source N] labels the draft refers to.`;
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
- Preserve source citations from the partials, and NEVER output placeholder or template text such as "[Insert citation here]"; every citation must name a real source or domain.

RECONCILED ANSWER:`;
}