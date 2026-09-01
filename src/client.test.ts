import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  fixtureEnvelope,
  fixturePayload,
  goodFetch,
  scriptedFetcher,
  testClient,
} from "./testsupport/fixtures.js";

const CTX = { key: "user-1", tags: { cohort: "beta" } };

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function cacheDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "ff-node-test-"));
  return tempDir;
}

describe("start", () => {
  test("ready on a live first fetch; calling start again is a pure status read", async () => {
    const fetcher = scriptedFetcher([goodFetch()]);
    const client = testClient(fetcher);
    expect(await client.start()).toBe("ready");
    const callsAfterFirst = fetcher.calls;
    expect(await client.start()).toBe("ready");
    expect(fetcher.calls).toBe(callsAfterFirst); // no second immediate fetch from start()
    client.close();
  });

  test("timed-out-serving-defaults when the network never answers and no cache exists", async () => {
    const client = testClient(scriptedFetcher([{ kind: "transportError" }]));
    expect(await client.start()).toBe("timed-out-serving-defaults");
    expect(client.bool("dark-mode", CTX, true)).toBe(true); // the fallback serves
    client.close();
  });

  test("cache-only when the file answers and the network does not — expiry long past", async () => {
    const path = join(await cacheDir(), "cache.json");
    // Written 2h before the fixture clock; expiresAt long past. The cache-load half of the
    // expiry asymmetry accepts it.
    const stale = fixtureEnvelope(
      fixturePayload({ issuedAt: "2026-08-21T07:00:00Z", expiresAt: "2026-08-21T07:30:00Z" }),
    );
    await writeFile(path, stale);
    const client = testClient(scriptedFetcher([{ kind: "transportError" }]), {
      cachePath: path,
    });
    expect(await client.start()).toBe("cache-only");
    expect(client.bool("dark-mode", CTX, false)).toBe(true);
    expect(client.diagnostics().snapshotSource).toBe("cache");
    client.close();
  });
});

describe("record", () => {
  test("a rejected envelope never dislodges the snapshot", async () => {
    const hostile = fixtureEnvelope(fixturePayload({ environment: "prod" }));
    const client = testClient(
      scriptedFetcher([goodFetch(), { kind: "success", raw: hostile, etag: '"e2"' }]),
    );
    await client.start();
    expect(client.bool("dark-mode", CTX, false)).toBe(true);
    await client.pollOnce(); // the hostile poll
    expect(client.bool("dark-mode", CTX, false)).toBe(true); // held value survives
    const diagnostics = client.diagnostics();
    expect(diagnostics.lastFetchStatus).toBe("rejectedEnvelope");
    expect(diagnostics.lastRejection).toBe("environmentMismatch");
    expect(diagnostics.etag).toBe('"e1"'); // the rejected response's etag was NOT adopted
    client.close();
  });

  test("a revoked key keeps serving — unauthorized counts failures, holds the snapshot", async () => {
    const client = testClient(scriptedFetcher([goodFetch(), { kind: "unauthorized" }]));
    await client.start();
    await client.pollOnce();
    await client.pollOnce();
    expect(client.bool("dark-mode", CTX, false)).toBe(true);
    const diagnostics = client.diagnostics();
    expect(diagnostics.lastFetchStatus).toBe("unauthorized");
    expect(diagnostics.consecutiveFailures).toBe(2);
    client.close();
  });

  test("wholesale overwrite: a flag that leaves the payload leaves the snapshot", async () => {
    const second = fixtureEnvelope(
      fixturePayload({
        flags: { "checkout-cta": { kind: "string", default: "buy-now", rules: [] } },
      }),
    );
    const client = testClient(
      scriptedFetcher([goodFetch(), { kind: "success", raw: second, etag: '"e2"' }]),
    );
    await client.start();
    expect(client.bool("dark-mode", CTX, false)).toBe(true);
    await client.pollOnce();
    expect(client.bool("dark-mode", CTX, false)).toBe(false); // archived → fallback
    expect(client.diagnostics().resolutions.fallbackUnknownFlag).toBe(1);
    client.close();
  });

  test("304 resets the failure count", async () => {
    const client = testClient(
      scriptedFetcher([goodFetch(), { kind: "serverError", status: 500 }, { kind: "notModified" }]),
    );
    await client.start();
    await client.pollOnce();
    expect(client.diagnostics().consecutiveFailures).toBe(1);
    await client.pollOnce();
    expect(client.diagnostics().consecutiveFailures).toBe(0);
    expect(client.diagnostics().lastFetchStatus).toBe("notModified");
    client.close();
  });
});

describe("getters", () => {
  test("kind mismatch answers the fallback and counts it — never a throw", async () => {
    const client = testClient(scriptedFetcher([goodFetch()]));
    await client.start();
    expect(client.bool("checkout-cta", CTX, true)).toBe(true); // string flag asked as bool
    expect(client.string("dark-mode", CTX, "x")).toBe("x");
    expect(client.number("dark-mode", CTX, 7)).toBe(7);
    const resolutions = client.diagnostics().resolutions;
    expect(resolutions.fallbackKindMismatch).toBe(3);
    client.close();
  });

  test("diagnostics carries no key in any form", async () => {
    const client = testClient(scriptedFetcher([goodFetch()]));
    await client.start();
    expect(JSON.stringify(client.diagnostics())).not.toContain("ffs_");
    client.close();
  });
});

describe("cache", () => {
  test("a fresh fetch writes the file verbatim with mode 0600, and a kill-and-reload serves it", async () => {
    const path = join(await cacheDir(), "cache.json");
    const fetch1 = goodFetch();
    const client = testClient(scriptedFetcher([fetch1]), { cachePath: path });
    await client.start();
    expect(client.diagnostics().cacheState).toBe("stored");
    const written = await readFile(path);
    expect(Buffer.from(written)).toEqual(
      Buffer.from(fetch1.kind === "success" ? fetch1.raw : new Uint8Array()),
    );
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    client.close();

    // The "restarted process": a new client, network down, same path.
    const reborn = testClient(scriptedFetcher([{ kind: "transportError" }]), { cachePath: path });
    expect(await reborn.start()).toBe("cache-only");
    expect(reborn.bool("dark-mode", CTX, false)).toBe(true);
    reborn.close();
  });

  test("a corrupt cache file degrades to loadFailed, never a throw", async () => {
    const path = join(await cacheDir(), "cache.json");
    await writeFile(path, "not-an-envelope");
    const client = testClient(scriptedFetcher([{ kind: "transportError" }]), { cachePath: path });
    expect(await client.start()).toBe("timed-out-serving-defaults");
    expect(client.diagnostics().cacheState).toBe("loadFailed");
    client.close();
  });
});
