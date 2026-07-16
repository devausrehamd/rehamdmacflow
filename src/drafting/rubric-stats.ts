// src/drafting/rubric-stats.ts
//
// The honest instrument. With ~40% run-to-run variance on the same input, a
// single Pass/Fail per criterion is not a measurement - it is one draw from a
// distribution. So every criterion is scored k times and reported as a PASS
// RATE with a confidence interval, and the score itself is a distribution, not
// a point.
//
// Two things this must never do:
//   - report a rate as if it were certain (a 3/5 and a 2/5 are not different)
//   - tell the editor a trajectory moved when the move is within the noise
//
// Both are handled by the Wilson score interval - the right CI for a binomial
// proportion at small n, well-behaved near 0 and 1 where the normal
// approximation falls apart. Comparisons use CI overlap: conservative on
// purpose, because the failure mode we are preventing is FALSE CONFIDENCE.

import type { Rubric } from "./rubric-schema.js";
import { scoreRubric, type CriterionVerdict } from "./scoring.js";

export interface Interval { low: number; high: number; center: number }

/** Wilson score interval for x passes out of n runs. z=1.96 => 95%. */
export function wilson(x: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1, center: 0.5 };
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin), center };
}

export type CriterionStability = "stable_pass" | "stable_fail" | "unstable";

export interface CriterionStat {
  id: string;
  gate: string;
  weight: number;
  passCount: number;
  runCount: number;
  rate: number; // passCount / runCount
  ci: Interval;
  stability: CriterionStability;
  /** True when the CI straddles 0.5 - the model genuinely can't decide. A
   *  wording defect, and the most useful signal for improving the rubric. */
  coinFlip: boolean;
}

export interface ScoreDistribution {
  mean: number;
  min: number;
  max: number;
  stddev: number;
  values: number[]; // the k per-run scores
}

export interface BatchStats {
  k: number;
  perCriterion: CriterionStat[];
  score: ScoreDistribution;
  /** Fraction of the k runs whose gate passed. A gate that passes 6/10 is
   *  itself unstable - the document's approvability is a coin-flip. */
  gatePassRate: number;
}

