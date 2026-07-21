# QMS Agent — Technical Documentation

A local-first agent that drafts controlled QMS documents (DFMEA, CAPA, risk
registers, export-control assessments), evaluates them against declared rubrics,
and routes them to a human — with a tamper-evident record of how every value came
to exist.

**This is a testbed.** It exists to let engineers try methods and see the
consequences. Read [00-philosophy.md](00-philosophy.md) first: almost every design
choice here follows from one idea, and the code makes no sense without it.

---

## Read in this order

| # | Doc | What it covers |
|---|---|---|
| 00 | [Philosophy](00-philosophy.md) | The one idea the whole system follows from |
| 01 | [Security](01-security.md) | Access labels, JWT, login, permissions, domains, SQL barriers |
| 02 | [Ingestion](02-ingestion.md) | Heading-aware chunking, the structural map, tables → Postgres, blurbs, data quality |
| 03 | [Retrieval](03-retrieval.md) | Hybrid prose/table lanes, subject scoping, enumeration |
| 04 | [Data model](04-data-model.md) | Every Postgres table and **why it exists** |
| 05 | [Drafting](05-drafting.md) | Recipes, the executor, the two LLM handlers, section schemas, the validator |
| 06 | [Rubrics](06-rubrics.md) | Weighted-binary criteria, deterministic scoring, draft/committed, k-sampling |
| 07 | [Custody & provenance](07-custody-provenance.md) | The hash chain, the external sink, what is (and isn't) recorded |
| 08 | [Review & writes](08-review-and-writes.md) | Human gating, edit provenance, why writes can't self-approve |
| 09 | [Services & auth](09-services-and-auth.md) | The four services, discovery, the **Data Access API** (all DB access API-mediated), the auth contract |
| 10 | [Answering](10-answering.md) | The deterministic/LLM boundary: exact-data short-circuit, grounding gate, the derivation registry, decoder abstain |

These numbered docs *are* the decision record — each explains **why**, not just
what. The exact cross-service token contract is in
[09-services-and-auth.md](09-services-and-auth.md).

**Build specs** (implementation plans for larger changes) live in
[`specs/`](specs/):
- [agent topology, custody DAG, capability dispatch & readiness gate](specs/SPEC-agent-topology-and-custody-dag.md)
  — researcher → thinker → exporter → actioner, with parallel-safe content-addressed
  provenance and a deterministic input gate before the LLM (Phases 1–6, **built**).
- [agent platform & control plane (AgentAsSoftware)](specs/SPEC-agent-platform-and-control-plane.md)
  — declarative config-driven agents, Discovery + Supervisor, JWT propagation, a
  write-ahead trajectory-history endpoint, and the decision-13 rule that all
  request-path database access is API-mediated. **Stages 0–5 and the decision-13
  refactor (R1–R5) are BUILT in 0.2.0**; the ingestion converter registry remains
  designed.
- [operational control plane — role agents on containers](specs/SPEC-operational-control-plane.md)
  — makes the control plane real: a prompt spawns isolated role agents
  (researcher/thinker/exporter/actioner) in containers, dispatches work by
  capability, gathers content-addressed results, and reaps by TTL. Closes the gap
  where `/ask` runs in-process and nothing spawns a real agent (**build, D0**).

---

## Implementation status — read this before believing anything

Docs that describe unbuilt features are worse than no docs. This table is the
truth as of the last verification pass. **Anything marked DESIGNED is not in the
code**, however sensible the surrounding comments make it sound.

| Feature | Status | Where |
|---|---|---|
| Heading-aware chunking with parent/child links | **BUILT** | `src/ingestion/heading-chunker.ts` |
| Structural map in Postgres (`document_sections`) | **BUILT** | `src/db/schema.ts` |
| Chunks tagged with `section_id` / `parent_section_id` in Qdrant | **BUILT** | `src/ingestion/qdrant-writer.ts` |
| **Expand a hit to its whole section** | **DESIGNED — NOT BUILT** | data model ready; no retrieval code reads it |
| **Roll up to the parent when ≥3 siblings hit** | **DESIGNED — NOT BUILT** | see [03-retrieval.md](03-retrieval.md) §"Stage 2" |
| **Context-window budgeting** | **NOT BUILT** | no token-budget code exists anywhere |
| Hybrid prose + table retrieval | **BUILT** | `src/agent/nodes/retrieve.ts` |
| Tables in Postgres + planner-driven SQL | **BUILT** | `src/data/`, `src/agent/sql-planner.ts` |
| Access labels (classification + entitlement) | **BUILT** (enforcement flag default **OFF**) | `src/identity/`, `QMS_ENFORCE_LABELS` |
| JWT login + role permissions | **BUILT** | `src/api/auth/` |
| Deterministic recipe → executor → 2 LLM handlers | **BUILT** | `src/drafting/` |
| Section schemas + validator (gaps, grounding, computed fields) | **BUILT** | `src/drafting/section-validator.ts` |
| Weighted-binary rubrics + deterministic scoring | **BUILT** | `src/drafting/scoring.ts` |
| k-sampling variance instrument (Wilson CIs, coin-flip detection) | **BUILT** | `src/drafting/rubric-stats.ts` |
| Hash-chained custody ledger | **BUILT** | `src/custody/ledger.ts` |
| External provenance sink | **BUILT** | `src/custody/sink.ts` |
| Human review contract + edit provenance | **BUILT** | `src/drafting/human-edit.ts`, `src/api/routes/review.ts` |
| ID Server (identity) / Discovery (registry) | **BUILT** | `../idserver`, `../discovery` |
| GUI (thin client: login, rubric editor, review queue, k-sampling steering, **Ask**) | **BUILT** | `../gui` |
| **Data Access API — all request-path DB access API-mediated** (decision 13) | **BUILT (0.2.0)** | `src/api/routes/data-access.ts`, `src/data/*-client.ts` |
| Agent role holds no DB/vector/cache client — guarded | **BUILT (0.2.0)** | `npm run smoke:agent-db-free` |
| Control-plane **components**: capability resolution, manifest, DAG-History, Supervisor logic, `/ask` (in-process) | **BUILT (0.2.0)** | `src/orchestrator/`, `src/platform/`, `src/api/routes/orchestrator.ts` |
| `/ask` **spawns + dispatches to real role agents** (multi-agent orchestration) | **DESIGNED — building** | [SPEC-operational-control-plane](specs/SPEC-operational-control-plane.md); today `/ask` runs the graph in-process and the only `Launcher` is a test stub |
| Deterministic exact-data short-circuit (no LLM for count answers) | **BUILT (0.2.0)** | `src/agent/compose-exact.ts` |
| Grounding gate — call out an impossible/undefined filter | **BUILT (0.2.0)** | `src/agent/grounding.ts` |
| Derivation registry — QMS defines interpretive terms | **BUILT (0.2.0)** | `derivations/`, `src/agent/derivations.ts` |
| Decoder abstains on undefined interpretive terms | **BUILT (0.2.0)** | `src/agent/sql-planner.ts` |
| Corpus backtest (outer loop) | **DESIGNED — NOT BUILT** | needs labelled rejected-history corpus |
| Renderer agent (docx/xlsx) | **DESIGNED — NOT BUILT** | markdown renderer exists |

If you implement something on this list, move the row and say where it lives.
If you find this table wrong, **the table is the bug** — fix it first.

---

## Running it

```bash
cd ~/projects
./setup.sh                # first run only: infra, deps, DB, models (idempotent)
./stack.sh start          # ID Server :3001, Discovery :3005, Agent :4000/:4001, GUI :5173
./stack.sh status
./stack.sh logs agent
```

Everything deterministic can be tested **without an LLM**. That's a design
property, not an accident — see [00-philosophy.md](00-philosophy.md).

```bash
npm run smoke:executor    # the whole recipe interpreter, stub handlers
npm run smoke:section     # the validator
npm run smoke:scoring     # rubric aggregation
npm run smoke:batch       # the variance instrument, mock judge
npm run smoke:review      # human-edit provenance + renderer
npm run smoke:draft-e2e   # REAL generation — needs Ollama
```

## Playing with it — good first experiments

- Break the grounding on purpose: edit `handlers.ts` to stop offering citation
  tokens, run `smoke:draft-e2e`, watch every retrieved field fail as
  `ungrounded_retrieved`. That's [the bug we actually hit](02-ingestion.md).
- Word a rubric criterion ambiguously, run `smoke:batch` at k=20, and watch it get
  flagged **COIN-FLIP**. See [06-rubrics.md](06-rubrics.md).
- Set a `severity` outside 1–10 in a fixture and watch the validator catch it
  before the model's output is ever trusted.
- Add a document type: one rubric file, zero code. See [05-drafting.md](05-drafting.md).
