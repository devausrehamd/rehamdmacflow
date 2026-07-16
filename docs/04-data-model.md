# 04 · Data model — every table and why it exists

Sixteen tables in `src/db/schema.ts`. Each one is here because something *must*
survive a process restart, or must be *provable* later. If a table can't justify
one of those, it shouldn't exist.

Migrations: `drizzle/NNNN_name.sql` + an entry in `drizzle/meta/_journal.json`
(idx increment). Currently through **0010**. Run with **`npm run db:migrate`**
(not `migrate`).

---

## Identity & audit

| Table | Why it exists |
|---|---|
| `users` | Agent-local user records for role-based route guards. **Bypassed in `QMS_IDENTITY_MODE=http`** — the ID Server owns identity there and the Agent trusts the token. Still used in local mode. |
| `audit_log` | General request/action logging. Distinct from custody: this is operational, custody is evidentiary. |

## The corpus

| Table | Why it exists |
|---|---|
| `table_registry` | The schema of every ingested table: columns, inferred types, tier semantics (`value_domain`, `value_range`), `access_labels`, and the UUID that becomes the physical table name. **This is the planner's source of truth** — SQL barriers 1 and 3 depend on it. |
| `document_sections` | The structural map from heading-aware chunking: `section_id`, `parent_section_id`, `level`, `section_number`, `heading_path`, `order_index`. PK is `(document_key, section_id)`. Indexed by parent, number, and source. **Exists to make structural retrieval possible** — see the honest note in [03-retrieval.md](03-retrieval.md): nothing reads it yet. |
| `live_source_registry` | Descriptor-driven external sources, same registry pattern. |
| *(one table per ingested spreadsheet)* | Created dynamically. A risk register is a real table so "how many are open" is `count(*)`, not a similarity search. |

## Drafting

| Table | Why it exists |
|---|---|
| `draft_sets` | One generation run: `document_type`, `subject`, `rubric_version`, `rubric_hash`, `status` (`pending_review` → `approved`/`rejected`/`regenerating`), `disposition`, `disposition_reason`. The rubric **hash** is here so an auditor knows *which standard* judged it. |
| `draft_documents` | **The canonical artifact.** See below — the column types are the whole design. |
| `drafts`, `decisions`, `lessons` | Earlier-generation tables from the original agent loop. |
| `review_rounds`, `issue_items` | Review iteration structure. |

### `draft_documents` — why `rows` is `jsonb` and not `text`

This is the single most consequential column choice in the schema.

```ts
section_id:        varchar(64),
rows:              jsonb("rows"),          // THE canonical artifact: ValidatedRow[]
content:           text("content"),        // nullable — a derived markdown CACHE
correlation_id:    varchar(64),            // links to the custody chain
criterion_results: jsonb("criterion_results"),  // score, gate, per-criterion verdicts
annotations:       jsonb("annotations"),   // rowCount, gapCount, findings
```

**`rows` holds the validated typed rows — not markdown.** The rows are what the
validator checked, what custody hash-bound, and what the reviewer's approval
attaches to. Markdown/docx/xlsx are **faithful projections** of the rows.

Store markdown instead and you force a lossy serialise at persist time, and every
renderer has to re-parse a string. Verified: `rpn` round-trips as a typed `108`,
not `"108"`.

```
validated rows  ──┬─► markdown  (read-only projection)
   (the record)   └─► docx/xlsx (renderer agent — not built)
```

`content` is nullable because it is a **cache**, always regenerable from `rows`.
If they ever disagree, `rows` wins.

**`criterion_results` is one jsonb**, replacing an earlier `objective_scores` /
`expert_results` split (migration 0008 retired those). The unified criteria model
has one flat list and one result shape.

## Custody

| Table | Why it exists |
|---|---|
| `custody_events` | The append-only hash chain. Each row: `correlation_id`, `run_id`, `domain`, `event_type`, `seq`, `prev_hash`, `entry_hash`, `payload`. An advisory lock serialises appends per domain. **Payload is references only, never content** — see [07](07-custody-provenance.md). |
| `custody_anchors` | Ed25519 head anchoring, so the chain can be proven un-rewound. |

## Rubric authoring

| Table | Why it exists |
|---|---|
| `rubric_drafts` | **Staging only.** Per-author mutable rubric drafts. The evaluation pipeline *physically cannot load these* — it reads `rubrics/*.json` only. Git is the promotion gate, not this table. See [06](06-rubrics.md). |
| `rubric_draft_batches` | k-sampling results: `draft_id`, `document_ref`, `k`, `stats` (jsonb). Exists because **a single judge run has ~40% variance**, so a criterion's behaviour is a *distribution*, and steering a rubric needs the trajectory across batches. |

⚠️ **Known gap:** `runBatch` computes the raw per-run verdicts
(`CriterionVerdict[][]`) and the endpoint persists only the aggregated `stats`.
The individual runs are discarded — so a batch can't be re-inspected at the
run level. Cheap to fix; see [07](07-custody-provenance.md) §"What isn't stored".

---

## What is deliberately NOT a table

**The executor's output bag.** Intermediate step outputs (retrieved section text,
the rows the model saw, the prompts) live in memory and vanish. Only the
*validated section* persists, at the `require_human` halt.

This is a real trade-off, not an oversight — see [07](07-custody-provenance.md)
§"What isn't stored", where the audit consequence is spelled out honestly. Short
version: custody proves *what happened* but cannot *reproduce* it, and the only
place the model's actual inputs exist is Langfuse, which is outside the chain.
