/**
 * Places one context in [0, 100) for one flag's percentage rollout (ADR-0008, published in
 * contract-v2.md and pinned by vectors/buckets.json):
 *
 *   uint64_be(SHA-256(contextKey + ":" + flagKey)[0..8]) mod 100
 *
 * The contextKey is EXACTLY the opaque identifier string the caller gave this SDK — a user
 * id, a session id, the customer's choice — never validated, trimmed or normalised: the
 * backend hashes a device ID the same way, and any deviation from "hash exactly the bytes
 * given" flips cohorts between components evaluating for the same person. The hash input
 * is the UTF-8 bytes of the concatenation — createHash().update(string) encodes UTF-8,
 * which is the contract's byte sequence; any other encoding flips buckets. Nothing is
 * stored: a bucket is recomputed per evaluation. The ":" + flagKey suffix makes buckets
 * per-flag (a 10% rollout is not always the same unlucky 10%) and sticky.
 */
import { createHash } from "node:crypto";

export function bucket(contextKey: string, flagKey: string): number {
  const digest = createHash("sha256").update(`${contextKey}:${flagKey}`, "utf8").digest();
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return Number(view.getBigUint64(0, false) % 100n);
}
