import { setTimeout as sleep } from "node:timers/promises";
import { Decision } from "@harness/shared";
import { z } from "zod";

export type DecisionOutcome =
  | { kind: "decided"; decision: Decision }
  /** The API stopped or failed the run, and has already recorded how it ended. */
  | { kind: "run_ended" }
  /** The API holds no such request: the waiting event never landed. */
  | { kind: "lost" };

/** Waits for the person's decision on `requestId`; rejects with `signal.reason` once it aborts. */
export type AwaitDecision = (
  requestId: string,
  signal: AbortSignal,
) => Promise<DecisionOutcome>;

const Reply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("decided"), decision: Decision }),
]);

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });

/** A status worth asking again for: the API or the path to it is having a moment. */
const transient = (status: number) =>
  status >= 500 || status === 408 || status === 429;

/**
 * Long-polls the API for a decision. `pending` is asked again at once (the API holds
 * each poll open); a dropped connection or a transient status after `retryDelayMs`.
 */
export function createDecisionWaiter(options: {
  apiBaseUrl: string;
  agentToken: string;
  runId: string;
  retryDelayMs?: number;
}): AwaitDecision {
  const retryDelayMs = options.retryDelayMs ?? 1000;
  return async (requestId, signal) => {
    const url = new URL(
      `/internal/runs/${options.runId}/requests/${requestId}`,
      options.apiBaseUrl,
    );
    for (;;) {
      signal.throwIfAborted();
      let status: number;
      let body: unknown;
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${options.agentToken}` },
          signal,
        });
        status = res.status;
        body = await res.json().catch(() => undefined);
      } catch {
        signal.throwIfAborted();
        await pause(retryDelayMs, signal);
        continue;
      }
      if (status === 200) {
        const reply = Reply.safeParse(body);
        if (reply.success && reply.data.status === "decided")
          return { kind: "decided", decision: reply.data.decision };
        if (reply.success) continue;
      } else if (status === 404) {
        return { kind: "lost" };
      } else if (
        status === 401 &&
        ErrorBody.safeParse(body).data?.error.code === "run_ended"
      ) {
        return { kind: "run_ended" };
      } else if (!transient(status)) {
        throw new Error(`decision poll failed: HTTP ${status}`);
      }
      await pause(retryDelayMs, signal);
    }
  };
}

/** Resolves after `ms`, or early on abort; the loop's next check rejects with the reason. */
const pause = (ms: number, signal: AbortSignal) =>
  sleep(ms, undefined, { signal }).catch(() => {});
