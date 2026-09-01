/**
 * Transport tests against a REAL local HTTP server — the header-allowlist assertion is the
 * mechanical enforcement of "the contract names every header".
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { resolveConfiguration } from "./configuration.js";
import { MAX_RESPONSE_BYTES, newTransport, parseRetryAfterSeconds } from "./transport.js";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

async function serve(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function transportFor(baseUrl: string, timeoutMs = 2_000) {
  return newTransport(
    resolveConfiguration({ key: "ffs_dev_k12345", baseUrl, httpTimeoutMs: timeoutMs }),
  );
}

describe("fetchRuleset", () => {
  test("sends exactly the contract's headers — the allowlist", async () => {
    let seen: string[] = [];
    const baseUrl = await serve((req, res) => {
      seen = Object.keys(req.headers);
      res.writeHead(200, { ETag: '"e1"' }).end("{}");
    });
    const outcome = await transportFor(baseUrl).fetchRuleset('"old"');
    expect(outcome.kind).toBe("success");
    // Transport-mechanical headers (host/connection/encoding/agent, and undici's
    // pragma/cache-control revalidation pair) are the platform's; everything else must be
    // the contract's three and nothing more.
    const allowed = new Set([
      "authorization",
      "accept",
      "if-none-match",
      "host",
      "connection",
      "accept-encoding",
      "user-agent",
      "accept-language",
      "sec-fetch-mode",
      "pragma",
      "cache-control",
    ]);
    for (const header of seen) {
      expect(allowed.has(header), `unexpected header: ${header}`).toBe(true);
    }
    expect(seen).toContain("authorization");
    expect(seen).toContain("if-none-match");
  });

  test("the URL carries sv=1 and the ETag round-trips", async () => {
    let url = "";
    let inm: string | undefined;
    const baseUrl = await serve((req, res) => {
      url = req.url ?? "";
      inm = req.headers["if-none-match"];
      res.writeHead(200, { ETag: '"e2"' }).end("{}");
    });
    const outcome = await transportFor(baseUrl).fetchRuleset('"e1"');
    expect(url).toBe("/v1/server/ruleset?sv=1");
    expect(inm).toBe('"e1"');
    expect(outcome.kind === "success" && outcome.etag).toBe('"e2"');
  });

  test("status mapping: 304, 401, 403, 429 with Retry-After, 5xx, and a refused redirect's 3xx", async () => {
    const statuses: [number, Record<string, string>, string][] = [
      [304, {}, "notModified"],
      [401, {}, "unauthorized"],
      [403, {}, "unauthorized"],
      [429, { "Retry-After": "17" }, "rateLimited"],
      [503, {}, "serverError"],
      [302, { Location: "http://evil.example/" }, "unexpectedStatus"],
      [418, {}, "unexpectedStatus"],
    ];
    for (const [status, headers, expected] of statuses) {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(status, headers).end();
      });
      const outcome = await transportFor(baseUrl).fetchRuleset("");
      expect(outcome.kind, String(status)).toBe(expected);
      if (outcome.kind === "rateLimited") {
        expect(outcome.retryAfterSeconds).toBe(17);
      }
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  test("a body over 1 MiB is refused", async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20));
    });
    const outcome = await transportFor(baseUrl).fetchRuleset("");
    expect(outcome.kind).toBe("responseTooLarge");
  });

  test("a body exactly at 1 MiB is accepted — one byte past distinguishes at from over", async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_RESPONSE_BYTES, 0x20));
    });
    const outcome = await transportFor(baseUrl).fetchRuleset("");
    expect(outcome.kind).toBe("success");
  });

  test("a hung server hits the timeout and maps to transportError", async () => {
    const baseUrl = await serve(() => {
      /* never respond */
    });
    const outcome = await transportFor(baseUrl, 200).fetchRuleset("");
    expect(outcome.kind).toBe("transportError");
  });

  test("a refused connection maps to transportError", async () => {
    const outcome = await transportFor("http://127.0.0.1:1").fetchRuleset("");
    expect(outcome.kind).toBe("transportError");
  });
});

describe("parseRetryAfterSeconds", () => {
  test("delta-seconds only; the HTTP-date form is deliberately not parsed", () => {
    expect(parseRetryAfterSeconds("17")).toBe(17);
    expect(parseRetryAfterSeconds("")).toBe(0);
    expect(parseRetryAfterSeconds("-1")).toBe(0);
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
  });
});
