/**
 * The published bucketing vectors. The JSON field is named deviceID because the backend
 * hashes device IDs; this SDK feeds its caller's context key through the same algorithm —
 * the rename happens here, keeping the vendored file verbatim. A failure here flips real
 * users between cohorts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { bucket } from "./bucket.js";

const file = JSON.parse(
  readFileSync(new URL("./vectors/buckets.json", import.meta.url), "utf8"),
) as { vectors: { deviceID: string; flagKey: string; bucket: number }[] };

describe("bucket vectors", () => {
  test("the vector file is not empty", () => {
    expect(file.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of file.vectors) {
    test(`${vector.deviceID} / ${vector.flagKey}`, () => {
      expect(bucket(vector.deviceID, vector.flagKey)).toBe(vector.bucket);
    });
  }
});
