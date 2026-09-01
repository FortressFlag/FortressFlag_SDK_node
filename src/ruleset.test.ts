import { describe, expect, test } from "vitest";
import { decodeValue } from "./ruleset.js";

// The decode edges the vectors cannot reach: hostile shapes that never leave the backend
// but must still fail closed here.
describe("decodeValue", () => {
  test("absent and null are both no-value — and neither collapses to false", () => {
    expect(decodeValue(undefined, "boolean")).toEqual({ value: undefined, ok: false });
    expect(decodeValue(null, "boolean")).toEqual({ value: undefined, ok: false });
  });

  test("an explicit false is a value", () => {
    expect(decodeValue(false, "boolean")).toEqual({ value: false, ok: true });
  });

  test("a kind mismatch is no-value, not a coercion", () => {
    expect(decodeValue("true", "boolean").ok).toBe(false);
    expect(decodeValue(1, "boolean").ok).toBe(false);
    expect(decodeValue(true, "string").ok).toBe(false);
    expect(decodeValue("5", "number").ok).toBe(false);
  });

  test("an unknown kind is no-value", () => {
    expect(decodeValue(true, "datetime").ok).toBe(false);
  });

  test("a non-finite number is a hostile decode, not a value", () => {
    expect(decodeValue(Number.NaN, "number").ok).toBe(false);
    expect(decodeValue(Number.POSITIVE_INFINITY, "number").ok).toBe(false);
  });
});
