// src/custody/anchor.ts
//
// External anchoring. A local hash chain proves INTERNAL consistency only -
// whoever controls the process can recompute the whole thing from a forged
// genesis. Anchoring publishes the current head hash to something held OFF
// this host, so forging the chain later also requires forging a dated,
// external anchor.
//
// Three methods, in increasing independence:
//   signature  - sign the head with a key held off the agent host
//   rfc3161    - a trusted timestamp authority countersigns the head + time
//   external   - append the head to a store with separate credentials
//
// Only the signature method is implemented here (it needs no third party).
// The others are seams: the proof column takes any token, and verification is
// a matter of checking the proof against the head it attests to.

import { createSign, createVerify } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { custody_events, custody_anchors } from "../db/schema.js";
import { currentDomain } from "../identity/index.js";

/**
 * Anchor the current head of this domain's ledger by signing it with a private
 * key. The key MUST live off the agent host (an HSM, a separate service, an
 * operator's control) - a signing key on the same box the attacker controls
 * anchors nothing.
 */
export async function anchorHead(privateKeyPem: string): Promise<{
  headSeq: number;
  headHash: string;
} | null> {
  const domain = currentDomain();

  const headRows = await db
    .select({ seq: custody_events.seq, entry_hash: custody_events.entry_hash })
    .from(custody_events)
    .where(sql`${custody_events.domain} = ${domain}`)
    .orderBy(sql`${custody_events.seq} DESC`)
    .limit(1);

  if (headRows.length === 0) return null;
  const { seq, entry_hash } = headRows[0];

  const signer = createSign("SHA256");
  signer.update(`${domain}:${seq}:${entry_hash}`);
  signer.end();
  const proof = signer.sign(privateKeyPem, "base64");

  await db.insert(custody_anchors).values({
    domain,
    head_seq: seq,
    head_hash: entry_hash,
    method: "signature",
    proof,
  });

  return { headSeq: seq, headHash: entry_hash };
}

/** Verify a signature anchor against the head it claims to attest. */
export function verifyAnchorSignature(
  domain: string,
  headSeq: number,
  headHash: string,
  proof: string,
  publicKeyPem: string,
): boolean {
  const verifier = createVerify("SHA256");
  verifier.update(`${domain}:${headSeq}:${headHash}`);
  verifier.end();
  try {
    return verifier.verify(publicKeyPem, proof, "base64");
  } catch {
    return false;
  }
}