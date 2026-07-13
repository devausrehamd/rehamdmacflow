// src/agent/understand.ts
//
// Query understanding. Two LLM calls:
//   1. Analysis (JSON): question type, entities, keywords, rephrasings,
//      and whether structured tables look relevant.
//   2. HyDE (plain text): a hypothetical answer passage. Embedding a
//      hypothetical ANSWER retrieves better than embedding the QUESTION,
//      because answers live nearer the relevant chunks in vector space.
//
// Split into two calls deliberately: the analysis is JSON (parse-recovery
// applies), the HyDE is free text (which 7B models do reliably). Keeping
// them separate stops a HyDE formatting hiccup from breaking the analysis.
//
// Everything degrades gracefully: if the analysis JSON won't parse, we fall
// back to a heuristic understanding so the pipeline never hard-fails.

import { llm } from "../clients.js";
import { extractJson } from "./parse.js";

export type QuestionType = "factual" | "relational" | "descriptive" | "mixed";

export interface QueryUnderstanding {
  questionType: QuestionType;
  entities: string[];
  keywords: string[];
  rephrasings: string[];
  hydeAnswer: string;
  tableRelevant: boolean;
}

const ANALYSIS_PROMPT = (question: string) => `Analyse this question to improve document retrieval. Return ONLY a JSON object.

Question: ${question}

Return:
{
  "question_type": "factual" | "relational" | "descriptive" | "mixed",
  "entities": ["specific names, IDs, or values mentioned"],
  "keywords": ["important search terms, not filler words"],
  "rephrasings": ["2-3 alternative ways to phrase this question for search"],
  "table_relevant": true or false
}

Guidance:
- "relational" = asks for specific values, counts, filters, or comparisons (likely needs a data table).
- "descriptive" = asks what something is or what it contains.
- "factual" = asks for a specific fact from prose.
- rephrasings should vary the wording meaningfully, not just reorder words.
- table_relevant is true if the answer likely comes from structured/tabular data.`;

const HYDE_PROMPT = (question: string) => `Write a brief, plausible passage (2-3 sentences) that would directly answer this question, as if quoted from a quality-management document. Do not hedge or say you don't know - write the hypothetical answer content. This is used only to improve search.

Question: ${question}

Passage:`;

const RELATIONAL_HINT =
  /\b(how many|count|number of|total|which|list|owned by|assigned to|status|greater|less than|more than|highest|lowest|average)\b/i;

function heuristicUnderstanding(question: string): QueryUnderstanding {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return {
    questionType: RELATIONAL_HINT.test(question) ? "relational" : "factual",
    entities: [],
    keywords: Array.from(new Set(words)).slice(0, 8),
    rephrasings: [question],
    hydeAnswer: "",
    tableRelevant: RELATIONAL_HINT.test(question),
  };
}

export async function understandQuery(question: string): Promise<QueryUnderstanding> {
  // --- Analysis call (JSON) ---
  let analysis: Partial<QueryUnderstanding> = {};
  try {
    const res = await llm.invoke(ANALYSIS_PROMPT(question));
    const parsed = extractJson(String(res.content)) as Record<string, unknown>;
    analysis = {
      questionType: (parsed.question_type as QuestionType) ?? "factual",
      entities: toStringArray(parsed.entities),
      keywords: toStringArray(parsed.keywords),
      rephrasings: toStringArray(parsed.rephrasings),
      tableRelevant: Boolean(parsed.table_relevant),
    };
  } catch {
    // Analysis failed - use heuristic for the structured parts
    const h = heuristicUnderstanding(question);
    analysis = {
      questionType: h.questionType,
      entities: h.entities,
      keywords: h.keywords,
      rephrasings: h.rephrasings,
      tableRelevant: h.tableRelevant,
    };
  }

  // --- HyDE call (plain text) ---
  let hydeAnswer = "";
  try {
    const res = await llm.invoke(HYDE_PROMPT(question));
    hydeAnswer = String(res.content).trim();
  } catch {
    hydeAnswer = "";
  }

  return {
    questionType: analysis.questionType ?? "factual",
    entities: analysis.entities ?? [],
    keywords: analysis.keywords ?? [],
    // Always include the original question as a retrieval query downstream;
    // here we keep rephrasings as the model gave them.
    rephrasings: (analysis.rephrasings ?? []).filter((r) => r && r !== question),
    hydeAnswer,
    tableRelevant: analysis.tableRelevant ?? false,
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, 8);
}