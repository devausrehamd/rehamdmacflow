# 05 · Drafting — the recipe pipeline

How a document gets made. Six of seven step kinds contain **no model at all**.

```
rubric file (rubrics/dfmea.json)
  ├── criteria      what "good" means      -> 06-rubrics.md
  ├── sections      the cut panels         -> section-schema.ts / section-validator.ts
  └── recipe.steps  the ordered program    -> recipe.ts
                        │
                        ▼
  executor.ts   walks steps, threads outputs, ONE custody event per step
                        │
        ┌───────────────┴───────────────┐
  deterministic handlers          LLM handlers (handlers.ts)
  retrieve_sections               generate_section  ← sews one section
  query_table                     judge             ← one bit per criterion
  recall_prior
  validate_section
  require_human → PERSIST → halt
```

---

## 1. The recipe — a program over a closed instruction set

`src/drafting/recipe.ts`

```ts
export const STEP_KINDS = [
  "retrieve_sections", // exact lookup of SOP sections by identifier
  "query_table",       // a QueryRequest against a structured table
  "recall_prior",      // an approved upstream document's exports
  "generate_section",  // LLM composes ONE declared section
  "validate_section",  // deterministic recheck
  "judge",             // LLM returns per-criterion PASS/FAIL
  "require_human",     // interrupt for disposition
] as const;
```

A Zod discriminated union. **The recipe cannot invent a step** any more than the
query planner can invent a column.

The DFMEA recipe:

| step | kind | model? |
|---|---|---|
| `sop` | `retrieve_sections` §4.1–4.3 | no |
| `risks` | `recall_prior` risk-register.riskItems | no |
| `data` | `query_table` risk-register | no |
| `gen_fm` | `generate_section` failure_modes, bestOf 2 | **yes** |
| `check_fm` | `validate_section` failure_modes | no |
| `score` | `judge` all criteria | **yes** |
| `gate` | `require_human` | no |

### The DAG is validated at LOAD, not at run

```ts
export function validateRecipe(steps: Step[], sectionIds: Set<string>): void
```

Checks: no forward references, no duplicate step ids, every
`generate_section`/`validate_section` targets a section the rubric actually
declares.

**Why at load:** a forward reference discovered mid-run is discovered *after side
effects*. Fail before anything happens.

## 2. The executor — deterministic interpreter

`src/drafting/executor.ts`

Walks steps in order, threads each output into a bag keyed by step id, emits **one
custody event per step**. The generation trajectory and the custody chain are the
same object — executing a step *is* appending an event.

**Handlers are injected:**

```ts
export interface StepHandlers {
  retrieve_sections(step, bag): Promise<...>;
  generate_section(step, bag, rubric): Promise<...>;
  judge(step, bag, rubric): Promise<...>;
  // ...
}
```

So `npm run smoke:executor` runs the *entire* interpreter with stubs — ordering,
threading, gap propagation, gate blocking, custody, the human halt — **with no
Ollama**. The real handlers slot into the same interface.

**Persistence is opt-in** (5th arg) so the stub tests stay DB-free.

## 3. Section schemas — the cut panels

`src/drafting/section-schema.ts`

Every field declares a **provenance**, and that word does real work:

| provenance | meaning | who fills it |
|---|---|---|
| `retrieved` | must come from a source **and cite it** | model — but the citation must be real |
| `generated` | composed prose | model |
| `computed` | derived by formula | **code only** |

```jsonc
// failure_modes section, abbreviated
{ "name": "severity",   "type": "number", "provenance": "retrieved", "min": 1, "max": 10 },
{ "name": "rpn",        "type": "number", "provenance": "computed",
  "formula": "severity * occurrence * detection" },
{ "name": "risk_ref",   "type": "reference", "referenceExport": "risk-register.riskItems.id" }
```

## 4. The validator — where output becomes trustworthy

`src/drafting/section-validator.ts`. Runs **before the model's output is trusted**.

| Check | Behaviour |
|---|---|
| computed fields | **recomputed by code**; the model's value is discarded and the mismatch recorded |
| missing required field | marked `insufficient_evidence` — a **gap**, not an invention |
| out-of-range | severity 15 on a 1–10 scale → range error |
| cross-reference | validated by **set membership** — `R-999` when no such risk exists → `reference_not_found` |
| grounding | source ref must be a **member of the offered token set** |

**Why RPN is code's job:** arithmetic isn't a judgement call. A model that gets it
right 95% of the time ships 5% wrong numbers into a controlled record.

## 5. The citation catalogue — the bug worth studying

The first real e2e run: **8 `ungrounded_retrieved` errors**.

The cause was *not* the model fabricating. The handler dumped context as anonymous
JSON and asked for "a source reference" without defining what a valid one looked
like. The model produced correct values with nothing citable to attach.

**The fix, both halves:**

```ts
// handlers.ts — every context item gets a stable, quoted token
SOURCES:
  source "R-014": {"risk_id":"R-014","item":"Battery pack","severity":9,...}
  source "4.2":   Severity, occurrence and detection are each rated 1-10...

// prompt: for every retrieved field, set "<field>__source" to the EXACT token
```

```ts
// section-validator.ts — grounding by MEMBERSHIP, not mere presence
const grounded = !isEmpty(ref) &&
  (validSourceRefs.size === 0 || validSourceRefs.has(String(ref)));
```

Result: 8 → 0 errors; `no_fabricated_failure_modes` flipped **FAIL → PASS**.

**The detector got stricter while the false positives disappeared.** Before, any
non-empty string passed. Now a value citing a source that was never offered is
caught as fabrication. That's the lesson: fix the cause, don't silence the
detector.

## 6. best-of-N — what it's for, and what it isn't

`generate_section` samples `bestOf` candidates and keeps the least-defective.

**It exists to reduce avoidable errors** (bad types, ungrounded values). It must
**never** pressure the model into inventing a missing rating. A gap stays a gap —
if the evidence isn't there, `insufficient_evidence` is the correct output and a
human is told why.

## 7. Adding a document type — zero code

1. Write `rubrics/<type>.json`: `documentType`, `aliases`, `criteria`, `sections`,
   `recipe.steps`.
2. That's it.

The loader hashes it, the alias index makes it addressable, the recipe validates
at load, and the executor runs it. **n document types = n config files, 0
chunkers.**

---

## Try it

```bash
npm run smoke:executor    # the whole interpreter, stubs, no LLM
npm run smoke:section     # the validator: gaps, ranges, references, computed
npm run smoke:draft-e2e   # REAL generation — needs Ollama
```

A real `draft-e2e` run:

```
rows generated:        2
insufficient_evidence: 0
validation errors:     0
RPN computed by code wherever inputs present ✓
Score: 84.6% (threshold 85%)  Gate: PASSED  Outcome: REVIEW REQUIRED
  FAIL actions (w20): no recommended actions or owners
custody: retrieval -> retrieval -> sql_query -> generation -> retrieval -> judge -> human_decision
```

**That `actions` failure is real and unresolved** — the `failure_modes` section
declares no `recommended_action`/`action_owner` fields, so the rubric checks for
something the recipe never generates. **The section schema and the rubric disagree
about what a complete DFMEA is.** Three legitimate fixes (add the fields / move the
criterion / accept it as a gate) — see `../SYSTEM_DESIGN.md` §5. Do **not** delete
the criterion; it's currently the system correctly catching genuine incompleteness.
