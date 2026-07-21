# SPEC · Operational control plane — role agents on containers

Status: **design → build (D0 in progress)**. Supersedes the "control plane is
BUILT" claim in the 0.2.0 status table, which was true of the *components* and
false of the *end-to-end orchestration*.

## 0. The gap this closes

The [agent-platform spec](SPEC-agent-platform-and-control-plane.md) and the
[topology spec](SPEC-agent-topology-and-custody-dag.md) describe a control plane
that spawns role agents, dispatches work to them by capability, and gathers
content-addressed results. As of 0.2.0 the *parts* exist and are unit-tested — the
Supervisor's launch/reuse/TTL logic (against a **stub** launcher), Discovery
capability resolution, the manifest, the custody DAG, and the `CapabilityRegistry`
+ `runGather` gather machinery — but they are not wired together and **nothing
spawns a real agent**. `/ask` runs the LangGraph graph in the receiving process;
the Supervisor is never called; the only `Launcher` is a test stub.

This spec makes it operational: a prompt to `/ask` spawns real, isolated role
agents, dispatches units of work to them, gathers their results, and reaps them.

The seam already anticipates this. `orchestrator/capabilities.ts`: *"Today the
registry is in-process; later it resolves to a remote agent via Discovery. The
gather orchestration does not care which, because both satisfy this one
interface."* The work is to make the registry remote and the launcher real —
downstream orchestration is unchanged.

## 1. Locked decisions

