import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { signatureDisabled, signatureRequired } from "./configuration.js";
import { decodeBase64Url, parseWireTime } from "./envelope.js";
import { verifyEnvelope } from "./verifier.js";

const NOW_MS = Date.parse("2026-08-21T10:15:00Z");

function payloadJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function envelope(payload: Record<string, unknown>, sig?: string): Uint8Array {
  const body: Record<string, unknown> = {
    payload: Buffer.from(JSON.stringify(payload)).toString("base64url"),
  };
  if (sig !== undefined) {
    body.sig = sig;
  }
  return Buffer.from(JSON.stringify(body));
}

const EXPECT_LIVE = { environment: "dev", nowMs: NOW_MS, enforceExpiry: true };

describe("verifyEnvelope", () => {
  test("a good live envelope verifies and retains its raw bytes", () => {
    const raw = envelope(payloadJson());
    const result = verifyEnvelope(raw, signatureDisabled, EXPECT_LIVE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.raw).toBe(raw);
      expect(Object.keys(result.envelope.payload.flags)).toEqual(["dark-mode"]);
    }
  });

  test("bodies that are not envelopes reject as malformedEnvelope", () => {
    for (const raw of ["", "{", "null", "<html>portal</html>", '{"payload":""}']) {
      const result = verifyEnvelope(Buffer.from(raw), signatureDisabled, EXPECT_LIVE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("malformedEnvelope");
    }
  });

  test("a PADDED base64url payload is refused — strictness the lenient decoder would miss", () => {
    const padded = Buffer.from(JSON.stringify(payloadJson())).toString("base64url") + "==";
    const raw = Buffer.from(JSON.stringify({ payload: padded }));
    const result = verifyEnvelope(raw, signatureDisabled, EXPECT_LIVE);
    expect(result.ok).toBe(false);
  });

  test("sv other than 1 rejects whole", () => {
    const result = verifyEnvelope(
      envelope(payloadJson({ sv: 99 })),
      signatureDisabled,
      EXPECT_LIVE,
    );
    expect(!result.ok && result.code).toBe("unsupportedContractVersion");
  });

  test("environment mismatch rejects", () => {
    const result = verifyEnvelope(
      envelope(payloadJson({ environment: "prod" })),
      signatureDisabled,
      EXPECT_LIVE,
    );
    expect(!result.ok && result.code).toBe("environmentMismatch");
  });

  test("an unknown flag kind rejects the WHOLE payload", () => {
    const flags = {
      ok: { kind: "boolean", default: false, rules: [] },
      bad: { kind: "datetime", rules: [] },
    };
    const result = verifyEnvelope(envelope(payloadJson({ flags })), signatureDisabled, EXPECT_LIVE);
    expect(!result.ok && result.code).toBe("malformedPayload");
  });

  test("expired on a LIVE response rejects; the same bytes verify as a cache load", () => {
    const stale = envelope(
      payloadJson({ issuedAt: "2026-08-21T08:00:00Z", expiresAt: "2026-08-21T08:30:00Z" }),
    );
    const live = verifyEnvelope(stale, signatureDisabled, EXPECT_LIVE);
    expect(!live.ok && live.code).toBe("expired");
    const cache = verifyEnvelope(stale, signatureDisabled, {
      ...EXPECT_LIVE,
      enforceExpiry: false,
    });
    expect(cache.ok).toBe(true); // the expiry asymmetry — freshness, not validity
  });

  test("issuedAt in the future beyond skew rejects, within skew verifies", () => {
    const far = verifyEnvelope(
      envelope(payloadJson({ issuedAt: "2026-08-21T12:00:00Z" })),
      signatureDisabled,
      EXPECT_LIVE,
    );
    expect(!far.ok && far.code).toBe("issuedInTheFuture");
    const near = verifyEnvelope(
      envelope(payloadJson({ issuedAt: "2026-08-21T10:18:00Z" })),
      signatureDisabled,
      EXPECT_LIVE,
    );
    expect(near.ok).toBe(true);
  });

  test("non-RFC3339 timestamps reject — Date.parse leniency is gated", () => {
    const result = verifyEnvelope(
      envelope(payloadJson({ issuedAt: "Aug 21 2026" })),
      signatureDisabled,
      EXPECT_LIVE,
    );
    expect(!result.ok && result.code).toBe("malformedPayload");
  });

  test("every malformed signature shape rejects under a required policy, in the contract's order", () => {
    const policy = signatureRequired(new Map([["k1", new Uint8Array(32)]]));
    const cases: [string | undefined, string][] = [
      [undefined, "missingSignature"],
      ["", "missingSignature"],
      ["garbage", "malformedSignature"],
      ["ed25519:AAAA", "malformedSignature"],
      ["p256:k1:AAAA", "unsupportedSignatureAlgorithm"],
      ["ed25519:unknown:AAAA", "unknownKeyId"],
      // Well-formed, known key id, 32-byte key: the primitive runs and refuses the 3-byte
      // "signature" — the real verification path, not a stub.
      ["ed25519:k1:AAAA", "badSignature"],
    ];
    for (const [sig, expected] of cases) {
      const result = verifyEnvelope(envelope(payloadJson(), sig), policy, EXPECT_LIVE);
      expect(!result.ok && result.code, String(sig)).toBe(expected);
    }
  });
});

describe("decodeBase64Url strictness", () => {
  test("padding and dirty input are refused", () => {
    expect(decodeBase64Url("aGk=")).toBeNull();
    expect(decodeBase64Url("a Gk")).toBeNull();
    expect(decodeBase64Url("")).toBeNull();
    expect(decodeBase64Url("aGk")).not.toBeNull();
  });
});

describe("parseWireTime", () => {
  test("RFC 3339 with fractional seconds and offsets parses; loose shapes do not", () => {
    expect(parseWireTime("2026-08-21T10:00:00Z")).not.toBeNull();
    expect(parseWireTime("2026-08-21T10:00:00.123Z")).not.toBeNull();
    expect(parseWireTime("2026-08-21T10:00:00+02:00")).not.toBeNull();
    expect(parseWireTime("2026-08-21")).toBeNull();
    expect(parseWireTime("Aug 21 2026")).toBeNull();
  });
});
