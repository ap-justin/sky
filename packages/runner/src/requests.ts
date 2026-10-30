import { Decision } from "@sky/shared";
import { z } from "zod";
import { isTransient, RetryError, type RetryTiming, retry } from "./retry.js";

export type DecisionOutcome =
  | { kind: "decided"; decision: Decision }
  /** The API stopped or failed the run, and has already recorded how it ended. */
  | { kind: "run_ended" }
  /** The API holds no such request: the waiting event never landed. */
  | { kind: "lost" }
  /** The deadline passed with the API answering, and nobody deciding. */
  | { kind: "expired" };

/**
 * Waits until `deadline` (epoch ms) for the person's decision on `requestId`; rejects with
 * `signal.reason` once it aborts, with an "API unreachable" error when the deadline passes with
 * the API failing, and with a "decision poll failed" error on a status retrying won't change.
 */
export type AwaitDecision = (
  requestId: string,
  signal: AbortSignal,
  deadline: number,
) => Promise<DecisionOutcome>;

const Reply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("decided"), decision: Decision }),
]);

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });

/**
 * Long-polls the API for a decision. `pending` is asked again at once (the API holds each poll
 * open); a dropped connection, a transient status, or a poll still unanswered at `pollTimeoutMs`
 * is asked again after a backoff. The timeout sits past the API's hold: a sprite pause can leave a
 * poll's connection dead with nothing on this side to say so.
 */
export function createDecisionWaiter(
  options: RetryTiming & {
    apiBaseUrl: string;
    agentToken: string;
    runId: string;
    pollTimeoutMs?: number;
  },
): AwaitDecision {
  const pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  return async (requestId, signal, deadline) => {
    const url = new URL(
      `/internal/runs/${options.runId}/requests/${requestId}`,
      options.apiBaseUrl,
    );
    try {
      return await retry<DecisionOutcome>(
        async (_attempt, cut) => {
          const res = await fetch(url, {
            headers: { authorization: `Bearer ${options.agentToken}` },
            signal: cut,
          });
          const body = parseJson(await res.text());
          if (res.status === 200) {
            const reply = Reply.safeParse(body);
            if (!reply.success) return { retry: "unreadable reply" };
            return reply.data.status === "decided"
              ? { done: { kind: "decided", decision: reply.data.decision } }
              : { again: true };
          }
          if (res.status === 404) return { done: { kind: "lost" } };
          if (
            res.status === 401 &&
            ErrorBody.safeParse(body).data?.error.code === "run_ended"
          )
            return { done: { kind: "run_ended" } };
          const failure = `HTTP ${res.status}`;
          return isTransient(res.status)
            ? { retry: failure }
            : { fail: `decision poll failed: ${failure}` };
        },
        {
          sleep: options.sleep,
          random: options.random,
          now: options.now,
          deadline,
          attemptTimeoutMs: pollTimeoutMs,
          signal,
        },
      );
    } catch (error) {
      if (!(error instanceof RetryError)) throw error;
      if (error.why === "final") throw new Error(error.lastFailure);
      if (error.lastFailure === undefined) return { kind: "expired" };
      throw new Error(
        `API unreachable while waiting for request ${requestId}: ${error.lastFailure}`,
      );
    }
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
