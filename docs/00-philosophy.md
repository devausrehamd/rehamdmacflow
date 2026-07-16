# 00 · Philosophy — the one idea

> **"The LLM is the seamstress; we cut all the clothing panels beforehand."**

Every panel — structure, field types, value ranges, which sources may be cited,
what "complete" means — is cut by deterministic code **before** the model touches
anything. The model sews. It does not design the garment.

If you read nothing else, read this. Most of the code looks over-engineered until
you see what it is defending against.

---

## The claim being tested

> Can a small local model (Qwen 2.5 7B) produce regulated documents whose errors
> are **structurally caught** rather than shipped, with an audit trail that
> **outlives the agent** that produced it?

The answer so far is yes — *provided the model is confined to a very small
surface*. That confinement is the architecture.

## Three corollaries that settle most arguments

**1. Structure is DECLARED, never inferred.**
A DFMEA's sections and fields are transcribed from the SOP into a config file.
They are never semantically searched for, never guessed. Only *content* is
retrieved.

**2. The LLM produces bits and grounded text. Code does everything else.**
Aggregation, scoring, gating, arithmetic, validation — all deterministic.

**3. n document types = n config files, 0 chunkers.**
Adding a document type is authoring a rubric, not writing code.

## Where the LLM is actually allowed to act

Exactly **two** of seven step kinds (`src/drafting/handlers.ts`):

| Step | What the model may do | What it may not do |
|---|---|---|
| `generate_section` | fill the *declared* fields of *one* section from an offered citation catalogue | invent fields, decide structure, compute computed fields, cite a source it wasn't offered |
| `judge` | return **one bit** (PASS/FAIL + rationale) per criterion | see the weights, compute the score, decide the gate |

The other five (`retrieve_sections`, `query_table`, `recall_prior`,
`validate_section`, `require_human`) contain no model at all.

## Why this is testable without an LLM

Because the model is confined to two handlers, **everything else can be tested
with stubs**. `npm run smoke:executor` runs the entire recipe interpreter —
ordering, output threading, gap propagation, gate blocking, custody emission —
with no Ollama and no model. That's not a testing convenience; it's the proof that
the deterministic layer is genuinely deterministic.

If a new feature can't be tested without the model, ask whether it belongs on the
model's side of the line at all.

## The two failure responses, deliberately different

| Failure | Response | Why |
|---|---|---|
| Fabrication (critical gate) | **BLOCKED** regardless of score | a made-up value is never acceptable |
| Incompleteness (score < threshold) | **routed to a human, reason named** | a person decides; the system doesn't guess |

A real run: score **84.6%** (threshold 85%), gate **PASSED**, outcome **REVIEW
REQUIRED** — because a legitimate criterion (`actions`) failed. Nothing was
fabricated; the document was genuinely incomplete; a human was told exactly why.
That is the system working.

## The principle that keeps being right

**When a detector fires, fix the cause — don't silence the detector.**

The first real end-to-end run produced 8 `ungrounded_retrieved` errors. The
temptation was to relax the check. The actual cause was that the handler offered
the model no citable tokens — the values were correct but genuinely had no
provenance. The fix made grounding **real** (a citation catalogue) *and* made the
check **stricter** (a source is valid only if it's a member of the offered set).
Errors went 8 → 0 and the anti-fabrication criterion flipped FAIL → PASS.

Loosening the detector would have produced the same green result and a lie.

## What "honest" means here

The system is built to **refuse false confidence**:

- A missing value is `insufficient_evidence` — a **gap**, not an invention.
  best-of-N retries exist to reduce *avoidable errors*, never to pressure the
  model into inventing a rating.
- A rubric score is a **distribution**, not a number — the same 7B has ~40%
  run-to-run variance on the same input.
- A criterion whose pass-rate confidence interval straddles 0.5 is flagged
  **COIN-FLIP**: the model can't decide, so the *wording* is the defect.
- A comparison between two rubric versions is only "signal" when the confidence
  intervals are **disjoint**. Otherwise the tool says "run more" rather than let
  you chase noise.

Read [06-rubrics.md](06-rubrics.md) for why that matters more than it sounds.
