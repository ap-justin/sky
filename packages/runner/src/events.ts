import { setTimeout as sleep } from "node:timers/promises";
import { RunnerEventPost } from "@harness/shared";

const TIMEOUT_MS = 10_000;
/** The pause before each retry. Progress gives up fast; losing it costs one line on a timeline. */
const PROGRESS_RETRIES_MS = [500, 1000];
/**
 * An ending event that never lands leaves the run open until the API's sweep fails it, so it
 * rides out an API restart: backoff to ~2 min in all, the last tries 60 s+ after the first.
 */
const ENDING_RETRIES_MS = [
  500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
];
const ENDING_EVENTS = new Set(["run.waiting", "run.finished", "run.failed"]);

export type PostEvent = (event: RunnerEventPost) => Promise<void>;

/**
 * A post that fails is retried, then dropped with one line on `warn`: losing an event must not
 * take down the run that produced it. A 4xx other than 408/429 is final and isn't retried.
 */
export function createPoster(options: {
  apiBaseUrl: string;
  agentToken: string;
  warn: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): PostEvent {
  const url = new URL("/internal/events", options.apiBaseUrl);
  const pause = options.sleep ?? ((ms: number) => sleep(ms));
  return async (event) => {
    const body = JSON.stringify(RunnerEventPost.parse(event));
    const retries = ENDING_EVENTS.has(event.type)
      ? ENDING_RETRIES_MS
      : PROGRESS_RETRIES_MS;
    let failure = "";
    let attempt = 0;
    while (attempt <= retries.length) {
      if (attempt > 0) await pause(retries[attempt - 1] ?? 0);
      attempt++;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.agentToken}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // read every body so the keep-alive socket is released
        const text = await res.text();
        if (res.ok) return;
        // an earlier attempt opened this request, and only its response was lost
        if (
          attempt > 1 &&
          event.type === "run.waiting" &&
          res.status === 409 &&
          errorCode(text) === "request_open"
        )
          return;
        failure = `HTTP ${res.status}`;
        if (isFinal(res.status)) break;
      } catch (error) {
        const cause = error instanceof Error ? (error.cause ?? error) : error;
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    }
    options.warn(
      `runner: dropped ${event.type} after ${attempt} attempts: ${failure}`,
    );
  };
}

const isFinal = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

function errorCode(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
  } catch {
    return undefined;
  }
}
