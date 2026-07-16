# 09 · Services & discovery

Four services. The separation is about **validation scope and lifecycle**, not
deployment — they all run on one Mac.

```
  Agents (many)            ID Server            Discovery            GUI
  :4000+                   :3001                :3005                :5173
  generation, rubrics,     identity,            agent registry,      thin client
  custody, review          tokens,              health, git-id       (NOT BUILT)
                           entitlements
     │                         ▲                    ▲                    │
     ├── verify token ─────────┘                    │                    │
     ├── register + heartbeat ──────────────────────┤                    │
     │                                              └──list agents───────┤
     └──────────────── rubric/review work (direct, after resolve) ───────┘
```

## Why separate

**Validation scope.** A frontend's CVE surface and release cadence must not
re-trigger revalidation of the agent that touches controlled data.

**Identity ≠ discovery.** "Who are you and what may you see" and "where are the
agents and are they alive" are unrelated concerns with different lifecycles.

**The GUI is the least stable thing in the system** (a browser tab). Nothing
durable may depend on it — see §2.

---

## 1. Auth — see [`../AUTH_CONTRACT.md`](../AUTH_CONTRACT.md)

Summary: HS256, shared `JWT_SECRET`, `iss: qms-agent`, `sub` = user id **string**,
8h expiry. Covered in [01-security.md](01-security.md).

---

## 2. Discovery — the multi-agent model

`discovery/src/registry.ts`

### The flaw in the obvious design (rejected)

"Agents push status to the GUI" **inverts the dependency**: stable, long-lived
services would depend on an ephemeral browser tab with no stable address, closed
and reopened at will, possibly several at once.

So a **registry is the stable fixed point**. Agents push to *it*; the GUI
subscribes to *it*. Neither knows the other's address.

### The three identities — this is the core idea

```
guid      = this RUNNING INSTANCE (unique per process). The lease is on this.
gitCommit = which CODEBASE it runs. MANY guids can share one commit.
address   = a LEASE, not an identity — refreshed by heartbeat.
```

**The GUI stores GUIDs, never addresses.** An agent whose IP changed re-registers
the *same guid* with a new address; the GUI asks Discovery to resolve
`guid → current address`.

**Multiple agents can run the same git source.** They're distinct instances with
distinct GUIDs — and **rubrics are per-agent**, so editing agent A's rubric
doesn't touch agent B's, even on the same commit. Its git flow decides when it
picks up changes.

### The Agent Card

Borrowed **in shape** from A2A's Agent Card. Not A2A itself.

```json
{ "guid": "agt_037e923c…", "name": "Production DFMEA",
  "gitCommit": "ec7182b9073a…",          // the exact codebase, advertised
  "address": "http://localhost:4000",
  "observabilityUrl": "http://localhost:3000",   // this agent's Langfuse
  "capabilities": [], "health": "healthy",
  "lastSeen": "…", "registeredAt": "…" }
```

### Design decisions

| Decision | Why |
|---|---|
| **Phone book, not proxy** | Discovery tells you the number; it doesn't relay the call. The GUI calls the agent **directly** — that's where the rubric lives and where custody/validation are enforced. |
| **In-memory soft state** | Discovery restarts → next heartbeat 404s `{reregister:true}` → agents re-attach within one lease. Nothing durable to lose; the durable record is custody, elsewhere. |
| **Registration is non-fatal** | Discovery down → the agent still serves, just unlisted. |
| **The GUID is persisted** (`identity/agent-guid.txt`) | a restarted agent keeps its identity *and its rubric drafts*, rather than appearing as a stranger. |
| **`now` is injectable** | lease expiry is deterministically testable. A registry whose expiry can't be tested is one you can't trust. |

### On A2A and MCP

- **MCP — no.** It's a *tool-calling* protocol: what an agent can do for a caller,
  not where agents are or whether they're alive. Registration/health/git-id isn't
  its job.
- **A2A — closer, not a drop-in.** Its Agent Card is a good *model* for the
  payload (borrowed). But A2A assumes agents find each other; it gives no central
  registry with health leases. Building fifty lines and owning them beats adopting
  a spec for a problem it doesn't solve.
- **Where they'd earn a place:** agent-to-agent delegation. That's their domain.

---

## 3. The Langfuse link

`observabilityUrl` is per-agent in the Agent Card, so the GUI can deep-link a
reviewer to *that agent's* Langfuse, filtered to the run:

```
{agent.observabilityUrl}/…?filter=correlationId:{draft.correlationId}
```

**Why:** reviewers need to see *why* something failed — whether a value was
retrieved-and-ignored or **never retrieved**. Only the trace answers that.

⚠️ Two caveats: the trace **must be tagged with the correlation id** or the link
can't filter to the run; and Langfuse has **its own auth** — the link is a hand-off
to another system, not an embedded view. Don't proxy it through the GUI. See
[07](07-custody-provenance.md) for why Langfuse is currently load-bearing in a way
it wasn't designed for.

---

## 4. Running the stack

`stack.sh` (at `~/projects/`) owns all service processes via a pid dir.

```bash
./stack.sh start|stop|restart|status|logs [agent|idserver|discovery]
```

Two things it does that a naive script gets wrong:

**Kills the whole process group.** `npm run` spawns `tsx` → `node`; killing the
shell orphans the real listener on the port, and the next start fails with "port
in use".

**Resolves nvm's npm.** A non-interactive subshell never sources `~/.zshrc`, so
nvm's PATH additions are absent and `npm` is "not found".

`status` also probes ports with `lsof` and marks `running*` for a process it
didn't start — catching the zombie-holding-the-port case.

### Ports

| Service | Port |
|---|---|
| Agent | **4000** (`API_PORT`) |
| ID Server | 3001 |
| Discovery | 3005 |
| GUI (planned) | 5173 |
| Langfuse | 3000 |
| Qdrant | 6333 |

---

## Try it

```bash
./stack.sh start && ./stack.sh status
cd discovery && ./scripts/live-check.sh          # did the agent register?
cd idserver  && ./scripts/handshake.sh dmaher <pw>  # do agent+idserver trust each other?
```

**Experiment:** start a second agent on `API_PORT=4001` with a different
`QMS_AGENT_NAME`, and watch both appear in `GET :3005/v1/agents` with the same
`gitCommit` and different GUIDs. That's the multi-agent model in one command.
