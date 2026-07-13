// src/drafting/render-markdown.ts
//
// Render validated rows to markdown FOR READING. A faithful projection of the
// typed rows - it formats, it never edits. RPN in the table is the RPN code
// computed; a gap shows as INSUFFICIENT EVIDENCE, not blanked to look tidy. If
// this output and the stored rows ever disagree, the reviewer is reviewing
// something the validator never checked.
//
// The status header is not decoration. A rendered document looks final; this
// makes it impossible to mistake a draft for an approved record - the watermark,
// the rubric verdict, the coverage, and the correlation id linking back to
// custody are all on the page.

import type { SectionSpec } from "./section-schema.js";
import type { ValidatedRow } from "./section-validator.js";
import { INSUFFICIENT_EVIDENCE } from "./section-validator.js";
import type { RubricResult } from "./scoring.js";

export interface RenderInput {
  displayName: string;
  section: SectionSpec;
  rows: ValidatedRow[];
  status: string; // pending_review | approved | rejected
  correlationId: string;
  rubricResult?: RubricResult | null;
  annotations?: { gapCount?: number; hasErrors?: boolean } | null;
}

function cell(value: unknown): string {
  if (value === INSUFFICIENT_EVIDENCE) return "**INSUFFICIENT EVIDENCE**";
  if (value === null || value === undefined) return "";
  return String(value).replace(/\|/g, "\\|");
}

export function renderMarkdown(input: RenderInput): string {
  const L: string[] = [];

  // --- Status banner ---
  const banner =
    input.status === "approved" ? "APPROVED" :
    input.status === "rejected" ? "REJECTED" :
    "DRAFT — REVIEW REQUIRED";
  L.push(`> **${banner}**`);
  L.push(`>`);
  L.push(`> ${input.displayName}`);
  L.push(`> Custody: \`${input.correlationId}\``);
  L.push("");

  // --- Rubric verdict, if judged ---
  if (input.rubricResult) {
    const r = input.rubricResult;
    L.push(`## Evaluation`);
    L.push("");
    L.push(`- Score: **${(r.score * 100).toFixed(1)}%**`);
    L.push(`- Gate: **${r.gatePassed ? "PASSED" : "FAILED"}**`);
    L.push(`- Outcome: **${r.approved ? "APPROVED" : "REVIEW REQUIRED"}**`);
    if (r.criticalFailures.length) L.push(`- Critical failures: ${r.criticalFailures.join(", ")}`);
    const fails = r.perCriterion.filter((c) => c.verdict === "fail");
    if (fails.length) {
      L.push(``);
      L.push(`Failed criteria:`);
      for (const f of fails) L.push(`- **${f.id}**: ${f.rationale}`);
    }
    L.push("");
  }

  // --- The section as a table ---
  L.push(`## ${input.section.title}`);
  L.push("");
  const fields = input.section.fields.map((f) => f.name);
  L.push(`| ${fields.join(" | ")} |`);
  L.push(`| ${fields.map(() => "---").join(" | ")} |`);
  for (const row of input.rows) {
    L.push(`| ${fields.map((f) => cell(row.values[f])).join(" | ")} |`);
  }
  L.push("");

  // --- Coverage ---
  const gaps = input.rows.reduce((n, r) => n + r.gaps.length, 0);
  if (gaps > 0) {
    L.push(`> ${gaps} field(s) marked insufficient evidence. This section is INCOMPLETE and requires review.`);
    L.push("");
  }

  return L.join("\n");
}