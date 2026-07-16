# 07 · Custody & provenance

Two questions, deliberately separated:

- **Custody** — can you prove *what happened* and that the record wasn't altered?
- **Provenance** — does that record *outlive the agent* that produced it?

---

## 1. The hash chain

`src/custody/ledger.ts`

Append-only. Each entry hashes the previous one, so altering entry 3 invalidates
4…n. Per-domain chains. A Postgres **advisory lock** serialises appends so two
concurrent runs can't interleave and break the chain.

```ts
entry_hash = sha256(prev_hash + correlation_id + seq + event_type + payload)
```

`custody_anchors` holds **Ed25519-signed head anchors** — proof the chain wasn't
truncated and re-grown (a chain can always be rebuilt from scratch; an anchor
signed at time T proves it wasn't).

**One custody event per executed step.** The generation trajectory and the custody
chain are the same object.

```
retrieval -> retrieval -> sql_query -> generation -> retrieval -> judge -> human_decision
```

`GET /api/v1/custody/:correlationId` returns a **self-verifying dossier**: it
carries what a verifier needs to recompute every hash independently.

## 2. The correlation ID

The single key threading request → retrieval → generation → judge → persistence →
review → disposition → Langfuse trace. Crosses services via the
`x-qms-correlation-id` header. **If you add a code path, thread it.**

## 3. The external provenance sink

`src/custody/sink.ts`

**Agents are ephemeral; provenance must outlive them.** A local ledger dies with
its container. So every custody event is *mirrored* to an external Provenance API.

```ts
{ agentVersion, modelVersion, rubricHash, policyHash,
  correlationId, runId, userId, approverId, entryHash, payload, recordedAt }
```

- `QMS_PROVENANCE_API_URL` enables it; `QMS_PROVENANCE_REQUIRED=true` **halts** on
  failure (an ephemeral agent can't afford to lose events).
- **Local commit first, then mirror** — a sink failure never loses the event
  locally.
- It's an HTTP contract, so same-host vs different-host is irrelevant.

---

## 4. ⚠️ What is NOT stored — read this before making audit claims

**Custody stores references, never content.** That was deliberate: an immutable
store containing PII is a GDPR problem you cannot delete your way out of.

Here's the honest map:

| Stage | Stored | **Not stored** |
|---|---|---|
| `retrieve_sections` | `source`, `sectionIds` | **the section text** |
| `query_table` | `collection`, `rowCount`, `coverage` | **the rows the model saw** |
| `recall_prior` | `documentType`, `export`, `refCount` | the ids |
| `generate_section` | `sectionId`, `rowCount`, gap count, `findingKinds` | **the prompt**, the citation catalogue, best-of-N rejects |
| `judge` | `score`, `gatePassed`, `criticalFailures` | — (per-criterion verdicts *do* persist in `draft_documents.criterion_results`) |
| k-sampling batch | aggregated `stats` | **the raw per-run verdicts** — computed then discarded |

**Outputs are well covered.** The validated rows persist, per-criterion verdicts
*and rationales* persist, human edit deltas persist.

**The model's inputs are not in the system of record.**

### The consequence, stated plainly

**Custody proves *what happened* but cannot *reproduce* it.**

Your own diagnostic case — *"the LLM didn't retrieve a value that's in the DB"* —
**cannot be answered from the system of record**. Distinguishing "retrieved and
ignored" from "never retrieved" needs the actual retrieved context. That's why the
GUI links out to Langfuse — which means **Langfuse is currently the only place the
inputs exist**, while being:

- not hash-chained or tamper-evident
- not mirrored to the provenance sink
- outside the custody chain entirely
- on its own retention and auth (`changeme-langfuse`)
- **optional** — turn it off and the inputs exist nowhere

So `agentVersion` + `modelVersion` + `rubricHash` prove *which model and standard*
ran. They do **not** let you re-run it, because you don't have what it was shown.

### The partial mitigation that does exist

Deterministic steps are **re-derivable**: `retrieve_sections` is an exact lookup
by section id; `query_table` is a `QueryRequest`. Given the ids in custody you can
re-fetch and reconstruct — **if the corpus hasn't drifted.** For a document
approved eighteen months ago, that reconstruction is a guess, not evidence.

### Options, with trade-offs

1. **Hash the inputs into custody** (cheap, high value). Store `contextHash`,
   `promptHash`, and the citation-catalogue token list on the generation event. No
   content, no PII, chain stays clean — but an auditor can *verify* a
   reconstruction matches what actually ran. Turns "trust me" into proof.
2. **Persist the raw batch runs.** `runBatch` already computes them and throws
   them away. Free.
3. **A content-addressed input store, outside the ledger** — deletable,
   retention-governed, PII-aware; custody holds hash + pointer. Full
   reproducibility *and* a PII-free chain. The architecturally right answer, and
   real work.
4. **Decide about Langfuse.** Either it's part of the audit story (tag traces with
   the correlation id, define retention, fix auth, document that it's outside the
   chain) or it's a dev tool and (3) is the answer. Right now it's *implicitly*
   load-bearing without being designed for it — the worst of both.

**Recommended: 1 and 2 now** (small, strictly increase what you can prove), **3**
scheduled, **4** decided explicitly rather than by default.

---

## Try it

```bash
npm run smoke:custody      # chain integrity, tamper detection
npm run smoke:custody:e2e  # a full run's chain
curl localhost:4000/api/v1/custody/<correlationId> | json_pp
```

**Experiment:** run `smoke:custody`, then hand-edit one `payload` in
`custody_events` and re-verify. Watch the chain break at that entry and stay broken
for every entry after. That's the property you're buying.
