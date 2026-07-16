# Rubric authoring rules — for an agent generating rubrics from QMS documents

You are generating **rubric JSON files** that govern how a QMS agent judges
generated documents. One rubric per document type, saved as
`rubrics/<documentType>.json`. This document is the complete contract. A rubric
that violates any hard rule here **will not load** — the schema rejects it at
startup — so treat the hard rules as non-negotiable syntax, not style.

Read the whole thing before writing a single rubric. The reasoning matters as
much as the format: a rubric that parses but encodes the wrong idea is worse
than one that fails to parse, because it will silently mis-judge every document.

---

## 0. What a rubric is, and what it is not

A rubric judges **one generated document type** against the QMS's standards. It
produces, per document:

- a **score** (0–100%): the weighted fraction of scored criteria that passed;
- a **gate** outcome: did every *critical* criterion pass;
- a **trajectory** outcome: did the run consult what it was required to;
- a single verdict — **approved** or **review required**.

A document is **approved** only if: `score ≥ reviewThreshold` **AND** every
critical criterion passed **AND** the trajectory held. Any one failing forces
human review. You are encoding the standard a competent human reviewer would
apply — no lower.

The judge you are writing for returns **one bit per criterion** (pass/fail) plus
a rationale. It never sees weights, never computes the score, never decides the
gate. That is why the criterion format below is strict: a one-bit judge cannot
act on an ambiguous rule.

---

## 1. HARD RULES (violating any of these means the rubric will not load)

1. **Every criterion's `criterion` text MUST be exactly:**
   `PASS if <condition>. FAIL otherwise.`
   - It must start with `PASS if` and end with `. FAIL otherwise.`
   - This is the ONE mandated form. Do NOT use `FAIL if <specific>.` — what a
     fail looks like goes in the `explanation` field (the judge sees it too),
     so the rule itself always states one exhaustive boundary.
   - `<condition>` states the passing condition **exhaustively** — everything
     not described by it fails. That is what "FAIL otherwise" asserts.
   - `PASS if` may be followed by a comma (`PASS if, for any failure, …`).
   - Regex the loader enforces: `^\s*PASS if\b[\s\S]*\.\s*FAIL otherwise\.\s*$`

2. **Every criterion needs a unique `id`** (kebab_or_snake, stable, meaningful).

3. **At least one non-advisory criterion**, and the scored weights must sum to a
   positive number. Advisory criteria (`gate: "advisory"`) MUST have `weight: 0`.

4. **`reviewThreshold` is a fraction 0..1** — the pass mark. `0.85` = 85%.

5. **A `deterministic` criterion MUST have at least one pattern** (forbidden or
   required). A deterministic criterion with no patterns has nothing to check.

6. **Aliases must be unique** across the committed rubric set. Do not reuse a
   document type or alias that another rubric already claims.

7. **Trajectory rules are a discriminated union on `kind`** — either
   `"document"` or `"agent"` (see §4). Every rule needs an `id` and a `reason`.

---

## 2. The criterion format, and why it is strict

`PASS if <condition>. FAIL otherwise.`

The judge decides one bit. If the rule says "failure modes should trace to a
source", the judge must *infer* where the acceptable line sits — and it will
infer differently on different runs. That run-to-run disagreement is exactly
what shows up as a **coin-flip** in the k-sampling report: 12/20, a criterion the
model cannot consistently decide. Writing the boundary down removes the
ambiguity at the source.

**Bad** (ambiguous, will read as vague to the judge):
> Every failure mode should be properly sourced and realistic.

**Good** (exhaustive passing condition):
> PASS if every failure mode in the output traces to a retrieved source — a
> design document, a recorded defect, or a prior analysis. FAIL otherwise.

Write the condition so that a reviewer reading only the condition, and the
document, could reach the same verdict the judge should. If you cannot state the
condition without "should", "appropriately", or "as needed", the criterion is
not yet decidable — sharpen it.

### The explanation field carries the nuance

`explanation` is free text given to the judge and shown to the auditor. Use it
to name what a FAIL looks like, and — crucially — what a *correct-but-surprising
PASS* looks like, so the judge does not fail a valid document for the wrong
reason. Worked example (a good one, from an export-control screen):

> **criterion:** PASS if the output evaluates Helix against the §742.4 HPC
> export controls and states whether Helix is within §742.4 scope, recording the
> screening result as exceeds thresholds, does not exceed thresholds, or pending
> further data. FAIL otherwise.
>
> **explanation:** Helix carries a programmable logic device (XCKU5P FPGA) and a
> DDR5 memory subsystem in a data-centre context, which places it within §742.4
> scope, so the screen must be run and a result recorded. The source material
> contains no Composite Theoretical Performance figure and no numeric
> 3A090/4A090 threshold, so "pending further data" is a correct and expected
> result — it is not a failure to conclude. A FAIL output omits any §742.4
> evaluation for Helix, evaluates §742.4 only for a different subsystem, or
> states that Helix falls outside §742.4 scope.

