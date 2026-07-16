// src/drafting/handlers.ts
//
// The step handlers. Six of seven are deterministic. The LLM lives in exactly
// two: generate_section and judge. Both confine it tightly.
//
//   generate_section - the model fills the DECLARED fields of ONE section. Its
//     output is parsed against the section schema and run through the
//     deterministic validator BEFORE it is trusted. It never decides structure,
//     never computes a computed field, never invents a field. Best-of-N: sample
//     a few, keep the one with the fewest gaps and errors.
//
//   judge - the model returns ONE BIT per criterion (PASS/FAIL + rationale). It
//     never sees the weights and never computes the score. scoreRubric does the
//     arithmetic; hybrid/deterministic criteria are pattern-checked first.
//
// This is the seamstress sewing panels that were cut, sized, and marked.

import { llm } from "../clients.js";
import { checkTrajectory, type RecordedTrajectory } from "./trajectory-check.js";
import { extractJson } from "../agent/parse.js";
import type { Rubric } from "./rubric-schema.js";
import { sectionSchema } from "./section-schema.js";
import {
  validateSection,
  type ProducedRow,
  type SectionValidation,
} from "./section-validator.js";
import { checkPatterns, scoreRubric, type CriterionVerdict, type RubricResult } from "./scoring.js";
import type { StepHandlers, OutputBag, StepOutputs } from "./executor.js";
import type { Step } from "./recipe.js";

/** Count of gaps + errors - lower is better, for best-of-N selection. */
function defectScore(v: SectionValidation): number {
  const gaps = v.rows.reduce((n, r) => n + r.gaps.length, 0);
  return gaps + v.findings.filter((f) => f.kind !== "missing_required").length;
}

/** Collect reference sets a section's reference fields need, from prior recall_prior steps. */
function referenceSetsFrom(bag: OutputBag): Record<string, Set<string>> {
  const sets: Record<string, Set<string>> = {};
  for (const out of Object.values(bag)) {
    if (out && "ids" in out && "documentType" in out && "export" in out) {
      const o = out as StepOutputs["recall_prior"];
      sets[`${o.documentType}.${o.export}.id`] = o.ids;
    }
  }
  return sets;
}

/**
 * The one generative step. Samples `bestOf` candidates, validates each against
 * the declared section schema, keeps the least-defective. A gap is NOT a
 * failure to retry away - it is recorded as insufficient_evidence. We retry to
 * reduce avoidable errors (bad types, ungrounded values), not to pressure the
 * model into inventing a missing rating.
 */
async function generateSection(
  step: Extract<Step, { kind: "generate_section" }>,
  bag: OutputBag,
  rubric: Rubric,
): Promise<StepOutputs["generate_section"]> {
  const spec = sectionSchema.parse(rubric.sections.find((s) => s.id === step.sectionId));
  const refSets = referenceSetsFrom(bag);

  // Build a CITATION CATALOGUE: every piece of context gets a stable token the
  // model can echo as a source. A retrieved field is grounded only if it cites
  // one of these tokens (checked by membership in the validator). Without this,
  // the model has values but nothing citable to attach, and every retrieved
  // field validates as ungrounded - which is the bug this fixes.
  const validSourceRefs = new Set<string>();
  const catalogueLines: string[] = [];

  for (const name of spec.groundedIn) {
    for (const [id, out] of Object.entries(bag)) {
      if (!out) continue;

      // Table rows: each row's own identifier is its citation token. Prefer a
      // domain id column (risk_id, id) so the token is meaningful.
      if ("rows" in out) {
        for (const row of out.rows) {
          const token = String(row.risk_id ?? row.id ?? `${id}:${out.rows.indexOf(row)}`);
          validSourceRefs.add(token);
          catalogueLines.push(`  source "${token}": ${JSON.stringify(row)}`);
        }
      }

      // SOP sections: the section id is the token.
      if ("sections" in out) {
        for (const s of out.sections) {
          validSourceRefs.add(s.id);
          catalogueLines.push(`  source "${s.id}": ${s.text}`);
        }
      }
    }
    void name;
  }

  const catalogue = catalogueLines.join("\n");

  const fieldSpec = spec.fields
    .map((f) => {
      const bits = [`${f.name} (${f.type}, ${f.provenance})`];
      if (f.provenance === "computed") bits.push(`COMPUTED by code as ${f.formula} - do NOT fill, leave null`);
      if (f.type === "enum") bits.push(`one of: ${f.domain?.join(", ")}`);
      if (f.min !== undefined) bits.push(`range ${f.min}..${f.max}`);
      if (f.provenance === "retrieved")
        bits.push(`cite the source token it came from in "${f.name}__source"`);
      return `  - ${bits.join("; ")}`;
    })
    .join("\n");

  const prompt = `You are completing ONE section of a controlled ${rubric.displayName}.
Section: ${spec.title}

Produce a JSON array of rows. Each row is an object with these fields:
${fieldSpec}

You are given a catalogue of SOURCES below, each with a quoted token like "R-014" or "4.2".
Rules:
- Use ONLY these sources. Do not invent values.
- For every field marked "retrieved", set "<field>__source" to the EXACT source token
  (e.g. "R-014") that the value came from. The token must be one listed below.
- If a value is not present in any source, set the field to "insufficient_evidence"
  and omit its __source.
- Do NOT fill computed fields; leave them null. Code calculates them.

SOURCES:
${catalogue || "(no sources retrieved)"}

Return ONLY the JSON array.`;

  let best: SectionValidation | null = null;
  for (let i = 0; i < step.bestOf; i++) {
    let produced: ProducedRow[] = [];
    try {
      const resp = await llm.invoke(prompt);
      const raw = extractJson(String(resp.content)) as Record<string, unknown>[];
      produced = (Array.isArray(raw) ? raw : []).map((row) => {
        const pr: ProducedRow = {};
        for (const f of spec.fields) {
          pr[f.name] = { value: row[f.name], sourceRef: row[`${f.name}__source`] as string | undefined };
        }
        return pr;
      });
    } catch {
      produced = [];
    }
    const v = validateSection(spec, produced, refSets, validSourceRefs);
    if (!best || defectScore(v) < defectScore(best)) best = v;
    if (best && defectScore(best) === 0) break; // clean - stop early
  }

  return { sectionId: step.sectionId, validation: best ?? validateSection(spec, [], refSets, validSourceRefs) };
}

