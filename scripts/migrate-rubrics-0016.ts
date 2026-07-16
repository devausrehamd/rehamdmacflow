// scripts/migrate-rubrics-0016.ts
//
// One-shot migration of the committed rubrics to the new format:
//   - every criterion rewritten as "PASS if <condition>. FAIL otherwise."
//   - trajectory.requiredSources (path fragments) -> trajectory.required
//     (document-type rules), which is what the checker now enforces as an
//     auto-fail
//   - reviewThreshold left exactly as authored (it was already the % pass mark)
//
// The rewrites preserve each rule's MEANING - they restate the existing
// intent in the mandated shape, they do not change what passes. This is data,
// not code: it edits rubrics/*.json in place. Safe to re-run.
//
// Run: npx tsx scripts/migrate-rubrics-0016.ts

import { readFileSync, writeFileSync } from "node:fs";

type Crit = Record<string, unknown> & { id: string; criterion: string };

/** New criterion text, keyed by rubric file + criterion id. Each is a faithful
 *  PASS-if restatement of the original rule. */
const REWRITES: Record<string, Record<string, string>> = {
  "capa.json": {
    no_fabricated_citations:
      "PASS if every regulatory clause, standard, and procedure cited in the output appears in the retrieved sources. FAIL otherwise.",
    root_cause_substantive:
      "PASS if the output contains a root-cause analysis section that gives genuine analysis rather than restating the problem. FAIL otherwise.",
    no_unsupported_numbers:
      "PASS if every specific figure, count, and measurement in the output traces to the retrieved data or SQL results. FAIL otherwise.",
    completeness:
      "PASS if the output contains all required CAPA sections: problem statement, root-cause analysis, corrective action, preventive action, and verification plan. FAIL otherwise.",
    grounding:
      "PASS if every factual claim in the output is supported by the retrieved sources and the exact data provided. FAIL otherwise.",
    clarity:
      "PASS if the output is written clearly and unambiguously, appropriate for a controlled quality document. FAIL otherwise.",
    citations:
      "PASS if the output references procedures, records, and data using correct identifiers. FAIL otherwise.",
  },
  "dfmea.json": {
    no_fabricated_failure_modes:
      "PASS if every failure mode in the output traces to a retrieved source: a design document, a recorded defect, or a prior analysis. FAIL otherwise.",
    severity_scale_correct:
      "PASS if every severity, occurrence, and detection rating in the output uses the scales defined in the governing procedure. FAIL otherwise.",
    no_unsupported_numbers:
      "PASS if every RPN, rating, and count in the output traces to the retrieved data or SQL results. FAIL otherwise.",
    completeness:
      "PASS if every analysed item has function, failure mode, effect, cause, current controls, and ratings. FAIL otherwise.",
    grounding:
      "PASS if every failure mode and effect in the output is supported by the retrieved design and defect sources. FAIL otherwise.",
    actions:
      "PASS if every item above the action threshold carries a recommended action with a named owner. FAIL otherwise.",
    clarity:
      "PASS if the output is written unambiguously, appropriate for a controlled quality document. FAIL otherwise.",
  },
  "risk-register.json": {
    unique_identifiers:
      "PASS if every risk in the output has a unique identifier with no duplicates. FAIL otherwise.",
    no_unsupported_numbers:
      "PASS if every score, likelihood, and impact in the output traces to the retrieved data or SQL results. FAIL otherwise.",
    completeness:
      "PASS if every risk has title, description, subsystem, owner, likelihood, impact, score, and status. FAIL otherwise.",
    grounding: "PASS if every risk in the output is supported by the retrieved sources. FAIL otherwise.",
    clarity: "PASS if the output is written unambiguously. FAIL otherwise.",
  },
};

/** Old path-fragment sources -> document-type trajectory rules. The procedures
 *  are their own document types in the corpus, so the requirement becomes
 *  "a document of this type must have been retrieved". */
const TRAJECTORY: Record<string, { kind: "document"; id: string; documentType: string; reason: string }[]> = {
  "capa.json": [
    {
      kind: "document",
      id: "capa_procedure",
      documentType: "capa-procedure",
      reason: "A CAPA must be grounded in the controlled CAPA procedure; producing one without consulting it means the process was never followed.",
    },
  ],
  "dfmea.json": [
    {
      kind: "document",
      id: "fmea_procedure",
      documentType: "fmea-procedure",
      reason: "A DFMEA's rating scales are defined by the controlled FMEA procedure; without it the ratings have no authority.",
    },
  ],
  "risk-register.json": [
    {
      kind: "document",
      id: "risk_procedure",
      documentType: "risk-management-procedure",
      reason: "A risk register's scoring scales are defined by the controlled risk-management procedure; without it the scores are ungoverned.",
    },
  ],
};

for (const file of Object.keys(REWRITES)) {
  const path = `rubrics/${file}`;
  const rubric = JSON.parse(readFileSync(path, "utf8")) as {
    criteria: Crit[];
    trajectory?: Record<string, unknown>;
    [k: string]: unknown;
  };

  const rewrites = REWRITES[file]!;
  for (const c of rubric.criteria) {
    const next = rewrites[c.id];
    if (!next) throw new Error(`${file}: no rewrite provided for criterion '${c.id}' - refusing to leave it in the old format.`);
    c.criterion = next;
  }

  rubric.trajectory = {
    description: (rubric.trajectory?.description as string) ?? "",
    required: TRAJECTORY[file] ?? [],
    forbidden: [],
  };

  writeFileSync(path, JSON.stringify(rubric, null, 2) + "\n", "utf8");
  console.log(`  migrated ${file}: ${rubric.criteria.length} criteria + ${(TRAJECTORY[file] ?? []).length} trajectory rule(s)`);
}

console.log("Done. Rubrics are in the new format.");
