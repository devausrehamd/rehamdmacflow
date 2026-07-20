# Changelog

All notable changes to the QMS Agent (`rehamdmacflow`) are recorded here. This
project adheres to [Semantic Versioning](https://semver.org) and the commit
history follows [Conventional Commits](https://www.conventionalcommits.org).

## 0.2.0 — 2026-07-21

The agent-platform control plane, the decision-13 "all database access is
API-mediated" refactor, and the deterministic answer path (the deterministic/LLM
boundary contract).

### Features

- **feat(api): Data Access API foundation** — the REST boundary every store sits
  behind; artifacts written and read through the API, never a direct DB client
  (platform Stage 0).
- **feat(orchestrator): Discovery-backed capability resolution** — capability →
  live agent, production preferred (Stage 1).
- **feat(platform): agent manifest + boot-from-git-tag + ready registration** — a
  generic runtime specialised at boot from a git-tagged manifest (Stage 2).
- **feat(platform): DAG History store + write-ahead mirror** — durable,
  write-ahead, per-agent trajectory with terminal markers and resume points
  (Stage 3).
- **feat(platform): Supervisor** — ensure-running (reuse-or-launch), launch-once
  dedupe, TTL idle-destroy (Stage 4).
- **feat(orchestrator): Talk Agent `/ask`** — classify → confirm → orchestrate an
  answer under the caller's entitlements (Stage 5).
- **feat(agent): deterministic exact-data short-circuit** — a quantitative
  question whose SQL result is a scalar aggregate is answered with no LLM (a
  single count, or a multi-table cross-reference with a combined total).
- **feat(agent): grounding gate** — a planned filter whose value falls outside its
  column's domain is a decode failure and is called out, not executed.
- **feat(agent): derivation registry** — the QMS defines interpretive terms
  (`critical` → `score ≥ 16`); the definition is injected into the planner so the
  term is decoded, not guessed.
- **feat(agent): decoder abstains on undefined interpretive terms** — the planner
  self-declares a judgment word it cannot map, and the system calls it out instead
  of guessing a number.

### Refactors — decision 13 (all request-path database access is API-mediated)

- **refactor(custody): put the ledger behind the Data Access API** (R1).
- **refactor(trace): put run-step, LLM-call, and DAG-History writes behind the
  API** (R2).
- **refactor(retrieval): put vector search behind the Data Access API** — tier
  access and the label filter enforced from the token (R3).
- **refactor(agent): strip the last DB clients from the agent role + guard it** —
  QueryRecord/Redis behind the API, the `llm` client split out, and a runtime
  import-graph guard that fails if the agent reaches any DB/vector/cache client
  (R4).

### Fixes

- **fix(answer): real citations, never a placeholder template** — a placeholder
  citation is replaced with the sources actually retrieved.
- **fix(answer): citations show the actual source file, not a bare number** —
  `[Source 5]` is expanded to `[Source 5: path]`.
- **fix(answer): never leak a value placeholder or a note-to-self** — a templated
  figure or self-instruction is stripped; the grounded partial is preferred.

### Docs

- **docs(spec): agent platform & control plane (AgentAsSoftware) design** — the
  three planes (Discovery / Supervisor / ID Server), the custody DAG, the `/ask`
  flow, lifecycle, and the locked decisions.
- **docs(spec): hard rule — all database access is API-mediated** (decision 13),
  with **ingestion recorded as a privileged ETL exception** (R5).

## 0.1.0

- Initial QMS drafting agent: deterministic recipes, rubric scoring with
  k-sampling, custody hash chain, hybrid retrieval (vectors + SQL), and the smoke
  suite.
