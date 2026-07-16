# 06 · Rubrics — and why a single score is a lie

A rubric declares what "good" means for a document type. It is the *standard*, so
it must be governed like one — and measured like one.

---

## 1. The unified weighted-binary model

`src/drafting/rubric-schema.ts`, `src/drafting/scoring.ts`

One flat list of criteria. Every criterion:

```jsonc
{
  "id": "no_fabricated_failure_modes",
  "criterion": "Every failure mode traces to a risk register entry or SOP section",
  "explanation": "Why this matters, shown to the judge",
  "weight": 25,
  "primary": true,
  "assessmentType": "hybrid",          // llm_judge | deterministic | hybrid
  "gate": "critical",                  // critical | major | minor | advisory
  "scope": "failure_modes",
  "forbiddenPatterns": [{ "pattern": "\\bwas EAR99\\b", "label": "asserted prior status" }]
}
```

### The model returns ONE BIT. Code aggregates.

The judge never sees the weights and never computes the score.

**Why:** if the model computes the score, the score is a model output subject to
model variance, and the gate stops being a control.

### Deterministic patterns are checked FIRST

A `forbiddenPatterns` hit is **decisive and skips the LLM entirely**.

Corollary worth acting on: **a deterministic criterion has zero variance.** Moving
a criterion from `llm_judge` → `hybrid` with a pattern pre-check is the *cure* for
an unstable criterion (§3).

### Two failure responses

| Failure | Response |
|---|---|
| `critical` gate fails | **BLOCKED**, regardless of score |
| score < `reviewThreshold` | **routed to a human, reason named** |

---

## 2. Draft vs committed — git is the gate

|  | Committed | Drafts |
|---|---|---|
| lives in | `rubrics/*.json`, git, hashed | `rubric_drafts` table |
| governs evaluations | **yes** | **never** |
| API can write | **no — read only** | yes (`rubric:edit`) |
| promotion | git PR review | — |

**This eliminates the laundering risk rather than mitigating it.** If the API
cannot mutate a committed rubric, a rubric that already judged an approved
document cannot change underneath it. The evaluation pipeline *physically cannot*
load a draft — it reads `rubrics/*.json` only.

Export refuses invalid drafts, so **git only ever receives schema-valid rubrics**.

Because the design removed the danger, the append-versioning + custody-events-for-
rubric-edits machinery originally proposed was **dropped as unnecessary**. Don't
re-add it without a reason.

### Validation is the floor, not the ceiling

`rubric-validate.ts`: schema parse, weights sum, duplicate ids, regex compile,
**alias collision against the committed set** (excluding same-type, so
re-versioning doesn't self-collide).

That's "well-formed". It is **not** "good". Good is §3.

---

## 3. The k-sampling instrument — the honest core

`src/drafting/rubric-stats.ts`, `src/drafting/batch-runner.ts`

### The observation that drove all of this

**The same LLM has ~40% run-to-run variance on a rubric list with identical
inputs.**

Therefore: **a single PASS/FAIL is not a measurement.** It's one draw from a
distribution. Every consequence below follows from that one fact.

### What a batch reports

```ts
perCriterion: [{
  id, gate, weight,
  passCount, runCount,      // "12/20"
  rate,                     // 0.60
  ci: { low, high, center }, // Wilson score interval
  stability: "stable_pass" | "stable_fail" | "unstable",
  coinFlip: boolean         // CI straddles 0.5 -> the model CANNOT decide
}],
score: { mean, min, max, stddev, values: [] },  // a DISTRIBUTION, not a number
gatePassRate: number
```

**Wilson score interval**, not normal approximation — it's the right CI for a
binomial proportion at small n and stays well-behaved near 0 and 1, where the
normal approximation produces impossible bounds.

**`coinFlip` is the key output.** If a criterion's CI straddles 0.5, the model
genuinely cannot decide → **the wording is ambiguous**. That's the most useful
signal for *improving* a rubric, and it only exists because we measure the
distribution instead of a point.

**The score is a distribution.** Reporting "84.6%" hides that it ranged 78–91.

**`gatePassRate`** — a gate that passes 6/10 runs means *approvability itself* is
a coin-flip.

### Comparison is deliberately conservative

```ts
likelySignal = ci_a.high < ci_b.low || ci_b.high < ci_a.low;  // disjoint CIs only
underpowered = k < 5;
```

A change counts as signal **only when the CIs are disjoint**. Overlapping CIs can
hide a real difference — we bias toward "run more" over **false confidence**,
because false confidence is the exact failure this whole system exists to prevent.

### Calibration discovered during the build — keep this

- At **k=10** you need **9/10** to call a criterion decisively stable.
  8/10 has CI `[0.49, 0.94]` — it still touches 0.5.
- At **k=20** you need **15/20**.

If that feels strict, that's the point: with 40% variance, anything looser is
noise wearing a number.

---

## 4. Two loops

|  | Inner loop (**built**) | Outer loop (**not built**) |
|---|---|---|
| what | steer one document, many iterations | backtest the whole approved/rejected corpus |
| cost | fast (k × 1) | slow (k × N) |
| proves | "my edit does what I think" | "this rubric agrees with reviewers" |

**"Better" means AGREES WITH REVIEWERS more often — not "scores higher".** A
rubric that gives everything 100% is worthless. You aren't measuring the document;
you're measuring **the rubric's judgement against ground truth**, and your QMS
history (approved *and rejected* documents) is that labelled dataset.

**Do now or the outer loop is impossible later: start retaining rejected drafts.**
You cannot backtest against data you threw away — and false-approvals (a bad
document passing) are the dangerous direction.

---

## Try it

```bash
npm run smoke:scoring     # aggregation, gates, pattern pre-checks
npm run smoke:rubric-api  # draft/committed split, validation, alias collisions
npm run smoke:batch       # the variance instrument, seeded mock judge
```

**Experiment:** word a criterion ambiguously ("the document should be
appropriate"), run a batch at k=20, watch it flag **COIN-FLIP**. Then tighten the
wording and watch the CI collapse toward 0 or 1. That loop *is* the tool.