/**
 * The judge. One criterion at a time, one bit back. Deterministic and hybrid
 * criteria get their pattern pre-check first; a forbidden hit is an immediate
 * FAIL with no LLM call. scoreRubric aggregates - the model never sees weights.
 */
async function judge(
  step: Extract<Step, { kind: "judge" }>,
  bag: OutputBag,
  rubric: Rubric,
  trajectory?: RecordedTrajectory,
): Promise<StepOutputs["judge"]> {
  const targetIds = step.criteria.length > 0 ? new Set(step.criteria) : null;
  const criteria = rubric.criteria.filter((c) => !targetIds || targetIds.has(c.id));

  // Render the produced document as text for judging + pattern checks.
  const outputText = JSON.stringify(
    Object.fromEntries(
      Object.entries(bag).map(([k, v]) => [k, v && "validation" in v ? v.validation.rows.map((r) => r.values) : v]),
    ),
  );

  const verdicts: CriterionVerdict[] = [];

  for (const c of criteria) {
    // Deterministic / hybrid: pattern check first.
    if (c.assessmentType === "deterministic" || c.assessmentType === "hybrid") {
      const pc = checkPatterns(c, outputText);
      if (!pc.passed) {
        verdicts.push({
          id: c.id, verdict: "fail", source: c.assessmentType,
          rationale: `Pattern check failed: ${pc.hits.map((h) => h.label).join(", ")}`,
          patternHits: pc.hits,
        });
        continue; // a forbidden hit is decisive; no LLM needed
      }
      if (c.assessmentType === "deterministic") {
        verdicts.push({ id: c.id, verdict: "pass", source: "deterministic", rationale: "Patterns clean." });
        continue;
      }
    }

    // llm_judge (or hybrid that passed patterns): ask for one bit.
    const prompt = `Evaluate this output against ONE criterion. Answer strict JSON: {"verdict":"pass"|"fail","rationale":"..."}.
Criterion: ${c.criterion}
Explanation: ${c.explanation}
Output:
${outputText}
Return ONLY the JSON.`;
    try {
      const resp = await llm.invoke(prompt);
      const parsed = extractJson(String(resp.content)) as { verdict: string; rationale?: string };
      verdicts.push({
        id: c.id,
        verdict: parsed.verdict === "pass" ? "pass" : "fail",
        source: c.assessmentType === "hybrid" ? "hybrid" : "llm_judge",
        rationale: parsed.rationale ?? "",
      });
    } catch {
      verdicts.push({ id: c.id, verdict: "fail", source: "llm_judge", rationale: "Judge returned no parseable verdict; failed closed." });
    }
  }

  // Check what the run DID (the RecordedTrajectory) against what the rubric
  // REQUIRED, then hand the verdict to scoring. checkTrajectory is the policy;
  // scoreRubric makes a violation an AUTO FAIL regardless of how well the output
  // scored. Omitted trajectory -> judged on output alone (backward compatible).
  const trajectoryResult = trajectory ? checkTrajectory(rubric, trajectory) : undefined;
  const result: RubricResult = scoreRubric(rubric, verdicts, rubric.reviewThreshold, trajectoryResult);
  return { result };
}

/** The real handler set. Deterministic handlers (retrieve/query/recall/validate/human)
 * are supplied by the caller (they need services); this exposes the two LLM ones. */
export const llmHandlers: Pick<StepHandlers, "generate_section" | "judge"> = {
  generate_section: generateSection,
  judge,
};