function classify(x: number, n: number, ci: Interval): { stability: CriterionStability; coinFlip: boolean } {
  const coinFlip = ci.low < 0.5 && ci.high > 0.5; // CI includes a coin-flip
  const rate = n > 0 ? x / n : 0.5;
  if (coinFlip) return { stability: "unstable", coinFlip: true };
  if (rate >= 0.5) return { stability: "stable_pass", coinFlip: false };
  return { stability: "stable_fail", coinFlip: false };
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Aggregate k runs. `verdictSets` is one CriterionVerdict[] per run. Produces
 * per-criterion pass rates + CIs, and the score distribution across runs.
 */
export function aggregateBatch(rubric: Rubric, verdictSets: CriterionVerdict[][]): BatchStats {
  const k = verdictSets.length;

  // Per-criterion pass counts.
  const passCounts = new Map<string, number>();
  for (const c of rubric.criteria) passCounts.set(c.id, 0);
  for (const set of verdictSets) {
    for (const v of set) {
      if (v.verdict === "pass") passCounts.set(v.id, (passCounts.get(v.id) ?? 0) + 1);
    }
  }

  const perCriterion: CriterionStat[] = rubric.criteria.map((c) => {
    const x = passCounts.get(c.id) ?? 0;
    const ci = wilson(x, k);
    const { stability, coinFlip } = classify(x, k, ci);
    return { id: c.id, gate: c.gate, weight: c.weight, passCount: x, runCount: k, rate: k > 0 ? x / k : 0, ci, stability, coinFlip };
  });

  // Score + gate distribution: score each run.
  const scores: number[] = [];
  let gatePasses = 0;
  for (const set of verdictSets) {
    const r = scoreRubric(rubric, set);
    scores.push(r.score);
    if (r.gatePassed) gatePasses++;
  }

  return {
    k,
    perCriterion,
    score: {
      mean: scores.reduce((s, v) => s + v, 0) / (scores.length || 1),
      min: Math.min(...(scores.length ? scores : [0])),
      max: Math.max(...(scores.length ? scores : [0])),
      stddev: stddev(scores),
      values: scores,
    },
    gatePassRate: k > 0 ? gatePasses / k : 0,
  };
}

// ---------------------------------------------------------------------------
// Comparison - "did the trajectory move, or is this noise?"
// ---------------------------------------------------------------------------

export interface CriterionComparison {
  id: string;
  fromRate: number;
  toRate: number;
  rateDelta: number;
  /** True when the two CIs are DISJOINT - the difference is likely real, not
   *  noise. Conservative: overlapping CIs can still hide a real difference, but
   *  we bias toward "run more" over false confidence. */
  likelySignal: boolean;
  /** Stability change - did an unstable criterion become decisive? */
  fromStability: CriterionStability;
  toStability: CriterionStability;
  stabilised: boolean;
}

export interface BatchComparison {
  perCriterion: CriterionComparison[];
  scoreMeanDelta: number;
  /** True when the score distributions barely overlap - the aggregate moved. */
  scoreMoved: boolean;
  /** Warning when either batch's k is too small to trust the comparison. */
  underpowered: boolean;
}

function disjoint(a: Interval, b: Interval): boolean {
  return a.high < b.low || b.high < a.low;
}

/**
 * Compare an earlier batch (from) to a later one (to). Per criterion: did the
 * pass rate move beyond the noise (disjoint CIs), and did stability improve.
 */
export function compareBatches(from: BatchStats, to: BatchStats): BatchComparison {
  const byId = new Map(from.perCriterion.map((c) => [c.id, c]));
  const perCriterion: CriterionComparison[] = to.perCriterion.map((t) => {
    const f = byId.get(t.id);
    if (!f) {
      return { id: t.id, fromRate: 0, toRate: t.rate, rateDelta: t.rate, likelySignal: false, fromStability: "unstable" as const, toStability: t.stability, stabilised: false };
    }
    return {
      id: t.id,
      fromRate: f.rate,
      toRate: t.rate,
      rateDelta: t.rate - f.rate,
      likelySignal: disjoint(f.ci, t.ci),
      fromStability: f.stability,
      toStability: t.stability,
      stabilised: f.stability === "unstable" && t.stability !== "unstable",
    };
  });

  const scoreMeanDelta = to.score.mean - from.score.mean;
  // The score "moved" if the mean shift exceeds the combined run-to-run spread.
  const combinedSpread = (from.score.stddev + to.score.stddev) / 2;
  const scoreMoved = Math.abs(scoreMeanDelta) > combinedSpread;

  // Underpowered if either batch is too small to distinguish typical rates.
  // With ~40% variance, k<5 CIs are too wide to compare meaningfully.
  const underpowered = from.k < 5 || to.k < 5;

  return { perCriterion, scoreMeanDelta, scoreMoved, underpowered };
}

/** A compact text view of a batch for the editor / logs. */
export function renderBatch(stats: BatchStats): string {
  const L: string[] = [];
  L.push(`k=${stats.k} runs  |  score ${(stats.score.mean * 100).toFixed(1)}% (${(stats.score.min * 100).toFixed(0)}-${(stats.score.max * 100).toFixed(0)}%, sd ${(stats.score.stddev * 100).toFixed(1)})  |  gate passed ${(stats.gatePassRate * 100).toFixed(0)}% of runs`);
  for (const c of stats.perCriterion) {
    const bar = "#".repeat(Math.round(c.rate * 12)).padEnd(12, ".");
    const flag = c.coinFlip ? "  <- COIN-FLIP (ambiguous wording)" : "";
    const tag = c.gate === "critical" ? "[crit]" : `(${c.weight})`;
    L.push(`  ${c.id.padEnd(28)} ${tag.padEnd(7)} ${c.passCount}/${c.runCount} ${bar} [${(c.ci.low * 100).toFixed(0)}-${(c.ci.high * 100).toFixed(0)}%]${flag}`);
  }
  return L.join("\n");
}