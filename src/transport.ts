/**
 * The transport: one GET, treated as talking to a potentially hostile network. The three
 * rules every FortressFlag SDK transport carries (ports of the Android/web/Go rules):
 *
 *   - An explicit per-request timeout (AbortSignal.timeout) — fetch has NONE by default,
 *     and a hung server would park the poller forever.
 *   - Redirects are refused (`redirect: "manual"`) — following one could replay the
 *     Authorization header, which carries a genuine secret, to wherever it points. A 3xx
 *     surfaces as an unexpected status, exactly the Go SDK's shape.
 *   - The response body is capped at 1 MiB, read incrementally — a hostile or broken
 *     server must not balloon this process's memory. Real payloads are kilobytes.
 */
import { Buffer } from "node:buffer";
import { SUPPORTED_SERVER_CONTRACT_VERSION } from "./envelope.js";
import type { ResolvedConfiguration } from "./configuration.js";

/** Bounds a response body. Shared with the cache's load bound. */
export const MAX_RESPONSE_BYTES = 1 << 20;

export type FetchOutcome =
  | { readonly kind: "success"; readonly raw: Uint8Array; readonly etag: string }
  | { readonly kind: "notModified" } // 304 — a success: the cached ruleset is current
  | { readonly kind: "unauthorized" } // 401/403 — revoked or wrong key; keep serving
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds: number } // 429
  | { readonly kind: "serverError"; readonly status: number } // 5xx
  | { readonly kind: "unexpectedStatus"; readonly status: number } // incl. a refused redirect's 3xx
  | { readonly kind: "transportError" } // dial/timeout/abort — the network itself failed
  | { readonly kind: "responseTooLarge" };

export interface Transport {
  fetchRuleset(etag: string): Promise<FetchOutcome>;
}

export function newTransport(configuration: ResolvedConfiguration): Transport {
  const url = `${configuration.baseUrl}/v1/server/ruleset?sv=${SUPPORTED_SERVER_CONTRACT_VERSION}`;
  return {
    /**
     * One conditional GET of the ruleset export — exactly the request the contract shows,
     * no more: Authorization, Accept, If-None-Match. There is no SDK-version header and no
     * telemetry; an undocumented header would be an additive contract change that goes
     * through an ADR (ADR-0016).
     */
    async fetchRuleset(etag: string): Promise<FetchOutcome> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${configuration.key}`,
        Accept: "application/json",
      };
      if (etag !== "") {
        headers["If-None-Match"] = etag;
      }
      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(configuration.httpTimeoutMs),
        });
      } catch {
        // Timeout, refused connection, DNS failure — the snapshot keeps serving either way.
        return { kind: "transportError" };
      }

      if (response.status === 304) {
        await drain(response);
        return { kind: "notModified" };
      }
      if (response.status === 200) {
        return readCapped(response);
      }
      await drain(response);
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized" };
      }
      if (response.status === 429) {
        return {
          kind: "rateLimited",
          retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("Retry-After") ?? ""),
        };
      }
      if (response.status >= 500) {
        return { kind: "serverError", status: response.status };
      }
      return { kind: "unexpectedStatus", status: response.status };
    },
  };
}

/**
 * Reads the body incrementally, refusing past the cap — one byte past, to distinguish
 * "exactly at the cap" from "over it". An unconsumed body keeps undici's socket occupied
 * (and can keep the process alive), so every path either reads or cancels.
 */
async function readCapped(response: Response): Promise<FetchOutcome> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { kind: "transportError" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { kind: "responseTooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "transportError" };
  }
  return {
    kind: "success",
    raw: Buffer.concat(chunks),
    etag: response.headers.get("ETag") ?? "",
  };
}

async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Draining is best-effort; a failure here changes nothing the caller does.
  }
}

/**
 * Reads Retry-After as delta-seconds ONLY. The HTTP-date form is deliberately not parsed
 * (the Android/web rule): date parsing against a wrong local clock can produce an enormous
 * delay, and the backoff caps whatever this returns anyway.
 */
export function parseRetryAfterSeconds(header: string): number {
  if (header === "" || !/^\d+$/.test(header)) {
    return 0;
  }
  const seconds = Number(header);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0;
}
