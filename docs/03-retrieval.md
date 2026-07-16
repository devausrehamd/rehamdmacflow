# 03 · Retrieval

Two lanes, fused. The lanes exist because **prose and tables fail differently**,
and a single vector search over both gives you a plausible answer to a question
that needed an exact one.

```
question ──► understand (rephrasings) ──┬─► PROSE lane  : vector search, top-6 per query ──┐
                                        │                                                   ├─► RRF fuse ──► context
                                        └─► TABLE lane  : blurb hit -> SQL planner -> SQL ──┘
```

---

## 1. The two lanes

```ts
// src/agent/nodes/retrieve.ts
const PROSE_TOP_K = 6;    // per-query search depth
const FUSED_PROSE_K = 6;  // how many fused prose chunks to keep
const TABLE_TOP_K = 3;    // table-lane search depth (guaranteed included)
```

**Prose lane** — vector search over document chunks, several rephrasings of the
question, results fused.

**Table lane** — a separate, *guaranteed* slice. The blurb ([02](02-ingestion.md))
is what matches semantically; finding it triggers the SQL path, where the planner
reads the blurb's schema half and emits a `QueryRequest` → real SQL → exact rows.

The table lane is **guaranteed included** rather than left to compete with prose
on similarity score. If it competed, a question like "how many risks are open"
could lose to six chunks of prose *about* risk, and you'd get an eloquent
non-answer instead of a number.

## 2. Fusion — Reciprocal Rank Fusion

```ts
// src/agent/fusion.ts
// RRF score = sum over lists of 1 / (k + rank_in_that_list)   // k = 60
```

An item that surfaces across **several rephrasings** is more likely genuinely
relevant than one that spikes in a single list. RRF rewards that without needing
scores to be comparable between lists (they aren't).

Deliberately isolated behind `fuse()` so it can be swapped for weighted fusion or
a cross-encoder reranker **without touching the retrieve node**. Good place to
experiment.

## 3. Label filtering

Every search filters on `access_labels` — `labelsIntersect` /
`enforceLabels` ([01-security.md](01-security.md)). A chunk with no labels matches
nothing, so an unclassified document is unreachable **by construction**.

⚠️ `QMS_ENFORCE_LABELS` currently defaults **off**.

## 4. Subject scoping and enumeration

`src/data/subject.ts`, `src/data/enumerate.ts`, `registry/subjects.json`

**The bug this fixed is worth understanding.** "Across all risk registers" used to
be a top-K vector search with `TABLE_TOP_K = 3`. With four registers, you'd
silently get three. No error. A plausible, incomplete answer — the worst kind.

So collection membership is a **registry set-membership query, not a search**:

```json
"collections": {
  "risk-register": {
    "aliases": ["risk register", "risk log"],
    "schemaContract": {
      "requiredColumns": ["risk_id", "subsystem", "owner", "status", "score"],
      "reason": "A cross-project aggregate unions members. A member missing a contract column cannot be unioned and is excluded and reported, not silently coerced."
    }
  }
}
```

Two decisions in that file:

**Alias matching is exact on word boundaries, never fuzzy.** Binding a risk
register to the wrong project doesn't fail loudly — it silently satisfies the
wrong prerequisite and pollutes every cross-project aggregate.

**`schemaContract` makes aggregation honest.** A member missing a contract column
is **excluded and reported**, never null-filled. Same discipline as
`insufficient_evidence`.

Every enumerated answer carries a **coverage statement** naming what was included
and excluded. "Covered 4 of 4 risk-registers" is a different claim from an answer
with no denominator.

---

## 5. ⚠️ Stage 2: structural retrieval — DESIGNED, NOT BUILT

This is the biggest gap between what the code *looks* like it does and what it
does.

**What exists ([02](02-ingestion.md)):** every chunk knows its `section_id`,
`parent_section_id`, `heading_path`, and `level`. `document_sections` holds the
full structural map. `parent_section_id` is an indexed keyword in Qdrant.

**What does not exist:** any code that reads it back.

The intended design — referenced in the ingestion comments, which makes it easy to
misread as implemented:

| Intended | Why |
|---|---|
| **Expand** a matched chunk to its whole section | a chunk mid-procedure is meaningless without the procedure |
| **Roll up** to the parent when ≥3 sibling subsections hit | if 4.3.1, 4.3.2 and 4.3.4 all match, the answer is "4.3", not three fragments |

Verify for yourself:

```bash
grep -rn "parent_section_id" src/ --include=*.ts | grep -v "schema.ts\|heading-chunker\|sections-writer\|qdrant-writer\|types.ts"
# (silence — nothing consumes it)
```

**If you build it:** the expand/reduce nodes need the *same label filter* as the
base search, or expansion becomes a privilege-escalation path — you'd match a
chunk you're allowed to see and expand into a section you aren't.

## 6. ⚠️ Context-window budgeting — NOT BUILT

There is **no token-budget code anywhere**. Nothing counts tokens, trims context
to fit, or degrades gracefully when the assembled context exceeds the model's
window.

Currently the bound is implicit: `PROSE_TOP_K = 6` + `TABLE_TOP_K = 3` + declared
section text happens to fit Qwen 2.5 7B's window for the documents tested. That's
a coincidence of scale, not a guarantee.

**This will break** on a long SOP or a wide table, and it will break *silently* —
truncation at the model boundary, not an error. A real implementation would budget
tokens explicitly and report what it dropped (a coverage statement, same as
enumeration).

Good first contribution.

---

## Try it

```bash
npm run smoke:hybrid    # both lanes
npm run smoke:subject   # scoping + enumeration coverage
npm run smoke:agent     # the full graph
```

**Experiment:** set `TABLE_TOP_K = 1`, add a fourth risk register, and ask an
"across all" question. Watch enumeration catch what top-K silently missed.
