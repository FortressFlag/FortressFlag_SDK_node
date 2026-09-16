/**
 * Configuration and the key rules. The ffs_ server key IS A GENUINE SECRET
 * (server-contract-v1, ADR-0015): the SDK holds it in memory, sends it only on the
 * Authorization header, and the only form of it that may ever reach a log line is
 * keyPrefix's six-character prefix.
 */

import { Buffer } from "node:buffer";

/** How the SDK treats the envelope's signature — see signatureDisabled/signatureRequired. */
export interface SignaturePolicy {
  readonly required: boolean;
  readonly trustedKeys: ReadonlyMap<string, Uint8Array>;
}

/**
 * The raw 32-byte Ed25519 public keys FortressFlag signs production rulesets with, by key
 * id (backend ADR-0025). Rotation adds key N+1 here before the backend switches to it, so
 * rotation is a release of this constant, never an emergency. Each hex literal is the same
 * bytes as the base64url form in its comment; check one against the other by eye.
 */
export const FORTRESSFLAG_PRODUCTION: ReadonlyMap<string, Uint8Array> = new Map<string, Uint8Array>(
  [
    [
      "prod-2026-09-k1",
      // ADR-0025, minted 2026-09-16: base64url EaEF8MHNu3onHxemTg3-OcrKrq7ODsZIVEp-IVV2ojg
      Buffer.from("11a105f0c1cdbb7a271f17a64e0dfe39cacaaeaece0ec648544a7e215576a238", "hex"),
    ],
  ],
);

/**
 * Accepts unsigned envelopes. The explicit opt-out for local development against a backend
 * that has no signing key configured (it then omits `sig`) — a named, greppable value rather
 * than a silent fallback, so "why is this not verifying?" has an answer in the customer's
 * source. Never the default: production rulesets are signed (ADR-0025).
 */
export const signatureDisabled: SignaturePolicy = Object.freeze({
  required: false,
  trustedKeys: new Map<string, Uint8Array>(),
});

/**
 * Rejects every envelope whose signature cannot be verified against trustedKeys. The
 * default is signatureRequired(FORTRESSFLAG_PRODUCTION); a staging deployment passes the
 * staging key explicitly. Rejection is never fatal — the SDK keeps serving its last
 * verified snapshot. The map and each key's bytes are copied.
 */
export function signatureRequired(trustedKeys: ReadonlyMap<string, Uint8Array>): SignaturePolicy {
  const copied = new Map<string, Uint8Array>();
  for (const [id, key] of trustedKeys) {
    copied.set(id, Uint8Array.from(key));
  }
  return Object.freeze({ required: true, trustedKeys: copied });
}

