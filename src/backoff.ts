/**
 * How long to wait before the next poll — a port of the web/Go SDK's backoff, reasoning
 * included, because the second job matters MORE at server scale. The obvious job is to
 * stop a process hammering a failing backend. The less obvious job is DE-SYNCHRONISATION:
 * without jitter, every process in a fleet that started polling at the same moment —
 * which, after an outage, is all of them — retries in lockstep, and the backend that just
 * came back up is knocked over by its own clients. Jitter on the success path matters as
 * much as on the failure path: a 100-process deployment restarted by an orchestrator polls
 * as 100 spikes a minute forever unless the routine interval is jittered too.
 *
 * Randomness is injected so the bounds can be asserted in tests instead of hoped for.
 */

export type RandomInRange = (low: number, high: number) => number;

/**
 * The ceiling: half an hour. A process that has been failing for hours is almost certainly
 * firewalled or misconfigured, and there is nothing to gain from asking more often — the
 * snapshot is already answering every call.
 */
const BACKOFF_CAP_SECONDS = 1800;
/** The delay after the first failure. Doubles from here. */
const BACKOFF_BASE_SECONDS = 2;
/** Spreads every delay ±20%. */
const BACKOFF_JITTER_FRACTION = 0.2;

/** The wait in ms after consecutiveFailures failures in a row. */
export function retryDelayMs(consecutiveFailures: number, random: RandomInRange): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  // Exponent capped before the power so a long-offline process cannot overflow the
  // multiplier on its ten-thousandth failed attempt.
  const exponent = Math.min(consecutiveFailures - 1, 32);
  const raw = Math.min(BACKOFF_BASE_SECONDS * 2 ** exponent, BACKOFF_CAP_SECONDS);
  return jitteredMs(raw, random);
}

/** The wait in ms before the next routine poll — jittered, see above. */
export function pollDelayMs(intervalMs: number, random: RandomInRange): number {
  return jitteredMs(intervalMs / 1000, random);
}

/**
 * Obeys a server that told us when to come back — but never past the cap: a hostile or
 * misconfigured Retry-After of a year must not silently disable flag updates for a process
 * until it restarts.
 */
export function retryDelayWithServerHintMs(
  retryAfterSeconds: number,
  consecutiveFailures: number,
  random: RandomInRange,
): number {
  if (retryAfterSeconds <= 0) {
    return retryDelayMs(consecutiveFailures, random);
  }
  return Math.min(retryAfterSeconds, BACKOFF_CAP_SECONDS) * 1000;
}

function jitteredMs(seconds: number, random: RandomInRange): number {
  const spread = seconds * BACKOFF_JITTER_FRACTION;
  return random(seconds - spread, seconds + spread) * 1000;
}
