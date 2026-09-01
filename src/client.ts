/**
 * The client core: one unref'd-timer poll loop feeding a snapshot the getters read
 * synchronously. After create, nothing in here throws or rejects — every failure becomes
 * backoff plus a diagnostics note while the last snapshot keeps answering (Founding
 * §8.1/§8.4). JavaScript's single thread is what Go needed atomic.Pointer for: the
 * snapshot swap is a plain assignment, and getters never observe a torn state.
 */
import { pollDelayMs, retryDelayWithServerHintMs, type RandomInRange } from "./backoff.js";
import { newFileCache, type FileCache } from "./cache.js";
import type { ResolvedConfiguration } from "./configuration.js";
import { parseWireTime } from "./envelope.js";
import { evaluateFlag } from "./evaluate.js";
import type { FlagConfig } from "./ruleset.js";
import type { FetchOutcome, Transport } from "./transport.js";
import { verifyEnvelope, type RejectionCode, type VerifiedEnvelope } from "./verifier.js";

/** The outcome start() resolves with. Never a rejection. */
export type StartOutcome = "ready" | "cache-only" | "timed-out-serving-defaults";

/** One evaluation's context: the opaque identifier the bucket hashes, plus targeting tags. */
export interface Context {
  readonly key: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ResolutionCounters {
  readonly served: number;
  readonly fallbackNoSnapshot: number;
  readonly fallbackUnknownFlag: number;
  readonly fallbackKindMismatch: number;
  readonly fallbackNoValue: number;
}

/**
 * The one-line answer to "why are flags not updating?". Contains no secrets — the key
 * appears in no form, not even its prefix.
 */
export interface Diagnostics {
  readonly lastFetchAt: Date | null;
  readonly lastFetchStatus: string;
  readonly lastRejection: string;
  readonly etag: string;
  readonly consecutiveFailures: number;
  readonly snapshotIssuedAt: Date | null;
  readonly snapshotSource: "network" | "cache" | "";
  readonly flagCount: number;
  readonly cacheState: string;
  readonly resolutions: ResolutionCounters;
}

interface Snapshot {
  readonly flags: Readonly<Record<string, FlagConfig>>;
  readonly issuedAtMs: number | null;
  readonly fromCache: boolean;
}

function snapshotOf(envelope: VerifiedEnvelope, fromCache: boolean): Snapshot {
  return {
    flags: envelope.payload.flags,
    issuedAtMs: parseWireTime(envelope.payload.issuedAt),
    fromCache,
  };
}

/** A promise plus its resolver — Go's close(channel), in promise form. */
function gate(): { promise: Promise<void>; open: () => void; opened: () => boolean } {
  let openFlag = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    promise,
    open: () => {
      openFlag = true;
      resolve();
    },
    opened: () => openFlag,
  };
}

export class Client {
  private readonly configuration: ResolvedConfiguration;
  private readonly fetcher: Transport;
  private readonly cache: FileCache | null;

  private snapshot: Snapshot | null = null;

  private lastFetchAtMs: number | null = null;
  private lastFetchStatus = "neverFetched";
  private lastRejection: RejectionCode | "" = "";
  private etag = "";
  private consecutiveFailures = 0;
  private cacheState: string;

  private served = 0;
  private fallbackNoSnapshot = 0;
  private fallbackUnknownFlag = 0;
  private fallbackKindMismatch = 0;
  private fallbackNoValue = 0;

  private readonly firstAttempt = gate();
  private readonly networkReady = gate();

  private started = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  /** Injected for tests; create() uses the real clock and Math.random. */
  readonly nowMs: () => number;
  readonly random: RandomInRange;

  constructor(
    configuration: ResolvedConfiguration,
    fetcher: Transport,
    seams?: { nowMs?: () => number; random?: RandomInRange },
  ) {
    this.configuration = configuration;
    this.fetcher = fetcher;
    this.cache = configuration.cachePath !== "" ? newFileCache(configuration.cachePath) : null;
    this.cacheState = this.cache === null ? "disabled" : "empty";
    this.nowMs = seams?.nowMs ?? Date.now;
    this.random =
      seams?.random ?? ((low, high) => (low >= high ? low : low + Math.random() * (high - low)));
  }

