# 02 · Ingestion

Two lanes, because prose and tables fail differently.

```
                  ┌── markdown/prose ──► heading-aware chunker ──► Qdrant (vectors)
  source docs ────┤                                            └─► Postgres (document_sections)
                  └── xlsx/tables ─────► table loader ────────► Postgres (a real table per source)
                                                             └─► Qdrant (ONE blurb chunk)
```

**No LLM anywhere in ingestion.** Everything here is deterministic and testable
(`npm run smoke:tables`, `npm run smoke:hybrid`).

---

## 1. Prose: heading-aware chunking

`src/ingestion/heading-chunker.ts`

Naive chunking slices a document every N tokens and destroys the thing a QMS
document is *made of* — its structure. §4.3.1 "Methods" means nothing without
"4 Controls > 4.3 Verification" above it.

So the chunker parses the heading hierarchy, chunks **within** the deepest
sections, and tags every chunk with its structural identity:

```ts
export interface ParsedSection {
  sectionId: string;          // sha256(documentKey + headingPath), first 32 chars
  parentSectionId: string | null;
  documentKey: string;
  level: number;              // heading depth 1-6
  sectionNumber: string | null;   // "4.3.1" if numbered
  headingText: string;        // "Design Verification"
  headingPath: string;        // "4 Controls > 4.3 Verification > 4.3.1 Methods"
  orderIndex: number;
}
```

Two decisions:

**The heading path is FACTUAL, so it's safe to embed.** It's the document's own
structure, not an interpretation. Nothing is inferred, so nothing can be inferred
*wrongly*. (Contrast: an LLM-written "summary of this section" would be an
interpretation, and embedding it would embed the interpretation's errors.)

**`sectionId` is a content hash of `documentKey + headingPath`.** Deterministic —
re-ingesting an unchanged document produces identical ids, so the structural map
and the vector payloads stay in sync without coordination.

Both outputs are written:
- **chunks** (with structural fields) → embedded → Qdrant
- **sections** (the structural map) → Postgres `document_sections`

And the Qdrant payload carries the links, indexed as keywords:

```ts
// src/ingestion/qdrant-writer.ts
{ field: "parent_section_id", schema: "keyword" },
// ...
parent_section_id: chunk.parentSectionId,   // enables adaptive rollup
```

### ⚠️ What this enables but does NOT do yet

The data model is fully prepared for **structural retrieval** — expanding a hit to
its whole section, and rolling up to the parent when several sibling subsections
hit. **That retrieval logic is not implemented.** Nothing reads
`parent_section_id` back out. See [03-retrieval.md](03-retrieval.md) §"Stage 2".

The comments in the ingestion code describe the intent, which makes this easy to
misread as built. It isn't.

---

## 2. Tables: a real Postgres table per source

`src/data/table-loader.ts`, `src/data/table-schema.ts`

A risk register is not prose. Chunking a 16-row spreadsheet into vector chunks
means "how many risks are open?" becomes a *similarity search* — which is the
wrong tool, and it silently returns a *plausible* answer rather than a *correct*
one.

So tables get loaded into **actual Postgres tables**, with an inferred schema
registered in `table_registry`. Then "how many risks are open?" is
`SELECT count(*) … WHERE status = 'open'` — exact, complete, and either right or
an error.

The physical table name derives from a registry **UUID**, never from user input —
that's SQL barrier 3 ([01-security.md](01-security.md)).

### The dual-purpose blurb — how a table becomes findable

A table in Postgres is invisible to semantic search. So exactly **one** chunk per
table goes into Qdrant: the *blurb*, which does two jobs at once.

```ts
// src/data/blurb.ts
//   1. The prose section embeds well, so semantic search finds the table
//      ("what risks are tracked in Project Summit" -> finds this blurb)
//   2. The schema section is the query manual the LLM reads to construct
//      a structured query (table id + valid columns + types)
```

- **The prose half** is what gets embedded — it's how the table is *discovered*.
- **The schema half** is the *query manual* — table id, valid columns, types. The
  planner reads it to build a `QueryRequest`.

Generated **deterministically from the schema, no LLM call**. An LLM could write
richer prose, but the deterministic version is reliable, fast, and good enough to
embed meaningfully — and it can't hallucinate a column that doesn't exist into the
query manual.

### Table semantics: tier 1 / tier 2

The loader enriches the schema so the planner can query intelligently:

- `value_domain` — for columns with ≤12 distinct values, the actual value set
  (so the planner knows `status ∈ {open, closed, mitigated}` and doesn't guess)
- `value_range` — min/max for numerics
- legend parsing (`src/data/legend.ts`) — spreadsheets often define their codes
  in a legend block; those become part of the semantics

This is the "cut the panels" idea applied to querying: the planner doesn't guess
what a column contains, it's **told**.

---

## 3. Data quality — surfacing defects rather than absorbing them

`src/data/data-quality.ts`

```ts
kind: "duplicate_identifier" | "empty_column";
```

**This found a real defect in the ground-truth Risk Register**: `R-001` appears
twice, with the owner spelled `"Feng, Xiu-Ying"` and `"Dr. Xiu-Ying Feng"` — two
strings, one human. 13 owner strings map to roughly 8 people.

That matters beyond tidiness: any aggregate grouped by owner is **wrong**, and
nothing in a vector search would have told you. The check surfaces it at ingest.

The same discipline as `insufficient_evidence` in drafting — **a defect is
reported, never silently coerced.**

Related: `src/ingestion/prune.ts` (orphan pruning) and generic-header detection.

---

## 4. Live sources

`src/live-sources/` — descriptor-driven ingestion of external sources, with the
same blurb + registry pattern. Declarative: a descriptor file per source, no code.

---

## Try it

```bash
npm run smoke:tables    # table loading, schema inference, tier semantics
npm run smoke:hybrid    # blurb generation + both retrieval lanes
npm run smoke:xlsx      # the xlsx path end to end
```

**Experiment:** ingest a spreadsheet with a duplicate identifier and watch
`checkDataQuality` name it. Then ask the agent an aggregate question over that
column and reason about why the answer is wrong — that's the failure the check
exists to prevent.
