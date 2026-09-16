/**
 * Envelope verification: is this payload from FortressFlag (signature policy), about us
 * (environment), and now (issuedAt/expiresAt)? A rejection is never fatal: it means "keep
 * serving the last verified snapshot" (Founding §8.4). Rejections are enumerated in this
 * much detail because "flags stopped updating" is otherwise one of the hardest things to
 * debug in a customer's service, and the answer should be one diagnostics() read.
 */
import { Buffer } from "node:buffer";
import { verify as verifyEd25519 } from "node:crypto";
import { decodeBase64Url, parseEnvelope, parsePayload, parseWireTime } from "./envelope.js";
import { SUPPORTED_SERVER_CONTRACT_VERSION, type RulesetPayload } from "./envelope.js";
import type { SignaturePolicy } from "./configuration.js";

/** Why an envelope was not accepted. */
export type RejectionCode =
  | "malformedEnvelope"
  | "missingSignature"
  | "malformedSignature"
  | "unsupportedSignatureAlgorithm"
  | "unknownKeyId"
  | "badSignature"
  | "malformedPayload"
  | "unsupportedContractVersion"
  | "environmentMismatch"
  | "expired"
  | "issuedInTheFuture";

/**
 * An envelope that passed every check, kept alongside the exact bytes it arrived as. `raw`
 * is retained so the cache stores what was (or will one day be) signed rather than a
 * re-serialisation of what we parsed — re-serialising would silently strip any field a
 * future server adds and break the signature on reload (the web verifier's rule, ported).
 */
export interface VerifiedEnvelope {
  readonly raw: Uint8Array;
  readonly payload: RulesetPayload;
}

/** What the payload must claim to be, for it to be about us. */
export interface Expectations {
  readonly environment: string;
  readonly nowMs: number;
  /**
   * TRUE for a live response, FALSE when loading the cachePath file — and that asymmetry
   * is the single most load-bearing rule in this SDK. On a live response, expiry is the
   * replay window: without it, anyone who captured a valid response could serve it back
   * forever, pinning a fleet to old flag values. On a cache load it must NOT apply: the
   * last verified snapshot is the primary fallback, and a service that restarts after a
   * long outage keeps evaluating with what it last saw. Enforcing expiry there would
   * silently revert every flag to caller defaults after any 30-minute outage plus one
   * restart — turning an outage into a feature regression, which is precisely the failure
   * the cascade exists to prevent. Expiry governs freshness, not validity.
   */
  readonly enforceExpiry: boolean;
}

/**
 * Forgives a wrong server-or-host clock. Machines drift; a host an hour fast should not
 * lose flag updates — but 300 s is the ceiling on how far issuedAt may sit in the future
 * before the payload is refused.
 */
const CLOCK_SKEW_TOLERANCE_MS = 300_000;

export type VerifyResult =
  | { readonly ok: true; readonly envelope: VerifiedEnvelope }
  | { readonly ok: false; readonly code: RejectionCode };

/** Runs every check in the contract's order and reports the outcome. */
export function verifyEnvelope(
  raw: Uint8Array,
  policy: SignaturePolicy,
  expect: Expectations,
): VerifyResult {
  const parsed = parseEnvelope(raw);
  if (parsed === null) {
    return { ok: false, code: "malformedEnvelope" };
  }

  if (policy.required) {
    const code = checkSignature(parsed.envelope.sig, parsed.payloadBytes, policy);
    if (code !== null) {
      return { ok: false, code };
    }
  }

  const payload = parsePayload(parsed.payloadBytes);
  if (payload === null) {
    return { ok: false, code: "malformedPayload" };
  }

  if (payload.sv !== SUPPORTED_SERVER_CONTRACT_VERSION) {
    // A version this build does not speak might mean anything; refusing to guess is the
    // contract's own instruction.
    return { ok: false, code: "unsupportedContractVersion" };
  }
  if (payload.environment !== expect.environment) {
    // A production payload replayed at a dev process (or vice versa) is refused even
    // though the key, not the payload, chose the scope: the two claims must agree.
    return { ok: false, code: "environmentMismatch" };
  }

  const issuedAtMs = parseWireTime(payload.issuedAt);
  if (issuedAtMs === null) {
    return { ok: false, code: "malformedPayload" };
  }
  const expiresAtMs = parseWireTime(payload.expiresAt);
  if (expiresAtMs === null) {
    return { ok: false, code: "malformedPayload" };
  }
  if (issuedAtMs - expect.nowMs > CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, code: "issuedInTheFuture" };
  }
  if (expect.enforceExpiry && expect.nowMs - expiresAtMs > CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, code: "expired" };
  }

  return { ok: true, envelope: { raw, payload } };
}

/**
 * The DER SubjectPublicKeyInfo prefix for an Ed25519 key: node:crypto has no raw-key
 * import, so the contract's raw 32 bytes are wrapped here (contract-v1 §Signing keys).
 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PUBLIC_KEY_LENGTH = 32;

/**
 * Pure Ed25519 over the exact payload bytes (ADR-0025): `algorithm:keyID:signature`,
 * split at the first two colons, trust-store lookup by key id, then node:crypto's verify
 * with the raw key SPKI-wrapped. A trusted key that is not 32 bytes or that the platform
 * refuses to import is reported as unknownKeyId — "cannot verify with this key" rather
 * than a hard failure, so one bad entry cannot disable a rotation set (the iOS rule).
 * Returns null when the signature verifies.
 */
function checkSignature(
  sig: string | null | undefined,
  payloadBytes: Uint8Array,
  policy: SignaturePolicy,
): RejectionCode | null {
  if (sig === undefined || sig === null || sig === "") {
    return "missingSignature";
  }
  // Split at the first two colons: the SIGNATURE may contain further colons, the key id
  // never can (the backend refuses a key id with one — contract-v1 §Signing keys).
  const first = sig.indexOf(":");
  const second = first >= 0 ? sig.indexOf(":", first + 1) : -1;
  if (first < 0 || second < 0) {
    return "malformedSignature";
  }
  const algorithm = sig.slice(0, first);
  const keyId = sig.slice(first + 1, second);
  const signature = sig.slice(second + 1);
  if (algorithm !== "ed25519") {
    return "unsupportedSignatureAlgorithm";
  }
  const signatureBytes = signature === "" ? null : decodeBase64Url(signature);
  if (signatureBytes === null) {
    return "malformedSignature";
  }
  const key = policy.trustedKeys.get(keyId);
  if (key === undefined || key.length !== ED25519_PUBLIC_KEY_LENGTH) {
    return "unknownKeyId";
  }
  let valid: boolean;
  try {
    valid = verifyEd25519(
      null,
      payloadBytes,
      { key: Buffer.concat([SPKI_ED25519_PREFIX, key]), format: "der", type: "spki" },
      signatureBytes,
    );
  } catch {
    // The platform refused the key itself (not a valid curve point): our trust store, not
    // the payload, is at fault.
    return "unknownKeyId";
  }
  return valid ? null : "badSignature";
}
