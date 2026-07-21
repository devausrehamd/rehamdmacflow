# 10 · Answering — the deterministic/LLM boundary

Retrieval ([03](03-retrieval.md)) finds the evidence. This is what happens next:
how a question becomes an answer. The one rule, which is just [the
philosophy](00-philosophy.md) applied to answering:

> **The LLM translates; the deterministic engine decides.** When the data settles
> a question, no model phrases the result. When a term needs interpreting, the
> model may propose a decoding — but it is checked against the schema, and it
> answers in the evaluator's vocabulary (`score >= 16`), never with a bare
> assertion ("there are 5"). A term it cannot ground is **called out, not
> guessed.**

This exists because the alternative failed in front of us. Asked "how many Critical
risks are there," an LLM answer node confidently said *5* — from a query that
matched nothing, because the register has no "Critical" field and the planner had
guessed an impossible filter. The model papered over a broken query with a
plausible number. Everything below is the machinery that stops that.

## The ask graph

```
understand → retrieve → sql_retrieve ─┬─► grounding_notice ─► finalize   (call it out)
                                      ├─► direct_answer     ─► finalize   (deterministic)
                                      └─► draft → reconcile ─► finalize   (LLM synthesis)
```

`src/agent/graph.ts` routes after `sql_retrieve` with `routeAfterSql`. The three
exits, in priority order, are the whole story.

## 1. The planner decodes — into the evaluator's vocabulary

`sql_retrieve` ([03](03-retrieval.md) §1) asks the LLM planner to turn the question
into a structured `QueryRequest` — real columns, real ops, concrete values. The
planner is the **only** place a natural-language term becomes a predicate. Two
things keep it honest.

**Defined terms are injected, not guessed.** `derivations/` is a git-tracked,
versioned registry — the same kind of place [rubrics](06-rubrics.md) live — where
the QMS *defines* an interpretive term in the evaluator's vocabulary:

```json
{ "term": "critical", "aliases": ["most severe", "showstopper"],
  "predicate": { "column": "score", "op": "gte", "value": 16 },
  "definition": "a risk with a score of 16 or higher" }
```

The register has no severity column — "critical" is a convention on the computed
`score`. So the definition is the QMS's, not the model's. When a question uses a
defined term, its definition is injected into the planner prompt as the exact
filter to reproduce (`src/agent/derivations.ts`, `sql-planner.ts`
`buildPlanPrompt`). "How many Critical risks" now plans `score >= 16` **every
time**, not a different guess per run.

**Undefined interpretive terms are abstained on, not invented.** We cannot
enumerate every adjective, so the model — the only thing that understands language
— must self-report when it is guessing. The planner returns `{query, unresolved}`;
its contract says a severity/priority/size/recency word that is neither a defined
term nor a value on a column must **not** get an invented filter — it goes in
`unresolved` instead. `parsePlanResponse` reads that contract but tolerantly
accepts a bare query too, so a model that ignores the wrapper never regresses the
common case — it just offers no abstentions.

## 2. The grounding gate — validate before executing

`src/agent/grounding.ts`. Before a planned query runs, every filter value is
checked against its column's `value_domain` (equality/`in`) and `value_range`
(comparisons). The distinction is the point:

| Filter | Verdict | Because |
|---|---|---|
| `likelihood = 5` | **ungrounded** | likelihood's domain is 1–4 — the value can never match, so the *term wasn't decoded*, it was guessed |
| `status = 'Open'` | grounded | 'Open' is a real value; the result may be empty, but **empty is a real answer** |
| `score >= 16` | grounded | within range |

An ungrounded filter is a **decode failure**, not a "0 results" answer. Executing
it would report a confident, wrong number. So the gate refuses to run it and
records the failure instead. This is fully deterministic — no model decides
whether something is grounded.

## 3. Call it out — `grounding_notice`

When the query is ungrounded *or* the planner abstained, the graph does not answer
around the gap. `composeGroundingNotice` states plainly what could not be mapped,
lists the fields that *can* be queried with their domains, names the terms the QMS
*does* define, and asks for a grounded rephrase — deterministically, so it cannot
invent a value:

```
I couldn't map part of your question to a defined field or term, so I won't guess a number.
- "trivial" is a judgment term the QMS hasn't defined for the "Risk Register" — …
Defined terms you can use here: critical, high or above.
Fields you can query in the "Risk Register":  - Score: 2–20  - Status: Open, Closed  …
```

Three failure modes for an interpretive term, all handled honestly: **defined** →
resolved (registry), **impossible** → called out (gate), **undefined-but-plausible**
→ called out (abstain). The system never invents a number for a term the QMS
hasn't defined.

## 4. The short-circuit — `direct_answer`, no LLM

`src/agent/compose-exact.ts`. When a question is quantitative ("how many", "number
of", "total") and every SQL result is a scalar aggregate, **the number is the
answer** — composing it needs no model:

- **one result** → `There are 5 matching records in the "Risk Register". Citation: [Source: …/Risk_Register.xlsx]`
- **a cross-reference** → a per-source breakdown plus a combined total for additive
  aggregates. "How many open items in the Risk Register **and** the Issues List
  that are High or above" becomes one filtered count per table, summed here,
  transparently, with each source shown.

Gating is careful: "how many … **and what are they**" needs prose and stays on the
LLM path, and a table named "Issues **List**" is not mistaken for a request to
enumerate. When the exact data does not settle the question, `composeExactAnswer`
returns `null` and the graph falls through to the LLM path. This deletes, at the
root, the class of failures where a model wrapped a definite figure in a
placeholder — a count answer is now fast, reproducible, and unit-testable.

## 5. The LLM path — `draft → reconcile`, grounded synthesis

Everything else — a qualitative or open question, or one with no conclusive exact
data — is answered by the LLM, over the retrieved evidence, in the per-tier
`draft` + `reconcile` nodes ([03](03-retrieval.md), [05](05-drafting.md) share the
machinery). This is where prose belongs: "summarise the open risks and their
owners", "how was the EMC failure fixed". Even here the exact data is authoritative
(the partial prompt states SQL results as definitive), and deterministic nets scrub
the output — a placeholder citation is replaced with the sources actually
retrieved, a bare `[Source 5]` is expanded to `[Source 5: path]`, and a leaked
value placeholder or note-to-self is stripped in favour of the grounded partial
(`src/agent/prompts.ts`, `reconcile.ts`).

## Why this shape

The seam is deliberate: **the deterministic layer owns "can this be grounded?"**
For a count it grounds a predicate; for a summary it grounds the *record set* and
lets the model synthesise only over retrieved, cited rows; for an undefined term it
calls out rather than confabulate. The LLM is never the source of a fact — only of
language, and of proposed decodings that are re-checked before they count.

## Try it

```bash
npm run smoke:direct-answer   # exact-data short-circuit: single count + cross-reference, gating, fall-back
npm run smoke:grounding       # the gate: out-of-domain -> called out; in-domain-but-empty -> grounded
npm run smoke:derivations     # the registry: term -> definition -> exact filter, injected into the planner
npm run smoke:abstain         # the decoder contract: {query, unresolved}, tolerant parse, call-it-out
```

All four are **pure — no LLM, no infra** — which is the point: the deterministic
half of answering is verifiable without a model in the loop. Live, the whole path
is exercised by `npm run integration:orchestrator` and `integration:agent`.

**Experiment.** Add a definition to `derivations/risk-register.json` — say
`"minor"` → `score <= 4` — and watch "how many minor risks" switch from *called
out* to a deterministic count. Remove it again and it goes back to calling itself
out. The QMS owns the vocabulary; the engine owns the truth.
