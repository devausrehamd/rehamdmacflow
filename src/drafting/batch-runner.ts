// src/drafting/batch-runner.ts
//
// Run a draft rubric's judge k times against one document and aggregate the
// per-criterion pass RATES. This is the editor's steering loop: tweak a
// criterion, run a batch, see whether the rate moved beyond the noise.
//
// The judge is INJECTED (DocumentJudge) so this is testable with a mock that
// has controllable variance - the smoke test proves the aggregation and the
// coin-flip detection without Ollama. Production injects the real LLM judge.
//
// One batch = k runs. The per-run verdicts are aggregated by rubric-stats into
// pass counts, Wilson CIs, stability flags, and a score distribution.

import type { Rubric } from "./rubric-schema.js";
import { checkPatterns, type CriterionVerdict } from "./scoring.js";
import { aggregateBatch, type BatchStats } from "./rubric-stats.js";

/** Judge a whole document against a rubric, returning one bit per criterion. */
export type DocumentJudge = (rubric: Rubric, documentText: string) => Promise<CriterionVerdict[]>;

/**
 * The real LLM judge for a document. Hybrid/deterministic criteria are
 * pattern-checked first (deterministic => zero variance, which is exactly why
 * moving criteria toward patterns stabilises a rubric). Only llm_judge criteria
 * incur run-to-run variance.
 *
 * The LLM client and JSON parser are imported LAZILY, inside the function, so
 * that importing this module (e.g. for the mock-judge smoke test) does not pull
 * in clients.ts and open Redis/Qdrant connections. A test using a mock judge
 * touches no external service.
 */
export const llmDocumentJudge: DocumentJudge = async (rubric, documentText) => {
  const { llm } = await import("../clients.js");
  const { extractJson } = await import("../agent/parse.js");
  const verdicts: CriterionVerdict[] = [];
  for (const c of rubric.criteria) {
    if (c.assessmentType === "deterministic" || c.assessmentType === "hybrid") {
      const pc = checkPatterns(c, documentText);
      if (!pc.passed) { verdicts.push({ id: c.id, verdict: "fail", source: c.assessmentType, rationale: `pattern: ${pc.hits.map((h) => h.label).join(", ")}`, patternHits: pc.hits }); continue; }
      if (c.assessmentType === "deterministic") { verdicts.push({ id: c.id, verdict: "pass", source: "deterministic", rationale: "patterns clean" }); continue; }
    }
    const prompt = `Evaluate against ONE criterion. Answer strict JSON {"verdict":"pass"|"fail","rationale":"..."}.
Criterion: ${c.criterion}
Explanation: ${c.explanation}
Output:
${documentText}
Return ONLY the JSON.`;
    try {
      const resp = await llm.invoke(prompt);
      const parsed = extractJson(String(resp.content)) as { verdict: string; rationale?: string };
      verdicts.push({ id: c.id, verdict: parsed.verdict === "pass" ? "pass" : "fail", source: c.assessmentType === "hybrid" ? "hybrid" : "llm_judge", rationale: parsed.rationale ?? "" });
    } catch {
      verdicts.push({ id: c.id, verdict: "fail", source: "llm_judge", rationale: "no parseable verdict; failed closed" });
    }
  }
  return verdicts;
};

export interface BatchResult {
  stats: BatchStats;
  /** The raw per-run verdicts, kept so the run is reproducible/inspectable. */
  runs: CriterionVerdict[][];
}

/**
 * Run k judging passes and aggregate. Runs are independent samples - the whole
 * point is to observe the variance, so they are NOT deduplicated or cached.
 */
export async function runBatch(
  rubric: Rubric,
  documentText: string,
  k: number,
  judge: DocumentJudge = llmDocumentJudge,
): Promise<BatchResult> {
  const runs: CriterionVerdict[][] = [];
  for (let i = 0; i < k; i++) {
    runs.push(await judge(rubric, documentText));
  }
  return { stats: aggregateBatch(rubric, runs), runs };
}