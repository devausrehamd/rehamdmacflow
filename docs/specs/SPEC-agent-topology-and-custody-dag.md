# SPEC — Agent topology, custody DAG, capability dispatch & readiness gate

**Status:** Ready to implement · **Audience:** Claude Code · **Repo:** `rehamdmacflow`
(with touchpoints in `discovery`) · **Author of design:** Dion (decisions locked below)

Implement in the numbered phases. **Each phase is independently shippable and ends
with a smoke test that must pass before moving on.** Do not batch phases into one
PR. Follow the house style: deterministic-first, the LLM confined to one seam,
`PASS if … FAIL otherwise.` criteria, `smoke:<name>` acceptance tests.

---

## 1. Goal & context

We are moving from a single monolithic drafting agent to a **pipeline of
single-responsibility agent roles** — researcher → thinker → exporter → actioner —
while keeping a tamper-evident custody record across concurrent work. Read
[`../00-philosophy.md`](../00-philosophy.md) first; this spec is that philosophy
extended across process boundaries.

The core realisation: the four roles differ by **determinism class and side-effect
class**, and the only non-deterministic actor is the **thinker** (the LLM).
Everything else is pure (exporter), read-only I/O (researcher), or mechanical
egress (actioner). We quarantine non-determinism to the thinker and bracket it
with deterministic gates on both sides.

## 2. Decisions locked (invariants — do not deviate)

1. **Researchers are dumb.** A researcher (and later the exporter/actioner)
   returns a value and **never writes custody, never appends to the chain, never
   mutates shared state**. It is a pure-ish function: request → artifact.
2. **The orchestrator is the sole custody writer.** Only the executor/orchestrator
   calls `appendEvent`. Role agents hand back data; the orchestrator records it.
3. **Provenance is a DAG, not a list.** Concurrent work is captured by
   **content-addressed artifacts** referenced by hash. The existing linear
   hash-chain is demoted to a *serialized event log* that references those hashes.
4. **Non-determinism lives only in the thinker**, bracketed by two deterministic
   gates: a **readiness gate** before (input-completeness) and the existing
   **section validator + scored rubric** after (output).
5. **Capability, not address.** A recipe step declares a *required capability*
   (e.g. `research:qms`); the orchestrator resolves capability → live agent via
   Discovery. No hard-coded agent URLs.
6. **Trust but verify hashes.** When a role agent returns an artifact with a
   self-computed id, the orchestrator recomputes `artifactId(body)` and rejects a
   mismatch. A role agent cannot dictate its own hash.

## 3. Non-goals (out of scope for this spec)

- Extracting researchers/exporter/actioner into separate deployable services is
  **Phase 6 and is deferred**. Phases 1–5 land the substrate with **in-process
  capability providers**, so the whole thing is testable without new services.
- No changes to the LLM prompts, models, or the k-sampling instrument.
- No new external egress (real email/DB writes) — the actioner is stubbed.

## 4. What already exists — extend, do not reinvent

| Concern | Where | Reuse it for |
|---|---|---|
| Canonical JSON (stable bytes) | `src/custody/ledger.ts` → `canonicalJson()` | Content-addressing (Phase 1) |
| Entry hashing | `src/custody/ledger.ts` → `hashEntry()` | Unchanged |
| Append, **already serialized** by `pg_advisory_xact_lock(hashtext(domain))` | `src/custody/ledger.ts` → `appendEvent()` | The single-writer append (Phase 2) |
| Event types | `src/custody/ledger.ts` → `CustodyEventType` | Add `gather_complete` (Phase 2) |
| Recipe steps (Zod discriminated union), DAG validation | `src/drafting/recipe.ts` → `STEP_KINDS`, `stepSchema`, `validateRecipe()` | Add capability steps (Phase 3) |
| The interpreter (walks steps, threads an `OutputBag`, emits one event per step) | `src/drafting/executor.ts` | Fan-in + gates (Phases 4–5) |
| DocumentType = `rubricSchema` (documentType, sections, criteria, recipe, trajectory, **requires**, **exports**) | `src/drafting/rubric-schema.ts` | Add `requiredInputs` (Phase 3) |
| Section/field model (provenance, types, formula) | `src/drafting/section-schema.ts` | Exporter input contract (Phase 6) |
| Criterion assessment types `llm_judge / deterministic / hybrid` | `src/drafting/rubric-schema.ts` → `ASSESSMENT_TYPES` | Readiness criteria are `deterministic` (Phase 4) |
| Agent Card capabilities, GUID resolution | `discovery` service, Agent Card | Capability → agent (Phase 5) |

### ⚠️ Naming — avoid the collision the codebase already warns about

