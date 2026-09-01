/**
 * The published evaluation vectors, run through THIS SDK's production decoder and
 * evaluator — the whole point of publishing them in the export's wire shape. A failure
 * here is a wire-contract bug, never a test to fix (src/vectors/README.md).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { evaluateFlag } from "./evaluate.js";
import type { FlagConfig } from "./ruleset.js";

interface Vector {
  readonly name: string;
  readonly flag: FlagConfig;
  readonly input: {
    readonly contextKey: string;
    readonly flagKey: string;
    readonly tags: Record<string, string>;
  };
  readonly expected: { readonly value?: unknown; readonly noValue?: boolean };
}

const file = JSON.parse(
  readFileSync(new URL("./vectors/evaluation.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

describe("evaluation vectors", () => {
  test("the vector file is not empty", () => {
    expect(file.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of file.vectors) {
    test(vector.name, () => {
      const result = evaluateFlag(
        vector.flag,
        vector.input.tags,
        vector.input.contextKey,
        vector.input.flagKey,
      );
      if (vector.expected.noValue) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        expect(result.value).toBe(vector.expected.value);
      }
    });
  }
});
