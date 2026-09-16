/**
 * Shared test fixtures: the fixed clock, the payload/envelope builders, and the scripted
 * fetcher. The key is short and low-entropy on purpose (CLAUDE.md §3); the clock is fixed
 * so expiry tests assert instants, not races.
 */
import { Buffer } from "node:buffer";
import { resolveConfiguration, signatureDisabled, type Configuration } from "../configuration.js";
import { Client } from "../client.js";
import type { FetchOutcome, Transport } from "../transport.js";

export const FIXTURE_NOW_MS = Date.parse("2026-08-21T10:15:00Z");

export function fixturePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sv: 1,
    tenant: "t",
    project: "default",
    environment: "dev",
    issuedAt: "2026-08-21T10:00:00Z",
    expiresAt: "2026-08-21T10:30:00Z",
    flags: {
      "dark-mode": {
        kind: "boolean",
        default: false,
        rules: [{ conditions: [{ tagKey: "cohort", operator: "eq", value: "beta" }], serve: true }],
      },
      "checkout-cta": { kind: "string", default: "buy-now", rules: [] },
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base;
}

export function fixtureEnvelope(payload: Record<string, unknown>, sig?: string): Uint8Array {
  const body: Record<string, unknown> = {
    payload: Buffer.from(JSON.stringify(payload)).toString("base64url"),
  };
  if (sig !== undefined) {
    body.sig = sig;
  }
  return Buffer.from(JSON.stringify(body));
}

export function goodFetch(): FetchOutcome {
  return { kind: "success", raw: fixtureEnvelope(fixturePayload()), etag: '"e1"' };
}

/** Plays outcomes in order, then repeats the last forever. */
export function scriptedFetcher(outcomes: FetchOutcome[]): Transport & { calls: number } {
  const fetcher = {
    calls: 0,
    fetchRuleset(): Promise<FetchOutcome> {
      const outcome = outcomes[Math.min(fetcher.calls, outcomes.length - 1)];
      fetcher.calls++;
      if (outcome === undefined) {
        throw new Error("scriptedFetcher: no outcomes");
      }
      return Promise.resolve(outcome);
    },
  };
  return fetcher;
}

export function testClient(fetcher: Transport, configuration: Partial<Configuration> = {}): Client {
  // The fixtures serve unsigned envelopes, so the policy is the explicit local-dev opt-out
  // (the production default is signatureRequired(FORTRESSFLAG_PRODUCTION)).
  const resolved = resolveConfiguration({
    key: "ffs_dev_k",
    signature: signatureDisabled,
    ...configuration,
  });
  return new Client(resolved, fetcher, {
    nowMs: () => FIXTURE_NOW_MS,
    random: (low, high) => (low + high) / 2,
  });
}
