import { describe, expect, test } from "vitest";
import { MalformedKeyError, keyPrefix, parseKey, resolveConfiguration } from "./configuration.js";

describe("parseKey", () => {
  test("a secret containing underscores parses — the split-limit trap", () => {
    // String.split(sep, 3) would TRUNCATE this key's secret; indexOf parsing keeps it.
    expect(parseKey("ffs_dev_abc_def_ghi")).toBe("dev");
  });

  test("well-formed keys parse to their environment", () => {
    expect(parseKey("ffs_prod_k12345")).toBe("prod");
    expect(parseKey("ffs_my-env_secret")).toBe("my-env");
  });

  test("malformed keys are refused", () => {
    for (const key of [
      "",
      "ffs",
      "ffs_dev",
      "ffs_dev_",
      "ffc_dev_k",
      "ffs_D_k",
      "ffs_a_k",
      "ffs_-ab_k",
      "ffs_ab-_k",
    ]) {
      expect(parseKey(key), key).toBeNull();
    }
  });
});

describe("keyPrefix", () => {
  test("six visible characters, the only loggable form", () => {
    expect(keyPrefix("ffs_dev_abcdefghij")).toBe("ffs_dev_abcdef");
  });
  test("empty for malformed or too-short keys", () => {
    expect(keyPrefix("nonsense")).toBe("");
    expect(keyPrefix("ffs_dev_abc")).toBe("");
  });
});

describe("resolveConfiguration", () => {
  test("the one throw path — and the message never echoes the key", () => {
    let thrown: unknown;
    try {
      resolveConfiguration({ key: "hunter2-the-actual-secret" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedKeyError);
    expect(String(thrown)).not.toContain("hunter2");
  });

  test("defaults and the poll floor", () => {
    const resolved = resolveConfiguration({ key: "ffs_dev_k12345", pollIntervalMs: 5_000 });
    expect(resolved.baseUrl).toBe("https://edge.fortressflag.com");
    expect(resolved.pollIntervalMs).toBe(30_000); // floored at the contract's 30s
    expect(resolved.httpTimeoutMs).toBe(10_000);
    expect(resolved.environment).toBe("dev");
  });

  test("a trailing slash on baseUrl is trimmed", () => {
    expect(resolveConfiguration({ key: "ffs_dev_k12345", baseUrl: "http://x/" }).baseUrl).toBe(
      "http://x",
    );
  });
});