Three different "inputs" must stay distinct:

- `rubric.requires` — **existing.** Upstream *generated documents* this doc is built
  on (consumed via `recall_prior`). **Leave untouched.**
- `step.inputs` — **existing.** Intra-recipe DAG edges (prior step ids). **Leave untouched.**
- **`rubric.requiredInputs`** — **NEW (this spec).** The *gathered research inputs*
  the thinker needs (labor rate, headcount…), each mapped to a supplying
  capability. Do **not** fold this into `requires`; conflating them will corrupt
  the trajectory check exactly as the comment in `rubric-schema.ts` cautions.

---

## 5. Target model

Four structures and one flow.

```
DocumentType (rubric-schema)
├─ requiredInputs[]      NEW  what must be gathered + which capability supplies it
├─ recipe.steps[]             now may carry `requires: <capability>`
├─ readinessRubric       NEW  deterministic input gate (or derived from requiredInputs)
├─ sections[]                 the typed output model (exporter's input contract)
├─ criteria[] / trajectory    the existing output gates
└─ exports[]                  allowed export formats

Artifact (content-addressed)          id = sha256(canonicalJson(body))
├─ producer, capability, query, result, producedAt, sourceRef

Custody event log (linear, one writer)
└─ …→ gather_complete{ refs:[id_a,id_b,id_c] } → generation{ inputs:[…] } →…

Flow:  plan → GATHER (parallel, dumb) → READINESS GATE (deterministic, hard)
         → THINK (LLM) → validate+score (existing) → export → act
```

---

## 6. Phases

### Phase 1 — Content-addressed artifact store

**New:** `src/custody/artifacts.ts`

```ts
export interface Artifact {
  producer: string;        // "qms-researcher@<guid>" | "inproc:qms"
  capability: string;      // "research:qms"
  query: unknown;          // what was asked (canonicalisable)
  result: unknown;         // what came back
  producedAt: string;      // ISO; supplied by caller (no Date.now in hashed core)
  sourceRef?: string;      // web: etag/snapshot; RAG: corpus version. Integrity vs reproducibility.
}
export function artifactId(a: Artifact): string;      // sha256(canonicalJson(a))
export async function putArtifact(a: Artifact): Promise<string>;   // returns id; idempotent
export async function getArtifact(id: string): Promise<Artifact | null>;
```

- Reuse `canonicalJson` from `ledger.ts` (export it if not already exported).
- **Drizzle migration:** table `custody_artifacts(hash text primary key, capability
  text, producer text, body jsonb not null, created_at timestamptz default now())`.
  `putArtifact` is an upsert on `hash` (same content → same row, no duplicate).
  > **Migration convention (applies to every phase):** this repo **hand-authors**
  > migrations — a numbered `drizzle/NNNN_*.sql` (idempotent `IF NOT EXISTS`,
  > `--> statement-breakpoint` between statements) plus a manual entry in
  > `drizzle/meta/_journal.json`. It keeps **no** drizzle snapshots. Do **not**
  > run `drizzle-kit generate` — with no snapshot baseline it emits the entire
  > schema as a spurious migration and pollutes the journal. Apply with
  > `npm run db:migrate`.
- **Invariant:** `artifactId` depends only on the artifact body — **no ordering,
  no chain reference.** This is what makes parallel producers race-free.

**Acceptance — `smoke:artifacts`** (`scripts/smoke-test-artifacts.ts`, deterministic, no LLM):
- same body → same id; one differing byte → different id;
- key-order/whitespace variations of the same logical object → **same id** (canonicalisation);
- `putArtifact` twice → one row; `getArtifact(id)` round-trips exactly.

### Phase 2 — Custody DAG: events reference input hashes; single writer

**Edit:** `src/custody/ledger.ts`

- Add `"gather_complete"` to `CustodyEventType`.
- Allow event payloads to carry `inputs?: string[]` (artifact hashes) and ensure
  those bytes are inside `hashEntry`'s hashed material (so tampering a referenced
  artifact — which changes its id — invalidates the referring event).
- Add a doc comment establishing invariant #2: **role agents never call
  `appendEvent`.** The advisory lock already serializes the single writer; do not
  add a second writer for research/export/act.

**Edit:** `src/drafting/executor.ts` — the `generation` event for a thinker step
must include `inputs: [artifact ids consumed]` (from the gather step, Phase 5).

**Acceptance — `smoke:custody-dag`** (`scripts/smoke-test-custody-dag.ts`, needs Postgres):
- Build 3 artifacts (Phase 1) → append one `gather_complete{ refs:[3 ids] }` →
  append a `generation{ inputs:[gather id] }`.