Note what the explanation does: it tells the judge that "pending further data"
is a PASS, not a hedge. Without that, a strict judge fails a correct document.

---

## 3. Gates, weights, and assessment types

### `gate` — what a failure DOES (this is the "expert vs objective" distinction)

- **`critical`** — a fail **blocks approval outright** and forces human review,
  regardless of score. This is the *Expert Assessment* / must-pass class: "the
  document MUST contain X; if not, it fails and a human is flagged." Use it for
  non-negotiables — no fabricated citations, required sections present, safety
  content included. A critical criterion usually also has `primary: true`.
- **`major`** — a fail contributes its (missing) weight to the score **and**
  flags for review.
- **`minor`** — a fail only costs its weight in the score.
- **`advisory`** — informational, `weight: 0`, never gates.

### `weight` — a criterion's share of the score

Scored weights (all non-advisory criteria) form the denominator. Their sizes are
relative; they do NOT need to sum to 100 (the score is a fraction of weight
awarded over weight possible). Give completeness/grounding the large weights and
narrow checks smaller ones. Critical criteria still carry weight AND gate.

### `assessmentType` — WHO judges

- **`llm_judge`** — semantic judgement. The default. Most criteria.
- **`deterministic`** — pattern match only, **no LLM**. Use ONLY for literal
  strings that are unambiguous to match: a required identifier must appear, a
  forbidden phrase must not. Requires patterns (§5).
- **`hybrid`** — deterministic pre-check AND llm_judge; fails if either fails.
  Use when a literal token is *necessary but not sufficient* (§5).

---

## 4. Trajectory — what the run must have DONE (auto-fail)

Every criterion above judges the **output**. That leaves one failure they are all
blind to: a document can be fluent, cite clause numbers, and pass every
criterion, while having been **built on nothing**. The output cannot testify
about how it was made. The trajectory can.

A trajectory rule checks the run's **recorded actions** — which document types it
retrieved, which agents it called — against what the rubric demanded. **A miss is
an AUTO FAIL**, not weighted into the score. A document produced without
consulting the governing procedure is not a slightly worse document; it is an
unsourced one.

Two kinds:

```jsonc
// A corpus document of this TYPE had to be retrieved during the run.
{ "kind": "document", "id": "capa_procedure",
  "documentType": "capa-procedure",
  "reason": "A CAPA must be grounded in the controlled CAPA procedure." }

// Another agent had to be asked — for facts the corpus cannot hold because
// they change, and which the model must never invent.
{ "kind": "agent", "id": "fx_rate", "agent": "web",
  "query": "current exchange rate AUD to USD",
  "reason": "A costing in USD must use a live rate, not a fabricated one." }
```

- `required[]` — ALL must be satisfied; any miss is an auto-fail.
- `forbidden[]` — NONE may be present; a hit is an auto-fail. Use for a
  superseded or archived document type that must never inform a live document.
- Key `document` rules on **document type, never a file path** — paths move when
  the QMS folder is reorganised, and a path-keyed rule silently breaks.

**When to add a trajectory rule:** whenever the document's authority derives from
a specific source. A DFMEA's rating scales come from the FMEA procedure — so
require it. A risk score is only meaningful under the risk-management procedure —
require it. If a fact must be current (a price, a rate, a standard's latest
revision), require an `agent` call rather than letting the model recall it.

---

## 5. Deterministic patterns — necessary conditions ONLY

Patterns match **vocabulary**. Criteria are about **claims**. A pattern can prove
a *necessary* condition — "if §742.4 never appears, the export screen cannot have
been done" — but never a *sufficient* one. The document could contain "§742.4"
while saying the opposite of what the rule requires.

Therefore:

- **`requiredPatterns`** — literal identifiers that MUST appear for the rule to
  be *possible*: a clause the rule is about (`§742.4`), a classification
  (`3A090`), a mandated section header.
- **`forbiddenPatterns`** — literal strings that must NEVER appear:
  anti-fabrication tripwires ("was EAR99" when it was not), a forbidden phrase.
- Each pattern is `{ "pattern": "<regex>", "label": "<human label>" }`. The
  regex is matched case-insensitively. Escape regex metacharacters in literals.

**Wire a required pattern as `hybrid`, not `deterministic`,** unless the ENTIRE
rule is a literal-string check. The pattern fails closed fast; the judge decides
the semantic question. A `deterministic` criterion trusts the pattern alone —
correct only for "this exact string must/must not appear", nothing more.

Never encode a semantic rule as a pattern. "Written unambiguously" has no literal
to match — it is `llm_judge` with no patterns.

---

## 6. Reading the QMS corpus to author a rubric

The corpus is organised by discipline, with projects nested inside:

