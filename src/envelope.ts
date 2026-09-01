/**
 * The wire envelope (server-contract-v1.md): the client envelope design, reused. `sig` is
 * omitted until backend M4 ships; when present it is a detached signature over the
 * payload's exact base64url bytes.
 */
import { Buffer } from "node:buffer";
import type { FlagConfig } from "./ruleset.js";

/** The sv this SDK requests and accepts. */
export const SUPPORTED_SERVER_CONTRACT_VERSION = 1;

export interface WireEnvelope {
  readonly payload: string;
  /** Absent and empty are distinguishable: undefined = omitted, "" = present but empty. */
  readonly sig: string | null | undefined;
}

/** The decoded payload document. */
export interface RulesetPayload {
  readonly sv: number;
  readonly tenant: string;
  readonly project: string;
  readonly environment: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly flags: Readonly<Record<string, FlagConfig>>;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes UNPADDED base64url strictly, or returns null. Buffer.from(s, "base64url") is
 * deliberately not trusted alone: it silently tolerates padding and some dirty input the
 * contract forbids, so a payload the Go SDK rejects would decode here — contract drift in
 * the lenient direction. The alphabet is checked first and the decoded bytes are re-encoded
 * and compared to the input; any mismatch is a rejection.
 */
export function decodeBase64Url(s: string): Uint8Array | null {
  if (s === "" || !BASE64URL.test(s)) {
    return null;
  }
  const bytes = Buffer.from(s, "base64url");
  if (bytes.toString("base64url") !== s) {
    return null;
  }
  return bytes;
}

export interface ParsedEnvelope {
  readonly envelope: WireEnvelope;
  readonly payloadBytes: Uint8Array;
}

/**
 * Splits raw bytes into the envelope and its decoded payload bytes, or returns null — a
 * body that is not an envelope is a rejection, never a crash (captive portals serve HTML
 * with a 200; the transport treats the server as hostile).
 */
export function parseEnvelope(raw: Uint8Array): ParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as { payload?: unknown; sig?: unknown };
  if (typeof candidate.payload !== "string" || candidate.payload === "") {
    return null;
  }
  if (candidate.sig !== undefined && candidate.sig !== null && typeof candidate.sig !== "string") {
    return null;
  }
  const payloadBytes = decodeBase64Url(candidate.payload);
  if (payloadBytes === null) {
    return null;
  }
  return {
    envelope: { payload: candidate.payload, sig: candidate.sig as string | null | undefined },
    payloadBytes,
  };
}

/**
 * Decodes the payload document, requiring the fields whose absence would make the binding
 * checks meaningless. Unknown fields are ignored — additive server changes ride sv=1 (the
 * contract's versioning rule), and the raw bytes are what the cache retains.
 *
 * Flag KINDS are validated here, and a payload carrying one this build does not know is
 * rejected WHOLE — the client SDKs' union-violation posture, applied to configs: the
 * contract makes a new kind an sv bump, so an unknown kind on sv=1 is corruption or
 * hostility, and under wholesale snapshot overwrite an accepted half-broken payload would
 * dislodge held values into fallbacks. Rejecting keeps the last verified state serving,
 * which is the cascade's whole point. (Value-vs-kind mismatches inside rules stay per-flag
 * fail-closed in the evaluator, the backend's own defensive posture.)
 */
export function parsePayload(payloadBytes: Uint8Array): RulesetPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadBytes).toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.environment !== "string" ||
    p.environment === "" ||
    typeof p.issuedAt !== "string" ||
    p.issuedAt === "" ||
    typeof p.expiresAt !== "string" ||
    p.expiresAt === ""
  ) {
    return null;
  }
  if (typeof p.sv !== "number") {
    return null;
  }
  const flags = p.flags ?? {};
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    return null;
  }
  for (const config of Object.values(flags as Record<string, unknown>)) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }
    const kind = (config as { kind?: unknown }).kind;
    if (kind !== "boolean" && kind !== "string" && kind !== "number") {
      return null;
    }
    const rules = (config as { rules?: unknown }).rules;
    if (!Array.isArray(rules)) {
      return null;
    }
  }
  return {
    sv: p.sv,
    tenant: typeof p.tenant === "string" ? p.tenant : "",
    project: typeof p.project === "string" ? p.project : "",
    environment: p.environment,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    flags: flags as Readonly<Record<string, FlagConfig>>,
  };
}

/** Parses the contract's RFC 3339 timestamps (fractional seconds tolerated), or null. */
export function parseWireTime(s: string): number | null {
  // Date.parse accepts far more than RFC 3339; gate the shape first so "2026-08-21" or
  // "Aug 21 2026" — which the Go SDK rejects — do not verify here.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return null;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
