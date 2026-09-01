/**
 * The suite that proves the one thing this SDK actually promises: flagging can fail in any
 * way at all, and the customer's process neither crashes nor sees an error. Every other
 * test checks that a specific thing works; these check that nothing breaks when everything
 * is wrong at once. Ported from the Go SDK's chaos suite.
 *
 * JavaScript's single thread is what Go needed -race for: there is no torn read to detect,
 * so the concurrent-getters variant becomes an interleaved loop — hostile swaps with
 * getter assertions between every one, which is the same invariant minus the scheduler.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { signatureRequired } from "./configuration.js";
import { resolveConfiguration } from "./configuration.js";
import { Client } from "./client.js";
import type { FetchOutcome, Transport } from "./transport.js";
import {
  FIXTURE_NOW_MS,
  fixtureEnvelope,
  fixturePayload,
  goodFetch,
  testClient,
} from "./testsupport/fixtures.js";

const CTX = { key: "user-1", tags: { cohort: "beta" } };

/** Every way the world can be wrong, in four groups (the Go suite's table). */
function hostileOutcomes(): [string, FetchOutcome][] {
  const bodies: [string, Uint8Array][] = [
    ["empty body", new Uint8Array()],
    ["captive portal", Buffer.from("<html>please log in</html>")],
    ["truncated JSON", Buffer.from("{")],
    ["JSON null", Buffer.from("null")],
    ["zero bytes", new Uint8Array(4096)],
    ["wrong environment", fixtureEnvelope(fixturePayload({ environment: "prod" }))],
    ["unsupported sv", fixtureEnvelope(fixturePayload({ sv: 99 }))],
    [
      "expired live payload — the replay window",
      fixtureEnvelope(
        fixturePayload({ issuedAt: "2026-08-21T08:00:00Z", expiresAt: "2026-08-21T08:30:00Z" }),
      ),
    ],
    [
      "issuedAt in the future",
      fixtureEnvelope(fixturePayload({ issuedAt: "2026-08-21T12:00:00Z" })),
    ],
    ["truncated envelope", fixtureEnvelope(fixturePayload()).slice(0, 20)],
    [
      "rules is not a list",
      fixtureEnvelope(fixturePayload({ flags: { x: { kind: "boolean", rules: "not-a-list" } } })),
    ],
    ["flags is not a map", fixtureEnvelope(fixturePayload({ flags: "not-a-map" }))],
    [
      "unknown flag kind — whole-payload rejection",
      fixtureEnvelope(fixturePayload({ flags: { x: { kind: "datetime", rules: [] } } })),
    ],
  ];
  const outcomes: [string, FetchOutcome][] = bodies.map(([name, raw]) => [
    name,
    { kind: "success", raw, etag: '"hostile"' },
  ]);
  outcomes.push(
    ["transport error", { kind: "transportError" }],
    ["unauthorized", { kind: "unauthorized" }],
    ["rate limited", { kind: "rateLimited", retryAfterSeconds: 0 }],
    ["rate limited for a year", { kind: "rateLimited", retryAfterSeconds: 31_536_000 }],
    ["server error 500", { kind: "serverError", status: 500 }],
    ["server error 503", { kind: "serverError", status: 503 }],
    ["teapot", { kind: "unexpectedStatus", status: 418 }],
    ["bad request — an sv the server does not speak", { kind: "unexpectedStatus", status: 400 }],
    ["response too large", { kind: "responseTooLarge" }],
    ["304 with nothing necessarily cached behind it", { kind: "notModified" }],
  );
  return outcomes;
}

/** A fetcher whose next outcome the test chooses per call. */
function pushFetcher(): Transport & { next: FetchOutcome } {
  const fetcher = {
    next: { kind: "transportError" } as FetchOutcome,
    fetchRuleset(): Promise<FetchOutcome> {
      return Promise.resolve(fetcher.next);
    },
  };
  return fetcher;
}

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("chaos", () => {
  test("a client holding a good value never loses it — and the cache file is never touched by hostility", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ff-chaos-"));
    const path = join(tempDir, "cache.json");
    const fetcher = pushFetcher();
    fetcher.next = goodFetch();
    const client = testClient(fetcher, { cachePath: path });
    expect(await client.start()).toBe("ready");
    const cachedBefore = await readFile(path);

    for (const [name, outcome] of hostileOutcomes()) {
      fetcher.next = outcome;
      await client.pollOnce();
      expect(client.bool("dark-mode", CTX, false), name).toBe(true);
      expect(client.string("checkout-cta", CTX, "fallback"), name).toBe("buy-now");
    }
    const cachedAfter = await readFile(path);
    expect(
      Buffer.compare(cachedBefore, cachedAfter),
      "hostile outcomes reached the cache file",
    ).toBe(0);
    client.close();
  });

  test("a cold client answers fallbacks forever without breaking", async () => {
    const fetcher = pushFetcher();
    const client = testClient(fetcher);
    for (const [name, outcome] of hostileOutcomes()) {
      fetcher.next = outcome;
      await client.pollOnce();
      expect(client.bool("dark-mode", CTX, false), name).toBe(false);
      expect(client.number("retry-limit", CTX, 7), name).toBe(7);
    }
    client.close();
  });

  test("under a required signature policy, every signature shape rejects — including the well-formed one", async () => {
    const resolved = resolveConfiguration({
      key: "ffs_dev_k",
      signature: signatureRequired(new Map([["k1", new Uint8Array(32)]])),
    });
    const fetcher = pushFetcher();
    const client = new Client(resolved, fetcher, {
      nowMs: () => FIXTURE_NOW_MS,
      random: (low, high) => (low + high) / 2,
    });
    for (const sig of [
      "",
      "garbage",
      "ed25519:AAAA",
      "p256:k1:AAAA",
      "ed25519:unknown:AAAA",
      "ed25519:k1:AAAA",
    ]) {
      fetcher.next = { kind: "success", raw: fixtureEnvelope(fixturePayload(), sig), etag: '"s"' };
      await client.pollOnce();
      const diagnostics = client.diagnostics();
      expect(diagnostics.lastFetchStatus, sig).toBe("rejectedEnvelope");
      expect(diagnostics.flagCount, sig).toBe(0);
    }
    client.close();
  });

  test("interleaved hostile and good swaps: getters observe held values at every step, 50 cycles", async () => {
    const fetcher = pushFetcher();
    fetcher.next = goodFetch();
    const client = testClient(fetcher);
    await client.start();
    for (let cycle = 0; cycle < 50; cycle++) {
      for (const [name, outcome] of hostileOutcomes()) {
        fetcher.next = outcome;
        await client.pollOnce();
        expect(client.bool("dark-mode", CTX, false), `${name} (cycle ${cycle})`).toBe(true);
        client.diagnostics(); // must never throw mid-hostility
      }
      fetcher.next = goodFetch();
      await client.pollOnce();
      expect(client.bool("dark-mode", CTX, false)).toBe(true);
    }
    client.close();
  });

  test("a poisoned cache file cannot smuggle a snapshot past verification", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ff-chaos-"));
    const path = join(tempDir, "cache.json");
    await writeFile(path, fixtureEnvelope(fixturePayload({ environment: "prod" })));
    const fetcher = pushFetcher();
    const client = testClient(fetcher, { cachePath: path });
    expect(await client.start()).toBe("timed-out-serving-defaults");
    expect(client.diagnostics().cacheState).toBe("loadFailed");
    client.close();
  });
});
