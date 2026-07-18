# QMS Agent (`rehamdmacflow`)

A local-first agent that **drafts controlled QMS documents** (DFMEA, CAPA, risk
registers, gate reviews…), evaluates them against declared rubrics, and routes
them to a human — keeping a tamper-evident record of how every value came to
exist. Built on LangGraph.js and running entirely on macOS: Ollama (LLM +
embeddings), Qdrant (vectors), Postgres (structured data + custody), Redis
(memory). No calls leave the machine.

> ### 📚 This is a learning package
> The point isn't the documents — it's the **methods**. This repo is a testbed
> for the hard questions in putting an LLM near controlled records:
> - How do you keep generation **deterministic and testable** — so most of the
>   system can be verified *without* an LLM in the loop?
> - How do you prove a value is **grounded** in a real source, not invented?
> - How do you make a judge's verdict **a measurement** (pass *rates* with
>   confidence intervals) rather than one noisy coin-flip?
> - How do you guarantee a draft **can't approve itself** and a human stays the gate?
>
> Read **[`docs/00-philosophy.md`](docs/00-philosophy.md)** first — almost every
> design choice follows from one idea, and the code makes little sense without it.

## Where the docs are

The full technical documentation lives in **[`docs/`](docs/README.md)** — this is
the authoritative doc home for the whole stack. Read in order:

| # | Doc | Covers |
|---|-----|--------|
| 00 | [Philosophy](docs/00-philosophy.md) | The one idea the whole system follows from |
| 01 | [Security](docs/01-security.md) | Access labels, JWT, permissions, SQL barriers |
| 02 | [Ingestion](docs/02-ingestion.md) | Heading-aware chunking, tables → Postgres |
| 03 | [Retrieval](docs/03-retrieval.md) | Hybrid prose/table lanes, subject scoping |
| 04 | [Data model](docs/04-data-model.md) | Every Postgres table and **why it exists** |
| 05 | [Drafting](docs/05-drafting.md) | Recipes, the executor, section schemas, the validator |
| 06 | [Rubrics](docs/06-rubrics.md) | Weighted-binary criteria, scoring, k-sampling |
| 07 | [Custody & provenance](docs/07-custody-provenance.md) | The hash chain, the external sink |
| 08 | [Review & writes](docs/08-review-and-writes.md) | Human gating, why writes can't self-approve |
| 09 | [Services & auth](docs/09-services-and-auth.md) | The four services, discovery, the auth contract |

Rubric-authoring rules: [`docs/RUBRIC_AUTHORING_RULES.md`](docs/RUBRIC_AUTHORING_RULES.md).

## Part of the QMS stack

This repo is service **1 of 4**. The master repo wires them together and runs
them from VS Code:

**Master repo → https://github.com/devausrehamd/rehamdmacmain** (clone that with
`git clone --recursive` to get the whole stack). Siblings: `../idserver` (identity),
`../discovery` (registry), `../gui` (thin web client).

## Prerequisites

- macOS (Apple Silicon recommended; Intel works but slower)
- [Homebrew](https://brew.sh) and **Node 22 LTS** (`nvm use` — see `.nvmrc`)
- ~10 GB free disk (mostly models), 16 GB RAM minimum

## Quick start

```bash
# From the master repo, ./setup.sh does everything for all four services.
# To set up just the Agent, from this directory:
./setup.sh                 # idempotent: brew, Postgres/Redis/Ollama, Colima+Qdrant,
                           # models, DB + migrations, npm install, .env
npm run ingest:repo        # ingest the QMS corpus into Qdrant + Postgres
npm run api                # start the Agent API on :4000
```

`setup.sh` is idempotent — safe to re-run; it skips what's already done.

## Verifying it works — the smoke tests

**The whole learning payoff is here.** Everything deterministic can be tested
**without an LLM** — that's a design property, not an accident (see
[00-philosophy.md](docs/00-philosophy.md)). Each script is a small, readable proof
of one behaviour; reading them is the fastest way to learn the system.

### Deterministic — no LLM, fast, run these first

