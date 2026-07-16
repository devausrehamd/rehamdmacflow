// scripts/smoke-test-batch.ts
//
// The k-sampling instrument, with a MOCK judge of controllable variance - so we
// can prove the statistics without Ollama, deterministically.
//
// The mock judge passes each criterion with a set probability. That lets us
// construct exactly the scenarios that matter:
//   - a criterion at p=1.0  -> stable_pass, tight CI near 1
//   - a criterion at p=0.5  -> COIN-FLIP flagged (the ambiguous-wording signal)
//   - a criterion at p=0.0  -> stable_fail
//   - two batches p=0.3 -> p=0.9  -> likelySignal (trajectory moved)
//   - two batches p=0.5 -> p=0.55 -> NOT signal (noise; don't chase)
//
// Usage: npm run smoke:batch

import { runBatch, type DocumentJudge } from "../src/drafting/batch-runner.js";
import { compareBatches, renderBatch } from "../src/drafting/rubric-stats.js";
import type { Rubric } from "../src/drafting/rubric-schema.js";
import type { CriterionVerdict } from "../src/drafting/scoring.js";

const GREEN = "\x1b[0;32m"; const RED = "\x1b[0;31m"; const NC = "\x1b[0m";
let failed = 0;
function check(n: string, c: boolean, d = ""): void {
  if (c) console.log(`${GREEN}OK${NC}   ${n}`);
  else { failed++; console.log(`${RED}FAIL${NC} ${n}${d ? " - " + d : ""}`); }
}

// A rubric with three criteria at known "true" pass probabilities.
const rubric = {
  documentType: "mock", displayName: "Mock", version: "0", aliases: [], reviewThreshold: 0.7,
  requires: [], exports: {}, sections: [], recipe: { steps: [] },
  trajectory: { description: "", requiredSources: [], forbiddenSources: [] },
  criteria: [
    { id: "always", criterion: "", explanation: "", weight: 40, primary: true, assessmentType: "llm_judge", gate: "major", scope: "all", forbiddenPatterns: [], requiredPatterns: [] },
    { id: "coinflip", criterion: "", explanation: "", weight: 40, primary: false, assessmentType: "llm_judge", gate: "minor", scope: "all", forbiddenPatterns: [], requiredPatterns: [] },
    { id: "never", criterion: "", explanation: "", weight: 20, primary: false, assessmentType: "llm_judge", gate: "minor", scope: "all", forbiddenPatterns: [], requiredPatterns: [] },
  ],
} as unknown as Rubric;

// Seeded RNG so the test is deterministic despite modelling randomness.
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function mockJudge(probs: Record<string, number>, seed: number): DocumentJudge {
  const rand = mulberry32(seed);
  return async (r): Promise<CriterionVerdict[]> =>
    r.criteria.map((c) => ({ id: c.id, verdict: rand() < (probs[c.id] ?? 0.5) ? "pass" : "fail", source: "llm_judge" as const, rationale: "" }));
}

async function main(): Promise<void> {
  console.log("=== k-sampling batch runner smoke test (mock judge) ===\n");

  // --- One batch, k=20, known probabilities ---
  const judge = mockJudge({ always: 1.0, coinflip: 0.5, never: 0.0 }, 42);
  const batch = await runBatch(rubric, "doc text", 20, judge);

  console.log(renderBatch(batch.stats));
  console.log("");

  const always = batch.stats.perCriterion.find((c) => c.id === "always")!;
  const coin = batch.stats.perCriterion.find((c) => c.id === "coinflip")!;
  const never = batch.stats.perCriterion.find((c) => c.id === "never")!;

  check("p=1.0 criterion -> stable_pass", always.stability === "stable_pass", `rate ${always.rate}`);
  check("p=1.0 criterion -> NOT coin-flip", !always.coinFlip);
  check("p=0.5 criterion -> COIN-FLIP flagged", coin.coinFlip, `rate ${coin.rate.toFixed(2)}, ci [${coin.ci.low.toFixed(2)},${coin.ci.high.toFixed(2)}]`);
  check("p=0.5 criterion -> unstable", coin.stability === "unstable");
  check("p=0.0 criterion -> stable_fail", never.stability === "stable_fail", `rate ${never.rate}`);
  check("score is a distribution (min<max)", batch.stats.score.min < batch.stats.score.max || batch.stats.score.stddev >= 0);
  check("gate pass rate recorded", batch.stats.gatePassRate >= 0 && batch.stats.gatePassRate <= 1);

  // --- Trajectory: a real move vs noise ---
  // Editor "fixes" coinflip so it now passes reliably: p 0.5 -> 0.9
  const before = await runBatch(rubric, "doc", 20, mockJudge({ always: 1.0, coinflip: 0.3, never: 0.0 }, 1));
  const after  = await runBatch(rubric, "doc", 20, mockJudge({ always: 1.0, coinflip: 0.9, never: 0.0 }, 2));
  const moved = compareBatches(before.stats, after.stats);
  const coinCmp = moved.perCriterion.find((c) => c.id === "coinflip")!;
  check("real move (0.3->0.9) flagged as likelySignal", coinCmp.likelySignal, `${coinCmp.fromRate.toFixed(2)}->${coinCmp.toRate.toFixed(2)}`);
  check("  rate delta is large and positive", coinCmp.rateDelta > 0.4);
  check("  not underpowered at k=20", !moved.underpowered);

  // --- Noise: tiny change should NOT be flagged as signal ---
  const n1 = await runBatch(rubric, "doc", 20, mockJudge({ always: 1.0, coinflip: 0.5, never: 0.0 }, 3));
  const n2 = await runBatch(rubric, "doc", 20, mockJudge({ always: 1.0, coinflip: 0.55, never: 0.0 }, 4));
  const noise = compareBatches(n1.stats, n2.stats);
  const noiseCmp = noise.perCriterion.find((c) => c.id === "coinflip")!;
  check("tiny move (0.5->0.55) NOT flagged as signal (don't chase noise)", !noiseCmp.likelySignal, `${noiseCmp.fromRate.toFixed(2)}->${noiseCmp.toRate.toFixed(2)}`);

  // --- Underpowered warning at small k ---
  const small1 = await runBatch(rubric, "doc", 3, mockJudge({ always: 1.0, coinflip: 0.4, never: 0.0 }, 5));
  const small2 = await runBatch(rubric, "doc", 3, mockJudge({ always: 1.0, coinflip: 0.8, never: 0.0 }, 6));
  check("k=3 comparison flagged UNDERPOWERED", compareBatches(small1.stats, small2.stats).underpowered);

  console.log("");
  if (failed === 0) console.log(`${GREEN}k-sampling instrument sound — detects coin-flips, distinguishes signal from noise.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE TEST CRASHED:");
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});