1. **Role decomposition.** Agents are specialised by role — `researcher`,
   `thinker`, `exporter`, `actioner` (already the manifest's `role` enum). A role
   agent advertises only its role's capabilities and serves only work for them.
2. **Container isolation from the start.** Each agent runs in its own container
   (Colima/Docker). The `Launcher` interface abstracts this; a VM launcher could
   replace it without touching the orchestrator.
3. **One image, many roles.** A single agent image is booted with a manifest
   (`init.json`) that selects the role and its capabilities. Roles differ by
   configuration, not by image — a role agent is the monolith specialised at boot.
4. **TTL idle-sweep reaping.** Spawned agents stay warm and are reused across
   prompts (dedup by capability, the Supervisor's existing logic), and are
   destroyed after an idle TTL. Reaping calls `docker stop && docker rm`.
5. **Compute is ephemeral; evidence is durable.** A destroyed container loses only
   compute. Custody and trajectory are written through the Data Access API to
   stores outside the container (decision 13), so they survive the reap. A
   container carries **no database credentials** — only a service token.
6. **`host.docker.internal` for host services.** Postgres, Redis, and Ollama run
   on the host; Qdrant and the spawned agents run under Colima. A container reaches
   host services and the sibling services (Discovery, ID Server, the orchestrator's
   Data Access API) by env-configured URLs, defaulting to `host.docker.internal`.

## 2. The pipeline

```
/ask ─► Talk Agent (orchestrator, in the receiving process)
        │  select capability / load the recipe
        ▼
      gather ─► ensureRunning(research:qms) × N sources
        │        └─► Supervisor ─► DockerLauncher ─► docker run researcher   (×N)
        │                                             each: register in Discovery, serve /invoke
        │        dispatch a unit of work to each ─► /api/v1/capabilities/research:qms/invoke
        │        each returns {result, sourceRef}; orchestrator hashes it → content-addressed artifact
        ▼
      thinker ─► ensureRunning(think:synthesize) ─► dispatch the gathered bundle ─► synthesis
        ▼
      export / act ─► ensureRunning(export:*, act:*) as the recipe requires
        ▼
      answer (custody DAG records the whole trajectory by artifact hash)
```

The orchestrator is the **single custody writer** (topology spec). Role agents are
dumb: they take a query, return data, and never touch the chain.

## 3. Roles, capabilities, manifests

Each role is an `init.json` manifest — git-tagged by name (agent-platform spec §9)
— declaring `role`, the `capabilities` it serves, its `identity` (ID Server URL,
issuer, service-token env), permissions, and resources.

| Role | Capabilities (initial) | Does |
|---|---|---|
| researcher | `research:qms` | retrieves from the corpus + structured data for one query; returns references + values, no prose |
| thinker | `think:synthesize` | turns a gathered bundle into the answer |
| exporter | `export:md` (later `export:docx`) | renders a bound document |
| actioner | `act:<channel>` | the sole egress; gated, idempotent (already built in-process) |

Manifests live in `agents/` (git-tracked, like `rubrics/` and `derivations/`).

## 4. The container image & role-boot (D0)

A `Dockerfile` builds the agent image (Node + the built app). The entrypoint boots
from a manifest path (`QMS_MANIFEST`), which selects the role and capabilities;
the agent then:

- serves `/health` and the **capability-invocation endpoint** (§6) for its role,
- resolves every service URL from the environment (`QMS_DISCOVERY_URL`,
  `QMS_IDENTITY_URL`, `QMS_API_INTERNAL_URL` for the Data Access API,
  `QDRANT_URL`, `DATABASE_URL`, `REDIS_URL`, `OLLAMA_BASE_URL`), each defaulting to
  `host.docker.internal` where the service is on the host,
- self-registers with Discovery (the existing `discovery/register.ts`), advertising
  its GUID, git commit, address, and role capabilities.

**D0 is the unlock and the risk.** It is done when `docker run` of the image with a
researcher manifest produces a container that registers in Discovery as a
researcher and answers `/health` — proven by a smoke that runs the container and
polls Discovery. Networking (container → host services) is the hard part and is
settled here, before anything is built on top.

## 5. The launcher (D2)

`DockerLauncher implements Launcher`:

- `launch(manifest)` → allocate a host port → `docker run -d` the image with the
  manifest, a service token, and the service URLs → wait until the new agent both
  answers `/health` and appears in Discovery (the `Launcher` contract: resolve
  **only when ready**) → return `{ guid, address }`.
- `stop(guid)` → `docker stop && docker rm`, then confirm Discovery has dropped it.

Port allocation, container naming (by guid), and image tag are the launcher's
concern. The Supervisor is booted with this launcher and the role manifests.

## 6. Capability invocation — the work handoff (D1)

`POST /api/v1/capabilities/:capability/invoke` (requireAuth). Body:
`{ query, ctx: { correlationId, runId, producedAt } }`. The agent resolves the
capability to its **local** provider (the role's `inProcessRegistry`) and returns
`{ result, sourceRef }`. This is the only work interface a spawned agent exposes;
it is deliberately the `CapabilityProvider.run` shape, over HTTP.

The agent verifies the caller's JWT (the user token the orchestrator threads, for
`min(user, agent)`) and uses its own **service token** for any Data Access API
call it must make — it holds no database client (decision 13).

## 7. Remote dispatch & orchestration (D3–D4)

- **Remote provider** (`orchestrator/remote-provider.ts`): a `CapabilityProvider`
  whose `run(query, ctx)` calls `Supervisor.ensureRunning(capability)` and then
  POSTs to the resolved agent's `/invoke`, returning `{ result, sourceRef }`.
- **Remote registry** (`remoteRegistry(supervisor, token)`): resolves each
  capability to a remote provider. It satisfies `CapabilityRegistry`, so
  `runGather` and the executor use it unchanged — the whole point of §0's seam.
- **`/ask`** builds the remote registry and runs the recipe: a `gather` step fans
  out to N remote researchers (spawning as needed), the orchestrator hashes each
  result into an artifact and records `gather_complete`, the readiness gate runs,
  and the thinker (a remote agent) synthesizes. This replaces the in-process
  `agent.stream` MVP.

## 8. Lifecycle & reaping (D4)

The Supervisor's `sweepIdle` already computes which agents have passed the TTL; it
is wired to `DockerLauncher.stop`, and a sweep runs on an interval (and after each
run). A reaped agent's containers are removed; its trajectory and custody are
already durable elsewhere. `touch(guid)` on each dispatch keeps a busy agent warm.

## 9. Auth

Each role manifest names a `serviceTokenEnv`; the launcher passes that token into
the container. A spawned agent uses it to authenticate to the Data Access API (its
own reads/writes) and to Discovery registration, and verifies the **user** JWT it
is handed on `/invoke` so data access runs under `min(user, agent)`
(agent-platform spec §6). No agent holds a database credential.

## 10. Implementation sequence

- **D0 — Container image + role-boot.** Dockerfile, manifest-driven boot,
  env-driven service URLs, self-registration. Smoke: `docker run` a researcher →
  registers in Discovery, `/health` ok. *The networking is settled here.*
- **D1 — Capability-invocation endpoint.** `/capabilities/:cap/invoke` serving the
  role's providers. Smoke: invoke → data; unauth → 401.
- **D2 — DockerLauncher.** `launch`/`stop` over `docker`. Integration (Colima):
  launch → new GUID live in Discovery; stop → container removed.
- **D3 — Remote provider + registry.** Dispatch via `ensureRunning` + `/invoke`.
  Smoke: stub supervisor + fake agent — dispatches, launches once per capability.
- **D4 — Wire `/ask` + reaping.** Orchestrator runs gather → thinker → export/act
  over remote agents; Supervisor booted with the DockerLauncher + manifests; TTL
  sweep wired to `stop`.
- **D5 — The proof.** `integration:fanout`: a prompt spawns N>1 researcher
  containers (N GUIDs in Discovery), gathers N artifacts, the thinker synthesizes,
  and the containers are swept and removed after.

Each stage branches from `staging` and merges back with its tests, per the repo
workflow. Only the complete D0–D5 solution promotes to `main`.

## 11. Risks & open questions

- **Container ↔ host networking (Colima/macOS).** The recurring friction; settled
  in D0 before anything depends on it. Fallback: run the host services reachable on
  a known bridge address if `host.docker.internal` is unreliable under Colima.
- **Boot latency.** A full monolith container is multi-second to start; N per
  prompt is real latency. Mitigations, later: a slim role entrypoint (invocation
  endpoint only, no graph), and the warm TTL pool (a second prompt reuses agents).
- **Test cost & flakiness.** D2/D5 spawn real containers — slower, Colima must be
  up, and cleanup must be reliable so a failed test does not leak containers. Each
  such test tears down what it started in a `finally`.
- **Service-token provisioning.** The ID Server must mint/accept a per-role service
  token the Data Access API honours. If that path is not ready, D1/D9 may need a
  bootstrap step.
- **How many researchers per prompt.** Initially one per accessible data tier (a
  natural, bounded fan-out that makes "multiple agents" real without an unbounded
  spawn). Revisited when role manifests are authored.