```
00_Program_Management/{Charters,Gate_Reviews,Governance,Risk,Schedules}
01_Hardware_Engineering/{Consumer_RefBoard,DDR5_Board,RF_ActiveBoards,Server_PowerModule}
02_Firmware_Engineering/IoT_Sensor_Platform
03_Silicon_Operations/{Fab_28nm,OSAT}
04_Verification_and_Test/{HALT_HASS,HIL_Bench}
05_Standards_and_References/{App_Notes,Internal_Specs,JEDEC}
06_Correspondence
08_Governance_and_QMS
```

For each document type you are asked to write a rubric for:

1. **Find the governing procedure** in the corpus (in `08_Governance_and_QMS` or
   `05_Standards_and_References`). It defines the required sections, the rating
   scales, the mandatory content. Your `completeness` and scale criteria come
   straight from it — quote its section names, not generic ones.
2. **Make that procedure a required `document` trajectory rule.** If the document
   is meaningless without it, its absence is an auto-fail.
3. **Find real examples** of the document type across the projects. They show
   what a good instance actually contains — the identifiers used, the tables,
   the cross-references.
4. **Derive the anti-fabrication criticals** from what must never be invented:
   citations, regulatory clauses, part numbers, measured values. Each is a
   `critical` criterion of the form "PASS if every X traces to a retrieved
   source. FAIL otherwise."
5. **Set `reviewThreshold`** from how much slack the document type tolerates.
   Safety- and compliance-bearing documents sit high (0.85–0.9). Match the
   existing rubrics' rigour, do not undershoot it.

---

## 7. A complete, minimal, VALID example

```json
{
  "documentType": "export-control-screen",
  "displayName": "Export Control Screening",
  "version": "0.1.0",
  "aliases": ["export control screen", "ear screening"],
  "reviewThreshold": 0.85,
  "criteria": [
    {
      "id": "helix_742_4_screened",
      "criterion": "PASS if the output evaluates Helix against the §742.4 HPC export controls and records the result as exceeds thresholds, does not exceed thresholds, or pending further data. FAIL otherwise.",
      "explanation": "Helix (XCKU5P FPGA + DDR5, data-centre context) is within §742.4 scope, so the screen must run. With no CTP figure in the sources, 'pending further data' is a correct PASS, not a hedge. FAIL if §742.4 is not evaluated for Helix, or the output states Helix is out of scope.",
      "weight": 10,
      "primary": true,
      "assessmentType": "hybrid",
      "gate": "critical",
      "scope": "all_output",
      "forbiddenPatterns": [],
      "requiredPatterns": [{ "pattern": "§742\\.4", "label": "§742.4 clause" }]
    },
    {
      "id": "no_fabricated_classifications",
      "criterion": "PASS if every ECCN and classification in the output traces to a retrieved source. FAIL otherwise.",
      "explanation": "A FAIL invents an ECCN (e.g. states 3A090 without it appearing in any retrieved source).",
      "weight": 10,
      "primary": true,
      "assessmentType": "llm_judge",
      "gate": "critical",
      "scope": "all_output",
      "forbiddenPatterns": [],
      "requiredPatterns": []
    },
    {
      "id": "completeness",
      "criterion": "PASS if the output records, for every in-scope subsystem, the clause evaluated, the result, and the basis for the result. FAIL otherwise.",
      "explanation": "Sections required by the export-control procedure. FAIL if any in-scope subsystem is missing a recorded result.",
      "weight": 40,
      "primary": false,
      "assessmentType": "llm_judge",
      "gate": "minor",
      "scope": "all_output",
      "forbiddenPatterns": [],
      "requiredPatterns": []
    }
  ],
  "trajectory": {
    "description": "Must consult the controlled export-control procedure.",
    "required": [
      {
        "kind": "document",
        "id": "export_control_procedure",
        "documentType": "export-control-procedure",
        "reason": "Screening thresholds and scope are defined by the controlled procedure; a screen produced without it is ungoverned."
      }
    ],
    "forbidden": []
  }
}
```

---

## 8. Self-check before you emit a rubric

Go through this list for every rubric. If any answer is "no", fix it — the loader
will reject it or, worse, it will parse and mis-judge.

- [ ] Every `criterion` matches `PASS if <condition>. FAIL otherwise.` exactly.
- [ ] Every condition is exhaustive — no "should", "appropriate", "as needed".
- [ ] Every criterion `id` is unique; aliases don't collide with other rubrics.
- [ ] At least one non-advisory criterion; scored weights sum > 0; advisory ⇒ weight 0.
- [ ] Every non-negotiable ("must contain X") is `gate: "critical"`.
- [ ] Anti-fabrication criticals exist for anything that must not be invented.
- [ ] `reviewThreshold` reflects the document's real rigour (high for safety/compliance).
- [ ] Every deterministic criterion has ≥1 pattern; every required pattern is a
      genuine *necessary* condition wired as `hybrid` (unless the whole rule is literal).
- [ ] The governing procedure is a required `document` trajectory rule.
- [ ] Any fact that must be current is an `agent` trajectory rule, not model recall.
- [ ] Every trajectory rule has an `id` and a `reason` a human auditor can read.
