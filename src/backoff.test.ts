import { describe, expect, test } from "vitest";
import { pollDelayMs, retryDelayMs, retryDelayWithServerHintMs } from "./backoff.js";

// The injected-randomness seam: assert the BOUNDS handed to random, not a sampled value.
function capture(): { random: (low: number, high: number) => number; calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    random: (low, high) => {
      calls.push([low, high]);
      return (low + high) / 2;
    },
  };
}

describe("retryDelayMs", () => {
  test("doubles from 2s and jitters ±20%", () => {
    const { random, calls } = capture();
    expect(retryDelayMs(1, random)).toBe(2_000);
    expect(retryDelayMs(2, random)).toBe(4_000);
    expect(retryDelayMs(3, random)).toBe(8_000);
    expect(calls[0]).toEqual([1.6, 2.4]);
  });

  test("caps at 1800s — and the exponent is capped before the power", () => {
    const { random } = capture();
    expect(retryDelayMs(11, random)).toBe(1_800_000);
    expect(retryDelayMs(10_000, random)).toBe(1_800_000); // no overflow at absurd counts
  });

  test("zero failures waits zero", () => {
    const { random } = capture();
    expect(retryDelayMs(0, random)).toBe(0);
  });
});

describe("pollDelayMs", () => {
  test("jitters the SUCCESS path too — the de-synchronisation job", () => {
    const { random, calls } = capture();
    expect(pollDelayMs(60_000, random)).toBe(60_000);
    expect(calls[0]).toEqual([48, 72]); // ±20% around 60s
  });
});

describe("retryDelayWithServerHintMs", () => {
  test("a positive hint wins, uncapped hints are capped", () => {
    const { random } = capture();
    expect(retryDelayWithServerHintMs(17, 5, random)).toBe(17_000);
    expect(retryDelayWithServerHintMs(31_536_000, 1, random)).toBe(1_800_000); // a year → the cap
  });
  test("no hint falls back to the failure schedule", () => {
    const { random } = capture();
    expect(retryDelayWithServerHintMs(0, 1, random)).toBe(2_000);
  });
});