  /**
   * Loads the cache if configured, launches the poll loop, and resolves when the first
   * fetch attempt completes or the signal aborts. Never rejects: the worst outcome is
   * "serving fallbacks until the network appears", stated in the StartOutcome. Calling
   * start again reports the current state without side effects.
   */
  async start(signal?: AbortSignal): Promise<StartOutcome> {
    if (!this.started) {
      this.started = true;
      await this.loadCache();
      void this.pollOnce();
    }

    const races: Promise<void>[] = [this.networkReady.promise, this.firstAttempt.promise];
    if (signal !== undefined) {
      races.push(
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
    }
    await Promise.race(races);

    if (this.networkReady.opened()) {
      return "ready";
    }
    if (this.snapshot !== null && this.snapshot.fromCache) {
      return "cache-only";
    }
    return this.networkReady.opened() ? "ready" : "timed-out-serving-defaults";
  }

  /**
   * Stops the poll loop. Idempotent, and safe before start. An in-flight fetch settles on
   * its own timeout and is discarded; nothing new is scheduled.
   */
  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  bool(flagKey: string, evaluation: Context, fallback: boolean): boolean {
    const [value, ok] = this.value(flagKey, evaluation, "boolean");
    return ok && typeof value === "boolean" ? value : fallback;
  }

  string(flagKey: string, evaluation: Context, fallback: string): string {
    const [value, ok] = this.value(flagKey, evaluation, "string");
    return ok && typeof value === "string" ? value : fallback;
  }

  number(flagKey: string, evaluation: Context, fallback: number): number {
    const [value, ok] = this.value(flagKey, evaluation, "number");
    return ok && typeof value === "number" ? value : fallback;
  }

  diagnostics(): Diagnostics {
    const snapshot = this.snapshot;
    return {
      lastFetchAt: this.lastFetchAtMs === null ? null : new Date(this.lastFetchAtMs),
      lastFetchStatus: this.lastFetchStatus,
      lastRejection: this.lastRejection,
      etag: this.etag,
      consecutiveFailures: this.consecutiveFailures,
      snapshotIssuedAt:
        snapshot === null || snapshot.issuedAtMs === null ? null : new Date(snapshot.issuedAtMs),
      snapshotSource: snapshot === null ? "" : snapshot.fromCache ? "cache" : "network",
      flagCount: snapshot === null ? 0 : Object.keys(snapshot.flags).length,
      cacheState: this.cacheState,
      resolutions: {
        served: this.served,
        fallbackNoSnapshot: this.fallbackNoSnapshot,
        fallbackUnknownFlag: this.fallbackUnknownFlag,
        fallbackKindMismatch: this.fallbackKindMismatch,
        fallbackNoValue: this.fallbackNoValue,
      },
    };
  }

  private async loadCache(): Promise<void> {
    if (this.cache === null) {
      return;
    }
    const raw = await this.cache.load();
    if (raw === null) {
      return;
    }
    // Expiry deliberately unenforced: this is THE cache-load half of the contract's expiry
    // asymmetry — a service that restarts after a long outage keeps evaluating with what
    // it last saw. See Expectations.enforceExpiry.
    const result = verifyEnvelope(raw, this.configuration.signature, {
      environment: this.configuration.environment,
      nowMs: this.nowMs(),
      enforceExpiry: false,
    });
    if (!result.ok) {
      this.cacheState = "loadFailed";
      return;
    }
    this.cacheState = "loaded";
    this.snapshot = snapshotOf(result.envelope, true);
  }

  /** One poll, then self-schedule on an unref'd timer. Test seam: pollOnce is awaitable. */
  async pollOnce(): Promise<void> {
    const outcome = await this.fetcher.fetchRuleset(this.etag);
    if (this.closed) {
      this.firstAttempt.open();
      return;
    }
    await this.record(outcome);
    this.firstAttempt.open();

    const delayMs =
      this.consecutiveFailures === 0
        ? pollDelayMs(this.configuration.pollIntervalMs, this.random)
        : retryDelayWithServerHintMs(
            outcome.kind === "rateLimited" ? outcome.retryAfterSeconds : 0,
            this.consecutiveFailures,
            this.random,
          );

    if (this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.pollOnce();
    }, delayMs);
    // A flag SDK must never keep the customer's process alive after their code finishes
    // (ADR-0018). Load-bearing, not tidiness: without unref, every script embedding this
    // SDK hangs on exit until close() — and the ones that forget close() hang forever.
    this.timer.unref();
  }

