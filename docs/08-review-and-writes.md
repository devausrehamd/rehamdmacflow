# 08 · Review & writes — the human gate

The system drafts. **A human decides.** Everything here exists to make that
sentence structurally true rather than aspirational.

---

## 1. The review contract

`src/api/routes/review.ts`

```
GET  /api/v1/drafts?status=pending_review     the queue
GET  /api/v1/draft/:correlationId             markdown + typed rows + verdict
                                              + editableFields / lockedFields
POST /api/v1/draft/:correlationId/disposition { decision, reason, edits }
```

### Approver ≠ author, enforced server-side

The independent check **is** the control. A UI cannot bypass it — which is why it
lives in the endpoint and not in a button's `disabled` attribute.

### The endpoint tells the client what's editable

`editableFields` / `lockedFields` come **from the server**. The GUI doesn't decide
that a computed field is locked; it's told. (See `../GUI_BUILD_SPEC.md` — the GUI
computes nothing.)

### Polling, not push

`GET /drafts?status=…`. Stateless, survives a GUI restart, no websocket
infrastructure. Revisit only when a real need appears.

---

## 2. Human edits are a DISTINCT provenance

`src/drafting/human-edit.ts`

### The trap this closes

A reviewer edits `severity: 9 → 7`. If the document is then re-run through the
grounding rubrics, one of two bad things happens:

- the legitimate edit **fails** (a human's judgement has no "source"), or
- worse — you've built a **laundering path**: edit the value, re-score, and the
  chain now says "validated" over something a human typed freehand.

### The fix: a field-level delta

```ts
{ row: 0, field: "severity", from: 9, to: 7,
  priorProvenance: "retrieved", overridesComputed: false }
```

Four properties, all tested (`npm run smoke:review`):

| Property | Why |
|---|---|
| **Originals are never mutated** | append-only, same as the ledger |
| **Edited fields flip to `human_edited`** | they can never be re-scored as model output |
| **Overriding a computed field raises an auditor flag** | a human asserting a number the formula disagrees with must be *visible* (`overridesComputed`, `hasComputedOverride`) |
| **The delta is a chained `human_decision` custody event** | attributed to the approver |

### Edit the typed rows, not the markdown

You cannot reliably diff a hand-edited markdown table back into fields. The rows
are canonical ([04](04-data-model.md)); markdown is a projection.

---

## 3. Renderers format; they never edit

`src/drafting/render-markdown.ts` — a **faithful projection** of the typed rows.

- A gap renders as **INSUFFICIENT EVIDENCE**, never blanked to look tidy.
- The status banner (`DRAFT — REVIEW REQUIRED` / `APPROVED` / `REJECTED`) and the
  correlation id are **on the page**.

**Why it matters:** a rendered document *looks* final. If the rendered file and
the stored rows ever disagree, the custody chain describes a document nobody
reviewed.

⚠️ **Anti-pattern:** a second LLM that *edits* the document for tone or
formatting. A presentation judge may **assess** (advisory criteria, notes for the
human). The moment it **rewrites** the rendered output, an ungrounded model sits
between the validated data and the reviewer, and the artifacts diverge. It flags;
the human decides.

---

## 4. Writes are human-gated — and the gate is upstream

`src/writes/xlsx-register.ts`

```ts
// Deterministic, tested merge of an approved register entry into a master
// ... already been approved by a human upstream; this code just performs the
// merge.
//   1. Validate the approved fields against a schema.
```

**Read that carefully — it's the whole design.** The writer does **not** decide
whether to write. It merges an entry that a human **already approved** through the
review disposition. The gate is the disposition endpoint; the writer is a
deterministic executor of an already-made decision.

Two consequences:

**The agent has no autonomous write path to a controlled record.** There is no
code path from "the model produced a good draft" to "the master register changed".
The only route is through a human disposition.

**The writer still validates.** Approval isn't a bypass — the approved fields are
schema-checked before the merge. A human can approve; a human cannot approve
something malformed into the master file.

```
draft -> judge -> require_human -> HUMAN DISPOSITION -> approved
                                                          │
                                                          ▼
                                          xlsx-register merge (deterministic)
```

---

## Try it

```bash
npm run smoke:review      # human-edit provenance, computed-override flag, renderer
npm run smoke:xlsx-write  # the merge, schema validation
```

**Experiment:** in `smoke:review`, edit a `computed` field (e.g. `rpn`) in the
fixture and watch `hasComputedOverride` fire. Then reason about why an auditor
needs that flag — a human overriding the formula might be right, but it must never
be invisible.
