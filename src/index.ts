/**
 * The public surface of the FortressFlag Node server SDK, enumerated in this one file (the
 * web SDK's index.ts rule) — everything else is module-internal. Backward compatibility of
 * everything exported here is sacred (Founding §8.3).
 *
 * create() is the ONE place the SDK throws (a malformed key, before anything serves).
 * After that: start() never rejects, getters never throw, close() is idempotent, and every
 * failure resolves to the caller's fallback with the reason on diagnostics().
 */
import { newTransport } from "./transport.js";
import { resolveConfiguration, type Configuration } from "./configuration.js";
import { Client } from "./client.js";

export {
  MalformedKeyError,
  signatureDisabled,
  signatureRequired,
  type Configuration,
  type SignaturePolicy,
} from "./configuration.js";
export type { Context, Diagnostics, ResolutionCounters, StartOutcome } from "./client.js";
export type { Client } from "./client.js";

/** Validates the configuration and returns a Client. Throws MalformedKeyError — the one throw. */
export function create(configuration: Configuration): Client {
  const resolved = resolveConfiguration(configuration);
  return new Client(resolved, newTransport(resolved));
}