  /** Turns one fetch outcome into snapshot/cache/diagnostics updates — the ONLY mutation site. */
  private async record(outcome: FetchOutcome): Promise<void> {
    this.lastFetchAtMs = this.nowMs();
    switch (outcome.kind) {
      case "success": {
        const result = verifyEnvelope(outcome.raw, this.configuration.signature, {
          environment: this.configuration.environment,
          nowMs: this.nowMs(),
          enforceExpiry: true, // a live response past expiry is the replay window — refused
        });
        if (!result.ok) {
          // A rejected envelope never dislodges the snapshot or the cache: the last
          // verified state keeps serving, and the rejection is one diagnostics read away.
          this.lastFetchStatus = "rejectedEnvelope";
          this.lastRejection = result.code;
          this.consecutiveFailures++;
          return;
        }
        this.lastFetchStatus = "fresh";
        this.lastRejection = "";
        this.etag = outcome.etag;
        this.consecutiveFailures = 0;
        this.snapshot = snapshotOf(result.envelope, false);
        if (this.cache !== null) {
          this.cacheState = (await this.cache.store(result.envelope.raw))
            ? "stored"
            : "storeFailed";
        }
        this.networkReady.open();
        return;
      }
      case "notModified":
        // The steady state of a polling fleet: the cached ruleset is current.
        this.lastFetchStatus = "notModified";
        this.consecutiveFailures = 0;
        return;
      case "unauthorized":
        // A revoked key. The contract's instruction: answered like any failed fetch — keep
        // evaluating with the last downloaded ruleset, indefinitely, until given a new key.
        this.lastFetchStatus = "unauthorized";
        this.consecutiveFailures++;
        return;
      case "rateLimited":
        this.lastFetchStatus = "rateLimited";
        this.consecutiveFailures++;
        return;
      case "serverError":
        this.lastFetchStatus = "serverError";
        this.consecutiveFailures++;
        return;
      case "responseTooLarge":
        this.lastFetchStatus = "responseTooLarge";
        this.consecutiveFailures++;
        return;
      case "unexpectedStatus":
        this.lastFetchStatus = "unexpectedStatus";
        this.consecutiveFailures++;
        return;
      default:
        this.lastFetchStatus = "transportError";
        this.consecutiveFailures++;
    }
  }

  /** The getters' shared path: snapshot read, kind check, evaluate. */
  private value(flagKey: string, evaluation: Context, wantKind: string): [unknown, boolean] {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      this.fallbackNoSnapshot++;
      return [undefined, false];
    }
    const config = snapshot.flags[flagKey];
    if (config === undefined) {
      // Absence means the flag does not exist or was archived: the caller's fallback is
      // the contract's answer.
      this.fallbackUnknownFlag++;
      return [undefined, false];
    }
    if (config.kind !== wantKind) {
      // Asking bool of a string flag is a caller bug, but never a throw: fallback, and
      // the mismatch is visible on diagnostics.
      this.fallbackKindMismatch++;
      return [undefined, false];
    }
    const result = evaluateFlag(config, evaluation.tags ?? {}, evaluation.key, flagKey);
    if (!result.ok) {
      this.fallbackNoValue++;
      return [undefined, false];
    }
    this.served++;
    return [result.value, true];
  }
}