/** Everything the SDK needs to run. Handed to create; treated as immutable. */
export interface Configuration {
  /**
   * The ffs_ server key. THIS IS A GENUINE SECRET: it can download the full ruleset,
   * targeting rules included. Store it in an environment variable or a secret manager,
   * never in code, never in a repository, never in a log.
   */
  readonly key: string;
  /** The server data plane's base URL. Defaults to FortressFlag's edge. */
  readonly baseUrl?: string;
  /**
   * How often to poll, in milliseconds. Defaults to 60 000 — one request per minute per
   * process, so a kill switch reaches a fleet within a minute — floored at the contract's
   * 30 000 (ADR-0016). ±20% jitter is applied so a fleet does not synchronise.
   */
  readonly pollIntervalMs?: number;
  /**
   * Opts in to a durable cache: a file where the last VERIFIED envelope's raw bytes
   * persist. Unset — the default — means in-memory only: where a server process may write
   * is the operator's call, and this SDK writes nothing unasked (ADR-0016). The file holds
   * only the ruleset envelope, never the key and never any evaluation context.
   */
  readonly cachePath?: string;
  /**
   * Signature policy. Defaults to signatureRequired(FORTRESSFLAG_PRODUCTION) — fail closed
   * against FortressFlag's production key. Pass signatureDisabled only for a local backend
   * that serves unsigned rulesets.
   */
  readonly signature?: SignaturePolicy;
  /**
   * Per-request timeout in milliseconds. Short on purpose: a slow ruleset fetch must never
   * become the customer's problem — the snapshot keeps answering. Defaults to 10 000.
   */
  readonly httpTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://edge.fortressflag.com";
/** The contract's floor. Faster is volunteering to be rate-limited for unchanged values. */
const MINIMUM_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * The configured value is not shaped like an ffs_ server key. Thrown by create — the ONE
 * place this SDK throws, at construction, before the customer's process serves anything
 * (Founding §8.1). The message deliberately never echoes the configured value: a mistyped
 * secret pasted into the wrong field must not land in an error string that lands in a log.
 */
export class MalformedKeyError extends Error {
  constructor() {
    super("fortressflag: key is not of the form ffs_<environment>_<secret>");
    this.name = "MalformedKeyError";
  }
}

/**
 * Validates the configured key's shape and returns the environment it claims, or null.
 *
 * indexOf-based, NOT String.split — the backend serverkey comment, ported a fourth time,
 * because in JavaScript the bug has a second layer: the secret is base64url, whose alphabet
 * includes `_`, so a split must keep the remainder — and `String.split(sep, limit)`
 * TRUNCATES instead of keeping it: "ffs_dev_a_b".split("_", 3) is ["ffs","dev","a"], the
 * "_b" silently gone. Roughly three keys in four contain an underscore in the secret; the
 * failure is silent, fleet-wide and intermittent, and a happy-path key tested by hand would
 * not have contained one.
 */
export function parseKey(raw: string): string | null {
  const first = raw.indexOf("_");
  if (first < 0 || raw.slice(0, first) !== "ffs") {
    return null;
  }
  const second = raw.indexOf("_", first + 1);
  if (second < 0 || second + 1 >= raw.length) {
    return null;
  }
  const environment = raw.slice(first + 1, second);
  return validEnvironmentKey(environment) ? environment : null;
}

/**
 * Enforces the server's environments_key_format CHECK (2–32 chars, lowercase letters,
 * digits and hyphens, starting and ending with a letter or digit). A value that could never
 * name an environment on any tenant is refused at construction rather than carried into a
 * runtime "flags silently never load".
 */
function validEnvironmentKey(key: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(key) && key.length >= 2;
}

/**
 * Six characters of the random part: enough to tell two keys apart in a log line, far too
 * few to guess the rest (the backend's serverkey.PrefixOf rule).
 */
const KEY_PREFIX_VISIBLE_CHARS = 6;

/**
 * The non-secret leading part of the key — THE ONLY FORM OF A SERVER KEY THAT MAY EVER BE
 * LOGGED (ADR-0015, ported). Empty for a malformed key.
 */
export function keyPrefix(raw: string): string {
  const environment = parseKey(raw);
  if (environment === null) {
    return "";
  }
  const head = "ffs_".length + environment.length + 1;
  if (raw.length < head + KEY_PREFIX_VISIBLE_CHARS) {
    return "";
  }
  return raw.slice(0, head + KEY_PREFIX_VISIBLE_CHARS);
}

/** Configuration with every default applied and the key parsed — what the SDK runs on. */
export interface ResolvedConfiguration {
  readonly key: string;
  readonly environment: string;
  readonly baseUrl: string;
  readonly pollIntervalMs: number;
  readonly cachePath: string;
  readonly signature: SignaturePolicy;
  readonly httpTimeoutMs: number;
}

/** Validates and applies defaults. The one throw path in the SDK. */
export function resolveConfiguration(configuration: Configuration): ResolvedConfiguration {
  const environment = parseKey(configuration.key);
  if (environment === null) {
    throw new MalformedKeyError();
  }
  let baseUrl = configuration.baseUrl ?? DEFAULT_BASE_URL;
  baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  let pollIntervalMs = configuration.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (pollIntervalMs < MINIMUM_POLL_INTERVAL_MS) {
    pollIntervalMs = MINIMUM_POLL_INTERVAL_MS;
  }
  const httpTimeoutMs =
    configuration.httpTimeoutMs === undefined || configuration.httpTimeoutMs <= 0
      ? DEFAULT_HTTP_TIMEOUT_MS
      : configuration.httpTimeoutMs;

  return {
    key: configuration.key,
    environment,
    baseUrl,
    pollIntervalMs,
    cachePath: configuration.cachePath ?? "",
    signature: configuration.signature ?? signatureRequired(FORTRESSFLAG_PRODUCTION),
    httpTimeoutMs,
  };
}
