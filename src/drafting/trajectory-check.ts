// src/drafting/trajectory-check.ts
//
// Did the agent actually DO what the rubric required, to earn this document?
//
// Every criterion in a rubric judges the OUTPUT. That leaves one failure they
// are all structurally blind to: a document can be fluent, well-formed, cite
// clause numbers and pass every criterion, while having been built on nothing.
// The output cannot testify about how it was made. Only the trajectory can.
//
// So this checks the RECORDED trajectory of the run - which document types were
// retrieved, which agents were called - against what the rubric demanded.
//
// A miss is an AUTO FAIL, deliberately not weighted. A document produced
// without consulting the governing procedure is not a slightly worse document;
// it is an unsourced one, and there is no score elsewhere that earns that back.
// Weighing it would let a model write its way out of not having looked.
//
// FAILS CLOSED on an unknown trajectory: if we cannot establish what the run
// did, we cannot establish that it did what was required. "No evidence it
// happened" is not "evidence it happened".

import type { Rubric, TrajectoryRule } from "./rubric-schema.js";

/** What a run actually did, as recorded. Assembled from the run trace. */
export interface RecordedTrajectory {
  /** Document types retrieved from the corpus during the run. */
  documentTypes: string[];
  /** Agents called, and what they were asked. */
  agentCalls: { agent: string; query: string }[];
  /** False when the run's trajectory could not be established at all. */
  known: boolean;
}

export interface TrajectoryFinding {
  ruleId: string;
  kind: "document" | "agent";
  /** "required" - it was demanded and missing. "forbidden" - it was banned and present. */
  violation: "required_missing" | "forbidden_present" | "unknown";
  detail: string;
  reason: string;
}

export interface TrajectoryResult {
  /** False if ANY required rule is unmet or ANY forbidden rule is hit. */
  passed: boolean;
  findings: TrajectoryFinding[];
  /** True when the trajectory could not be established, so `passed` is false
   *  for want of evidence rather than because of a proven violation. The
   *  distinction matters to whoever reads the report. */
  unknown: boolean;
}

/** Normalise for comparison: types and agent names are identifiers, not prose. */
const norm = (s: string) => s.trim().toLowerCase();

function describe(rule: TrajectoryRule): string {
  return rule.kind === "document"
    ? `document of type '${rule.documentType}'`
    : `a call to agent '${rule.agent}' asking "${rule.query}"`;
}

function satisfied(rule: TrajectoryRule, actual: RecordedTrajectory): boolean {
  if (rule.kind === "document") {
    return actual.documentTypes.some((t) => norm(t) === norm(rule.documentType));
  }
  // An agent rule is satisfied by a call to that agent. The query is matched
  // loosely - the point is that the agent was ASKED about this, and an exact
  // string match would fail the moment the recipe rephrased the question by a
  // word. Loose here is deliberate: the strict half is that the agent must
  // have been called at all, which is what distinguishes asking from inventing.
  return actual.agentCalls.some(
    (c) => norm(c.agent) === norm(rule.agent) && overlaps(c.query, rule.query),
  );
}

/** Do two queries plausibly ask the same thing? Token overlap, not equality. */
function overlaps(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      norm(s)
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const wa = words(a);
  const wb = words(b);
  if (wb.size === 0) return true;
  let hit = 0;
  for (const w of wb) if (wa.has(w)) hit++;
  // Most of the required query's significant words must appear. Chosen to
  // tolerate rephrasing while still refusing an unrelated question.
  return hit / wb.size >= 0.6;
}

/**
 * Check a run's recorded trajectory against a rubric's requirements.
 *
 * Pure: takes what the rubric demanded and what the run did, returns findings.
 * It does not read the database - the caller assembles the RecordedTrajectory,
 * which keeps this testable and keeps the policy in one readable place.
 */
export function checkTrajectory(rubric: Rubric, actual: RecordedTrajectory): TrajectoryResult {
  const findings: TrajectoryFinding[] = [];
  const t = rubric.trajectory;

  // Unknown trajectory: fail closed. Report it as its own state rather than
  // silently listing every required rule as violated - "we did not look" and
  // "it did not happen" are different findings and lead to different fixes.
  if (!actual.known) {
    return {
      passed: false,
      unknown: true,
      findings: (t?.required ?? []).map((r) => ({
        ruleId: r.id,
        kind: r.kind,
        violation: "unknown" as const,
        detail: `Could not establish whether ${describe(r)} happened; no trajectory was recorded for this run.`,
        reason: r.reason,
      })),
    };
  }

  for (const rule of t?.required ?? []) {
    if (!satisfied(rule, actual)) {
      findings.push({
        ruleId: rule.id,
        kind: rule.kind,
        violation: "required_missing",
        detail: `Required ${describe(rule)} — not present in this run's trajectory.`,
        reason: rule.reason,
      });
    }
  }

  for (const rule of t?.forbidden ?? []) {
    if (satisfied(rule, actual)) {
      findings.push({
        ruleId: rule.id,
        kind: rule.kind,
        violation: "forbidden_present",
        detail: `Forbidden ${describe(rule)} — present in this run's trajectory.`,
        reason: rule.reason,
      });
    }
  }

  return { passed: findings.length === 0, unknown: false, findings };
}

/** A compact report for the reviewer and the logs. */
export function renderTrajectory(result: TrajectoryResult): string {
  if (result.passed) return "Trajectory: OK (every required source consulted, no forbidden source used).";
  const head = result.unknown
    ? "Trajectory: UNKNOWN — AUTO FAIL (no recorded trajectory; absence of evidence is not evidence)."
    : `Trajectory: FAILED — AUTO FAIL (${result.findings.length} violation(s)).`;
  return [head, ...result.findings.map((f) => `  - [${f.ruleId}] ${f.detail}\n      why it matters: ${f.reason}`)].join("\n");
}
