# 01 · Security

Four independent layers. None of them trusts the LLM, and none of them trusts the
GUI. Each is defending against a different failure.

| Layer | Question it answers | Where |
|---|---|---|
| Authentication | who are you? | `src/api/auth/`, `idserver/` |
| Authorisation (role) | what may you *do*? | `src/tiers.ts` |
| Access labels | what may you *see*? | `src/identity/` |
| SQL barriers | can a query escape its bounds? | `src/data/query-builder.ts` |

---

## 1. Login and JWT

Login happens at the **ID Server** (`:3001`), which issues an HS256 JWT the
**Agent** (`:4000`) verifies with a **shared secret**.

```
POST {IDSERVER}/v1/login   { userId, password }
  -> { token, userId, role, expiresIn }   // bcrypt compare, constant-time-ish
```

Passwords are bcrypt hashes in the ID Server's directory. The login path runs a
compare even for an unknown user so a missing account and a wrong password take
similar time — **no user enumeration by timing**.

The exact token contract is in [`../AUTH_CONTRACT.md`](../AUTH_CONTRACT.md).
Summary: `alg HS256`, `iss qms-agent`, `sub` is the **user id string** (not a
UUID), `role` claim, 8h expiry.

### The lesson worth internalising

Four separate seams between the two services each produced an identical, silent
**401**: issuer mismatch, `sub` vs UUID, an empty users table, and a mismatched
service token. JWT libraries collapse "bad signature", "wrong issuer", and
"expired" into one generic failure — so **a cross-service token contract must be
written down**, not discovered. That's why `AUTH_CONTRACT.md` exists.

### Consequence of `QMS_IDENTITY_MODE=http`

The Agent **trusts the token's claims** — it does not re-look-up the user or
re-read the role. This is correct (it's the point of externalising identity) but
it means:

1. **The signature is the only gate.** `JWT_SECRET` is the most sensitive value
   in the stack.
2. **Revocation lives at the token layer only.** You *cannot* disable a user by
   editing the Agent's DB. A leaked token is valid until expiry (up to 8h).
   Shorten expiry or add a deny-list if that window is unacceptable.

---

## 2. Roles and permissions

```ts
export type Role = "engineer" | "reviewer" | "admin" | "service";
```

Roles are **what you may do**; tiers/labels are **what you may see**. They are
deliberately separate so `engineer` and `reviewer` can share a data tier while
differing in authority — engineer drafts, reviewer approves.

`"*"` in permissions means all permissions (admin only). Key permissions:

| Permission | Gates |
|---|---|
| `draft:view-any` | the review queue, reading committed rubrics |
| `draft:approve` | dispositioning a draft — **and the approver must not be the author** |
| `rubric:edit` | rubric draft CRUD + k-sampling batches |

**Approver ≠ author is enforced server-side.** The independent check *is* the
control; a UI cannot bypass it.

---

## 3. Access labels — security tags derived from documents

The chain is:

```
document -> declared classification -> canonical classification -> labels
```

A document declares its own classification (e.g. Metadata sheet:
`Classification: "Stonefield Semiconductors — Internal"`). `src/identity/classification.ts`
maps that **by exact match, never fuzzy** to a canonical classification, which
grants labels like `engineering:internal`.

Three decisions worth understanding:

**Ingestion fails on an unrecognised classification.** It does not default to
"public", and it does not default to "secret" and hide the document. It **stops**,
because a silently mis-labelled document is worse than a failed ingest.

**An unclassified document is unreachable.** Retrieval filters on `access_labels`,
so a chunk without labels matches nothing. Fail-closed by construction rather than
by a check someone can forget.

**Labels are domain-scoped.** A test caught a real bug: an `admin` group granting
`quality:internal` *inside the engineering domain*. Groups are now domain-specific
(`eng-admin` grants only engineering labels). **No cross-domain bleed.** The fix
was in the policy data, not the code — which is the right place for it.

### Entitlement resolution

`GET {IDSERVER}/v1/entitlements?subject=&domain=` → `{ labels, policyVersion, policyHash, decisionId }`

Resolved **per request**, so revocation is immediate. 404 (unknown subject) = deny.
No domain membership = empty labels = nothing granted.

### ⚠️ Enforcement is currently OFF

`QMS_ENFORCE_LABELS` defaults to **false**. The labels are computed, stored, and
carried — but not enforced on every path yet. **Before flipping it on:**

- `src/api/routes/data.ts` — **the biggest hole**: three routes disclose data and
  `table_registry.access_labels` exists but no route reads it.
- `smoke:hybrid` fixture writes a blurb with no labels.
- Preflight `is_empty=0`.
- Langfuse hardening (see below).

---

## 4. The five SQL barriers

The LLM **never writes SQL**. It produces a JSON `QueryRequest`; the builder
produces SQL. This is not a stylistic preference — it makes whole attack classes
structurally impossible.

```ts
// src/data/query-builder.ts
//   - Column names are whitelisted against the table's registered schema.
//   - Values are ALWAYS bound as parameters ($1, $2), never concatenated.
//   - The physical table name comes from the registry (a UUID), never user input.
//   - LIMIT is capped server-side regardless of what the caller requests.
export const MAX_LIMIT = 500;
```

| # | Barrier | Effect |
|---|---|---|
| 1 | Column allowlist from the registered schema | a hallucinated column is rejected before SQL exists |
| 2 | Parameterised values (`$1, $2, …`) | **SQL injection via values is structurally impossible** |
| 3 | Physical table name from the registry UUID | the model cannot name a table |
| 4 | `LIMIT` capped server-side (`MAX_LIMIT = 500`) | no unbounded scans |
| 5 | Read-only connection pool | **⚠️ INACTIVE — `POSTGRES_READONLY_USER` unset** |

Barrier 5 warns on every run. It's the one that stops a compromised query path
from *writing*. Close it before this is anything real.

The builder is **pure** — `(schema, request) => { sql, params }` — so it's fully
testable without a database (`npm run smoke:dataplane`).

---

## 5. Known security debt (tracked, not forgotten)

| Item | Risk |
|---|---|
| `JWT_SECRET` is a dev value | it is the *single* gate in http mode |
| `change-me-service-token` | gates entitlement disclosure (who may see what) |
| `POSTGRES_READONLY_USER` unset | SQL barrier 5 inactive |
| Qdrant has **no API key** | derived store, unauthenticated |
| Langfuse `changeme-langfuse` | **holds the actual prompts and retrieved context** |
| `QMS_ENFORCE_LABELS=false` | labels computed but not enforced |

**The real PII exposure is the derived stores, not the domain.** Names *are* PII
and attribution *is* the deliverable — so do **not** pseudonymise inside the
domain; it breaks traceability. Domain permissions gate PII. But Qdrant (no auth)
and Langfuse (shared password) contain the same content with none of the controls.
