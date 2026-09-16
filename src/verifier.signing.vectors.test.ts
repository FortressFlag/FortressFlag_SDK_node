/**
 * The published signature vectors (backend ADR-0025), fed to THIS SDK's verifier as the
 * exact envelope bytes — never re-serialised — plus cases built at test time with a fresh
 * key. A failure in the vector half is a wire-contract bug, never a test to fix
 * (src/vectors/README.md).
 */
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { signatureDisabled, signatureRequired } from "./configuration.js";
import { verifyEnvelope, type RejectionCode } from "./verifier.js";

interface VectorEntry {
  readonly name: string;
  readonly envelope: string;
  readonly code?: RejectionCode;
}

const file = JSON.parse(
  readFileSync(new URL("./vectors/signing.json", import.meta.url), "utf8"),
) as {
  keyId: string;
  publicKey: string;
  accept: VectorEntry[];
  reject: VectorEntry[];
};

// The vector payloads expire in 2099 and are issued 2026-09-16; any "now" between verifies.
const VECTOR_NOW_MS = Date.parse("2026-09-16T12:00:00Z");
const vectorPolicy = signatureRequired(
  new Map([[file.keyId, Buffer.from(file.publicKey, "base64url")]]),
);

describe("signing vectors", () => {
  test("the file carries a 32-byte key and no private material", () => {
    expect(Buffer.from(file.publicKey, "base64url")).toHaveLength(32);
    expect(file.accept.length).toBeGreaterThan(0);
    expect(file.reject.length).toBeGreaterThan(0);
  });

  for (const entry of file.accept) {
    // This is a SERVER SDK: the client-plane vector ("v" instead of "sv") is expected to
    // pass the signature and fail the payload parse — the signature check comes first, so
    // the code proves the signature verified. Both must never be badSignature.
    test(`accept: ${entry.name}`, () => {
      const raw = Buffer.from(entry.envelope, "base64url");
      const result = verifyEnvelope(raw, vectorPolicy, {
        environment: "prod",
        nowMs: VECTOR_NOW_MS,
        enforceExpiry: true,
      });
      if (entry.name.startsWith("server-")) {
        expect(result.ok, entry.name).toBe(true);
        if (result.ok) {
          expect(result.envelope.raw).toBe(raw);
          expect(Object.keys(result.envelope.payload.flags).sort()).toEqual([
            "checkout-cta",
            "dark-mode",
            "max-items",
          ]);
        }
      } else {
        expect(!result.ok && result.code, entry.name).toBe("malformedPayload");
      }
    });
  }

  for (const entry of file.reject) {
    test(`reject: ${entry.name} → ${entry.code}`, () => {
      const result = verifyEnvelope(Buffer.from(entry.envelope, "base64url"), vectorPolicy, {
        environment: "prod",
        nowMs: VECTOR_NOW_MS,
        enforceExpiry: true,
      });
      expect(!result.ok && result.code).toBe(entry.code);
    });
  }
});

function signedEnvelope(
  payload: Record<string, unknown>,
  keyId: string,
  privateKey: Parameters<typeof sign>[2],
  tamper?: (payloadJson: string) => string,
): Uint8Array {
  const honest = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(honest), privateKey);
  const sent = tamper === undefined ? honest : tamper(honest);
  return Buffer.from(
    JSON.stringify({
      payload: Buffer.from(sent).toString("base64url"),
      sig: `ed25519:${keyId}:${signature.toString("base64url")}`,
    }),
  );
}

function rawPublicKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): Uint8Array {
  const spki = (publicKey as { export(o: { type: "spki"; format: "der" }): Buffer }).export({
    type: "spki",
    format: "der",
  });
  return spki.subarray(spki.length - 32);
}

describe("verification with a freshly generated key", () => {
  const NOW_MS = Date.parse("2026-09-16T10:15:00Z");
  const payload = {
    sv: 1,
    tenant: "t",
    project: "default",
    environment: "dev",
    issuedAt: "2026-09-16T10:00:00Z",
    expiresAt: "2026-09-16T10:30:00Z",
    flags: { "dark-mode": { kind: "boolean", default: true, rules: [] } },
  };
  const expect_ = { environment: "dev", nowMs: NOW_MS, enforceExpiry: true };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const policy = signatureRequired(new Map([["fresh-k1", rawPublicKey(publicKey)]]));

  test("a fresh signature verifies", () => {
    const result = verifyEnvelope(signedEnvelope(payload, "fresh-k1", privateKey), policy, expect_);
    expect(result.ok).toBe(true);
  });

  test("one flipped flag after signing → badSignature", () => {
    const raw = signedEnvelope(payload, "fresh-k1", privateKey, (json) =>
      json.replace('"default":true', '"default":false'),
    );
    const result = verifyEnvelope(raw, policy, expect_);
    expect(!result.ok && result.code).toBe("badSignature");
  });

  test("a key id absent from the trust store → unknownKeyId", () => {
    const result = verifyEnvelope(signedEnvelope(payload, "fresh-k9", privateKey), policy, expect_);
    expect(!result.ok && result.code).toBe("unknownKeyId");
  });

  test("the right key id but a different key → badSignature", () => {
    const result = verifyEnvelope(
      signedEnvelope(payload, "fresh-k1", other.privateKey),
      policy,
      expect_,
    );
    expect(!result.ok && result.code).toBe("badSignature");
  });

  test("a trusted key of the wrong length → unknownKeyId, not a throw", () => {
    const short = signatureRequired(new Map([["fresh-k1", new Uint8Array(31)]]));
    const result = verifyEnvelope(signedEnvelope(payload, "fresh-k1", privateKey), short, expect_);
    expect(!result.ok && result.code).toBe("unknownKeyId");
  });

  test("disabled accepts an unsigned envelope; required refuses it", () => {
    const unsigned = Buffer.from(
      JSON.stringify({ payload: Buffer.from(JSON.stringify(payload)).toString("base64url") }),
    );
    expect(verifyEnvelope(unsigned, signatureDisabled, expect_).ok).toBe(true);
    const required = verifyEnvelope(unsigned, policy, expect_);
    expect(!required.ok && required.code).toBe("missingSignature");
  });
});
