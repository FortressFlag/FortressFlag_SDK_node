/**
 * Envelope verification: is this payload from FortressFlag (signature policy), about us
 * (environment), and now (issuedAt/expiresAt)? A rejection is never fatal: it means "keep
 * serving the last verified snapshot" (Founding §8.4). Rejections are enumerated in this
 * much detail because "flags stopped updating" is otherwise one of the hardest things to
 * debug in a customer's service, and the answer should be one diagnostics() read.
 */
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
    const code = checkSignature(parsed.envelope.sig, policy);
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
 * The signature PLUMBING with the crypto primitive deliberately absent (ADR-0015/0016):
 * backend M4's algorithm ADR has not shipped. A missing signature under a required policy
 * is rejected (fail closed, the shipped client-SDK posture byte for byte); the
 * `algorithm:keyID:signature` splitting and trust-store lookup are real; and a signature
 * that survives those checks is still rejected as badSignature, because no primitive
 * exists to accept it. When M4 lands, its ADR decides the primitive and this is where it
 * goes — with a real trust store, this stub can reject valid payloads but can never accept
 * a forged one. Returns null only when the (non-required) checks pass — which today never
 * happens under a required policy.
 */
function checkSignature(
  sig: string | null | undefined,
  policy: SignaturePolicy,
): RejectionCode | null {
  if (sig === undefined || sig === null || sig === "") {
    return "missingSignature";
  }
  // Split at the first two colons so a key ID may contain a colon later without a breaking
  // parse change.
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
  if (signature === "" || decodeBase64Url(signature) === null) {
    return "malformedSignature";
  }
  if (!policy.trustedKeys.has(keyId)) {
    return "unknownKeyId";
  }
  // The primitive gap, made explicit: the payload bytes are deliberately unused beyond
  // this point until M4 supplies the algorithm.
  return "badSignature";
}
