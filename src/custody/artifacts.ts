// src/custody/artifacts.ts
//
// The content-addressed artifact store (Phase 1 of the agent-topology /
// custody-DAG spec, docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// An Artifact is an immutable unit of gathered or produced data - one
// researcher's result, later an exporter's or actioner's. Its identity IS its
// content:
//
//   id = sha256( canonicalJson(artifact) )
//
// Because the id depends only on the artifact's own bytes - never on a chain
// head or a predecessor - many producers can run in PARALLEL and each computes
// its own id with zero coordination. There is no race, because there is no
// shared "previous entry". This is the git object model: content-addressed
// blobs, referenced by hash from the linear ledger (custody_events).
//
// putArtifact only ever inserts (ON CONFLICT DO NOTHING). There is no update or
// delete path here, by design - an artifact you can edit is not evidence. The
// linear custody ledger references these by hash, so altering an artifact
// changes its id and breaks the referring event.
//
// INVARIANT (from the spec): dumb role agents never touch custody. A researcher
// returns data; the ORCHESTRATOR hashes it, stores it here, and records the
// custody event. This module is called by the orchestrator, not by role agents.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "./ledger.js";
import { db } from "../db/client.js";
import { custody_artifacts } from "../db/schema.js";

export interface Artifact {
  /** Who produced it, e.g. "qms-researcher@<guid>" or "inproc:qms". */
  producer: string;
  /** The advertised capability that produced it, e.g. "research:qms". */
  capability: string;
  /** What was asked. Must be canonicalisable (plain JSON). */
  query: unknown;
  /** What came back. Must be canonicalisable (plain JSON). */
  result: unknown;
  /** ISO timestamp, supplied by the caller (the hashed core never reads a clock). */
  producedAt: string;
  /**
   * Provenance of the source, for integrity-vs-reproducibility. For a web
   * researcher: an etag / snapshot id (the result is NOT reproducible, but this
   * certifies what was retrieved and when). For RAG over a pinned corpus: the
   * corpus version (reproducible). Omitted when not applicable.
   */
  sourceRef?: string;
}

/**
 * The content address of an artifact: sha256 over its canonical JSON. Depends
 * only on the artifact's own bytes, so it is stable across processes, time, and
 * concurrent producers. `sourceRef: undefined` is dropped by canonicalJson (it
 * omits undefined-valued keys), so an artifact without a sourceRef hashes as if
 * the key were absent - matching how the ledger treats optional fields.
 */
export function artifactId(a: Artifact): string {
  return createHash("sha256").update(canonicalJson(a), "utf8").digest("hex");
}

/**
 * Store an artifact, returning its content id. Idempotent: the same content
 * writes one row (ON CONFLICT DO NOTHING on the hash primary key), so a retry or
 * a duplicate producer never creates a second row and never mutates the first.
 */
export async function putArtifact(a: Artifact): Promise<string> {
  const hash = artifactId(a);
  await db
    .insert(custody_artifacts)
    .values({ hash, capability: a.capability, producer: a.producer, body: a })
    .onConflictDoNothing({ target: custody_artifacts.hash });
  return hash;
}

/**
 * Fetch an artifact by its content id, or null if unknown. The returned body
 * recomputes to `id` under artifactId() - callers verifying a referenced hash
 * (trust-but-verify for remote producers) can assert that.
 */
export async function getArtifact(id: string): Promise<Artifact | null> {
  const rows = await db
    .select({ body: custody_artifacts.body })
    .from(custody_artifacts)
    .where(sql`${custody_artifacts.hash} = ${id}`)
    .limit(1);
  const row = rows[0];
  return row ? (row.body as Artifact) : null;
}
