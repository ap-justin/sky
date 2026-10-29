import { setTimeout as sleep } from "node:timers/promises";
import { RunnerEventPost } from "@harness/shared";

const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

export type PostEvent = (event: RunnerEventPost) => Promise<void>;

/**
 * A post that fails is retried briefly, then dropped with one line on `warn`:
 * losing an event must not take down the run that produced it.
 */
export function createPoster(options: {
  apiBaseUrl: string;
  agentToken: string;
  warn: (message: string) => void;
  retryDelayMs?: number;
}): PostEvent {
  const url = new URL("/internal/events", options.apiBaseUrl);
  const retryDelayMs = options.retryDelayMs ?? 500;
  return async (event) => {
    const body = JSON.stringify(RunnerEventPost.parse(event));
    let failure = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
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
        await res.arrayBuffer();
        if (res.ok) return;
        failure = `HTTP ${res.status}`;
      } catch (error) {
        const cause = error instanceof Error ? (error.cause ?? error) : error;
        failure = cause instanceof Error ? cause.message : String(cause);
      }
    }
    options.warn(
      `runner: dropped ${event.type} after ${ATTEMPTS} attempts: ${failure}`,
    );
  };
}
