import { setTimeout as delay } from "node:timers/promises";

/** Resolves after `ms`; rejects once `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The clock a retry runs on; tests swap in a virtual one so no test waits real seconds. */
export type RetryTiming = {
  sleep?: Sleep;
  /** In [0, 1): where in each backoff window the pause falls. */
  random?: () => number;
  /** Epoch ms, the clock `deadline` is on. */
  now?: () => number;
};

/** What one attempt found. */
export type Attempt<T> =
  | { done: T }
  /** A failure worth trying again after a pause: the API or the path to it is having a moment. */
  | { retry: string }
  /** A good reply that settles nothing yet: ask again at once, the backoff starts over. */
  | { again: true }
  /** A failure trying again won't change. */
  | { fail: string };

export class RetryError extends Error {
  constructor(
    readonly why: "final" | "deadline" | "attempts" | "given_up",
    /** The last attempt's failure; undefined when every attempt since the last good reply was cut off by the deadline. */
    readonly lastFailure: string | undefined,
    readonly attempts: number,
  ) {
    super(`${why} after ${attempts} attempts: ${lastFailure ?? "no reply"}`);
  }
}

/** A status worth asking again for. */
export const isTransient = (status: number) =>
  status >= 500 || status === 408 || status === 429;

const BASE_MS = 500;
const CAP_MS = 30_000;

/**
 * Runs `attempt` until it settles, backing off between failures with full jitter: a pause anywhere
 * in [0, min(30 s, 500 ms · 2^n)) after n + 1 failures in a row. A rejected attempt (fetch's
 * network failures, a body read cut short, a per-attempt timeout) counts as a retryable failure.
 * Rejects with a `RetryError` at the deadline, after `maxAttempts`, on a final failure, or on a
 * failure once `giveUp` has aborted; rejects with `signal.reason` the moment `signal` aborts,
 * mid-attempt or mid-pause.
 */
export async function retry<T>(
  attempt: (attempt: number, signal: AbortSignal) => Promise<Attempt<T>>,
  options: RetryTiming & {
    deadline: number;
    attemptTimeoutMs: number;
    maxAttempts?: number;
    signal?: AbortSignal;
    /** A stop that ends the retrying, not the sending: the attempt in flight completes, and a failure rejects instead of pausing. */
    giveUp?: AbortSignal;
  },
): Promise<T> {
  const { deadline, signal, giveUp } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep: Sleep =
    options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let attempts = 0;
  let failuresInARow = 0;
  let lastFailure: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const left = deadline - now();
    if (left <= 0) throw new RetryError("deadline", lastFailure, attempts);
    attempts++;
    const deadlineFirst = left < options.attemptTimeoutMs;
    // AbortSignal.timeout throws on a fractional delay
    const cut = AbortSignal.timeout(
      Math.ceil(Math.min(options.attemptTimeoutMs, left)),
    );
    let found: Attempt<T>;
    try {
      found = await attempt(
        attempts,
        signal ? AbortSignal.any([signal, cut]) : cut,
      );
    } catch (error) {
      signal?.throwIfAborted();
      // cut off by the deadline rather than failed: says nothing about the API
      if (now() >= deadline || (deadlineFirst && cut.aborted))
        throw new RetryError("deadline", lastFailure, attempts);
      found = { retry: describe(error) };
    }
    signal?.throwIfAborted();
    if ("done" in found) return found.done;
    if ("fail" in found) throw new RetryError("final", found.fail, attempts);
    if ("again" in found) {
      failuresInARow = 0;
      lastFailure = undefined;
      continue;
    }
    lastFailure = found.retry;
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts)
      throw new RetryError("attempts", lastFailure, attempts);
    const givenUp = () => new RetryError("given_up", lastFailure, attempts);
    if (giveUp?.aborted) throw givenUp();
    const window = Math.min(CAP_MS, BASE_MS * 2 ** failuresInARow++);
    const pause = Math.min(random() * window, deadline - now());
    if (pause > 0) {
      const pauseCut = [signal, giveUp].filter((s) => s !== undefined);
      await sleep(pause, AbortSignal.any(pauseCut)).catch((error: unknown) => {
        signal?.throwIfAborted();
        if (giveUp?.aborted) throw givenUp();
        throw error;
      });
      if (giveUp?.aborted) throw givenUp();
    }
  }
}

/** fetch rejects with `TypeError: fetch failed` and keeps the reason (ECONNRESET, UND_ERR_SOCKET) in `cause`. */
function describe(error: unknown): string {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return cause instanceof Error ? cause.message : String(cause);
}