| Command | Proves |
|---------|--------|
| `npm run smoke:dependency` | The document dependency graph (no LLM, no Postgres) |
| `npm run smoke:scoring` | The deterministic rubric scorer + pattern pre-check |
| `npm run smoke:section` | The section validator — the deterministic gate before the LLM is trusted |
| `npm run smoke:executor` | The recipe interpreter end-to-end with **stub** handlers |
| `npm run smoke:rubrics` | The rubric loader and the draft/review schema foundation |
| `npm run smoke:rubric-api` | The rubric API's validation core, headless (no server, no GUI) |
| `npm run smoke:doctype-contract` | The DocumentType contract: requiredInputs, capability-typed steps, and the capability/format pre-flight (custody-DAG Phase 3) |
| `npm run smoke:review` | The review contract's pure parts: human-edit provenance + renderer |
| `npm run smoke:batch` | The k-sampling instrument, with a **mock** judge of controllable variance |

### Needs infra — Postgres / Qdrant / Redis running

| Command | Proves |
|---------|--------|
| `npm run smoke:artifacts` | The content-addressed artifact store: canonical, collision-free, idempotent, round-trips (custody-DAG Phase 1) |
| `npm run smoke:dataplane` | The data plane works end-to-end before anything is built on top |
| `npm run smoke:tables` | The structured-data foundation (tables → SQL) end-to-end |
| `npm run smoke:custody` | The custody ledger, end-to-end against Postgres |
| `npm run smoke:custody-dag` | The provenance DAG: events reference artifacts by hash; tampering an artifact or an event's inputs is detected; single-writer (custody-DAG Phase 2) |
| `npm run smoke:readiness` | The readiness gate: a deterministic input-completeness check that halts before the thinker with named gaps (custody-DAG Phase 4) |
| `npm run smoke:custody:e2e` | Custody over **real HTTP** |
| `npm run smoke:subject` | Project scoping and collection enumeration |
| `npm run smoke:identity` | The entitlement seam (labels resolve, fail closed) |
| `npm run smoke:security` | The enforcement chain end-to-end against a live Qdrant |
| `npm run smoke:hybrid` | Hybrid retrieval — the agent querying SQL *and* vectors |
| `npm run smoke:auth` | The auth layer end-to-end |
| `npm run smoke:agent` | The agent graph executes end-to-end (without going through HTTP) |

### Needs Ollama — real generation

| Command | Proves |
|---------|--------|
| `npm run smoke:draft-e2e` | **Real** document generation: the actual LLM handlers through the recipe |

## Other tasks

```bash
npm run api:debug     # second instance in DEBUG mode on :4001 (may load draft
                      # rubrics; its output can never be approved)
npm run ingest:repo   # (re)ingest the corpus
npm run ask -- "…"    # query the RAG from the CLI
npm run create-admin  # seed an admin user
npm run db:migrate    # apply migrations
npm run db:studio     # Drizzle studio
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
```

## Service URLs (after setup)

- Ollama: http://localhost:11434
- Qdrant: http://localhost:6333 (dashboard at `/dashboard`)
- Postgres: `localhost:5432` (database `qms_agent`)
- Redis: `localhost:6379`

## Tearing down

```bash
./teardown.sh           # stop services, keep data
./teardown.sh --purge   # stop services AND delete all data
```

## Troubleshooting

**Docker/Colima won't come up** — this stack uses [Colima](https://github.com/abiosoft/colima)
(open-source) as the Docker daemon. `colima status`; `colima restart` if the CLI
can't reach the daemon.

**Qdrant container starts then stops** — usually a port conflict; `lsof -i :6333`.

**`npm install` peer-dependency errors** — the LangChain ecosystem occasionally
mismatches peers; `npm install --legacy-peer-deps` usually resolves it.

**Agent produces low-quality JSON** — the 7B model is at the edge of reliable
structured output; lower temperature, strengthen the "JSON only" instruction, or
step up to `qwen2.5:14b-instruct-q4_K_M`.

**Cold-start latency** — Ollama unloads idle models; set `OLLAMA_KEEP_ALIVE=24h`.