- Verify the chain verifies (existing verify path).
- Mutate one artifact's stored body → recompute its id → assert the
  `gather_complete` no longer references it (reference break is detectable).
- Assert only the orchestrator path appended (no role-agent writer exists).

### Phase 3 — DocumentType contract: requiredInputs + capability steps + exports pre-flight

**Edit:** `src/drafting/recipe.ts`

- Extend the base step with optional `requires: z.string().optional()` (a
  capability id like `research:qms`, `export:docx`, `act:email`).
- Add new step kinds to `STEP_KINDS` + `stepSchema`:
  - `gather` — fan-out research; fields: `requires` (capability) **or** a list of
    sub-requests, `produces` (an input id from `requiredInputs`).
  - `check_readiness` — the hard gate (Phase 4).
  - `export` — fields: `format` (must be in `rubric.exportFormats` — see the
    naming note below; NOT `rubric.exports`). Handler lands Phase 6.
  - `act` — fields: `channel`. Handler lands Phase 6 (stub now).
- Extend `validateRecipe(...)` with a **capability pre-flight**: given a provided
  set of capabilities, every `requires` must resolve, else `RecipeError("bad_target")`.
  (The set is injected — tests pass a stub set; runtime passes Discovery's live set.)

**Edit:** `src/drafting/rubric-schema.ts`

```ts
requiredInputs: z.array(z.object({
  id: z.string().min(1),          // "labor_rate"
  description: z.string().min(1),
  capability: z.string().min(1),  // "research:sales" — who supplies it
  required: z.boolean().default(true),
})).default([]),
```

- Keep `requires` and `exports` **as they are**. Add `requiredInputs` alongside.
- ⚠️ **`exports` is NOT output formats.** The existing `exports` is a *map of typed
  DATA artifacts* downstream documents consume (`riskItems → schema`). Output
  render formats (`md`/`docx`) are a different concept, so add a **new**
  `exportFormats: string[]` field — do not overload `exports` (same trap as
  `requires` vs `requiredInputs`). An `export` step's `format` must be a member of
  `exportFormats`.

**Acceptance — `smoke:doctype-contract`** (`scripts/smoke-test-doctype-contract.ts`, deterministic):
- A doc type declaring `requiredInputs` + a `gather` step with `requires:"research:sales"`
  validates when `research:sales` is in the provided capability set;
- fails pre-flight (`bad_target`) when it is not;
- an `export` step with a `format` absent from `rubric.exports` fails validation.

### Phase 4 — Readiness gate (deterministic, pre-thinker)

**New:** `src/drafting/readiness.ts`

- A **deterministic** evaluator over the gathered input bundle (`bundleFromBag`
  reads the `OutputBag` entries a `gather` step produces). **No LLM in the hard gate.**
- The checks are driven entirely by `rubric.requiredInputs` — no separate
  criteria list. (The criterion/`patterns` model fits regexes over *output text*,
  not typed *input values*, so constraints live on the input manifest instead —
  the same reason `requiredInputs` ≠ `criteria`.) Two check kinds:
  1. **Presence** — a `required` input that was not gathered is a gap.
  2. **Validity** — optional `min` / `max` / `pattern` constraints on a
     `requiredInputs` entry are checked when the input is present (e.g.
     `duration_weeks` in 1–260).
- Output: `{ ready: boolean, gaps: { inputId, capability, reason }[], checked }`.

**Edit:** `src/drafting/executor.ts`

- Add a `check_readiness` step handler. It is a **hard gate**: if `!ready`, do
  **not** run the thinker — halt with a precise gap list and set
  `reviewRequired`/route to `require_human` (or re-dispatch the missing
  capability, if a retry policy is configured). Emit a custody event for the gate
  outcome (orchestrator writes it).

**Acceptance — `smoke:readiness`** (`scripts/smoke-test-readiness.ts`, deterministic, NO LLM):
- Complete bundle → `ready:true`, thinker would proceed;
- bundle missing `labor_rate` → `ready:false`, `gaps` names `labor_rate` and its
  `research:sales` capability, and the executor **halts before any generate step**;
- out-of-range `duration_weeks` → failing gap with the reason. Assert zero LLM calls.

### Phase 5 — Capability dispatch + dumb researchers (in-process, then remote)

**New:** `src/orchestrator/capabilities.ts`

```ts
export interface CapabilityProvider {
  capability: string;                               // "research:qms"
  run(query: unknown, ctx: RunContext): Promise<{ result: unknown; sourceRef?: string }>;
}
export interface CapabilityRegistry {
  resolve(capability: string): CapabilityProvider | null;   // in-proc now; Discovery later
  available(): Set<string>;                                 // feeds the Phase 3 pre-flight
}
```

- **Executor `gather` handler:** for a `gather` step, resolve each required
  capability, run providers **in parallel** (`Promise.all`), and for each result
  build an `Artifact` (Phase 1), `putArtifact`, collect the ids. Then the
  orchestrator appends **one** `gather_complete{ refs:[ids] }` (Phase 2). Put the
  artifacts into the `OutputBag` keyed by their `produces` input id for the
  readiness gate + thinker to consume.
- **Dumb-researcher invariant:** a `CapabilityProvider.run` returns data only. It
  must not import `appendEvent`, `putArtifact`, or touch the chain. The **executor**
  hashes/stores/records. (Enforce with a lint note + a test that greps providers
  for `appendEvent`.)
- **Trust-but-verify:** when a provider is *remote* (later), the orchestrator
  recomputes `artifactId` over the returned body and rejects a mismatch (invariant #6).
- Provide **stub in-process providers** for `research:web`, `research:qms`,
  `research:sales` (qms can wrap the existing retrieval; web/sales return fixtures).
- **Discovery seam (light):** `CapabilityRegistry.available()` should be
  satisfiable from the Agent Card capability list so the Phase 3 pre-flight can run
  against live agents later. Full remote dispatch is Phase 6.

**Acceptance — `smoke:gather`** (`scripts/smoke-test-gather.ts`, deterministic, stub providers):
- Three stub providers run for one `gather` fan-out → three artifacts → exactly
  **one** `gather_complete` referencing all three;
- **parallel-safety:** run the same three in a different completion order → the
  three artifact ids are identical and the `gather_complete` refs set is equal
  (order-independent);
- assert no provider appended custody (single-writer holds).

### Phase 6 — Exporter & Actioner (deferred; spec now, build later)

Design so these drop into the **same capability dispatch** as `export:*` / `act:*`
providers — first in-process, then remote agents resolved via Discovery.

- **Exporter:** pure `SectionModel → bytes`. Input contract is the existing
  `section-schema` output, **never markdown/prose** (parsing prose back to data
  reintroduces the non-determinism we removed). MVP format `md`; then `docx`,
  `xlsx`. Test with **golden files**: fixture section-model → byte-identical output
  (`smoke:export`). Because the section-model is custody-recorded, the document is
  **reproducible from the ledger**.
- **Actioner:** the only external-write role. Must be **idempotent** (dedupe key),
  **gated** (approver ≠ author, the existing human gate before send), and the sole
  egress choke point. Stub the transport; assert the gate + idempotency in
  `smoke:act`. Real transports are a later milestone.

---

## 7. New smoke tests (acceptance summary)

Add each to `package.json` as `smoke:<name>` and to the catalogue in
[`../../readme.md`](../../readme.md#verifying-it-works--the-smoke-tests).

| Phase | Script | LLM? | Proves |
|---|---|---|---|
| 1 | `smoke:artifacts` | no | content-addressing: canonical, collision-free, round-trips |
| 2 | `smoke:custody-dag` | no (Postgres) | events reference artifact hashes; tamper breaks the reference; single writer |
| 3 | `smoke:doctype-contract` | no | `requiredInputs` + capability steps validate; pre-flight rejects unresolvable capabilities & bad export format |
| 4 | `smoke:readiness` | **no** | deterministic input gate halts before the thinker with named gaps |
| 5 | `smoke:gather` | no (stub providers) | parallel fan-in → one `gather_complete`; order-independent hashes; no role-agent writes |
| 6 | `smoke:export`, `smoke:act` | no (golden/stub) | pure export byte-golden; actioner idempotent + gated |

## 8. Open decisions to surface (ask before assuming)

1. **Retry vs halt on a readiness gap:** re-dispatch the missing capability
   automatically, or always halt to `require_human`? Default in this spec: **halt**;
   make re-dispatch an opt-in policy on the step.
2. **Where `custody_artifacts` lives:** same Postgres as the ledger (assumed), or a
   separate blob store? Assumed same DB for v1.
3. **Remote artifact size:** cap on artifact `result` size before it must be
   stored by reference (e.g. large web dumps)? Out of scope for v1; note it.

## 9. Glossary

- **Artifact** — an immutable, content-addressed unit of gathered/produced data.
- **Capability** — a stable id (`research:qms`) an agent advertises and a step requires.
- **Readiness gate** — deterministic pre-thinker check that all required inputs are present/in-range.
- **Orchestrator** — the executor; the **only** custody writer.
- **Dumb role agent** — researcher/exporter/actioner: returns data, writes no custody.
