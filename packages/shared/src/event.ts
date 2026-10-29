import { z } from "zod";
import { EventId, RequestId, RunId } from "./ids.js";
import { Usage } from "./run.js";

/** What a run is blocked on: a question from Claude, or a tool call the environment's approval policy holds. */
export const PendingRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    requestId: RequestId,
    prompt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("approval"),
    requestId: RequestId,
    toolName: z.string().min(1),
    toolSummary: z.string().min(1),
  }),
]);
export type PendingRequest = z.infer<typeof PendingRequest>;

export const Decision = z.discriminatedUnion("decision", [
  z.object({ requestId: RequestId, decision: z.literal("approve") }),
  z.object({
    requestId: RequestId,
    decision: z.literal("deny"),
    reason: z.string().optional(),
  }),
  z.object({
    requestId: RequestId,
    decision: z.literal("answer"),
    answer: z.string().min(1),
  }),
]);
export type Decision = z.infer<typeof Decision>;

export const EventType = z.enum([
  "run.started",
  "run.progress",
  "run.waiting",
  "run.finished",
  "run.failed",
  "run.stopped",
]);
export type EventType = z.infer<typeof EventType>;

/** SHA-1 or SHA-256 object name. */
const GitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** A diffstat and the commits behind it; `commits` is newest first, capped at 50. */
export const Rollup = z.object({
  commits: z
    .array(
      z.object({
        sha: GitSha,
        subject: z.string().max(200),
      }),
    )
    .max(50),
  /** binary files count here with 0 lines added and removed */
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type Rollup = z.infer<typeof Rollup>;

/** What the agent branch holds at run end: `run` since the run started, `cumulative` since `base`, its merge-base with `origin/HEAD`. */
export const RunRollup = z.object({
  base: GitSha,
  run: Rollup,
  cumulative: Rollup,
});
export type RunRollup = z.infer<typeof RunRollup>;

const payloads = {
  /** `sessionId` is the Claude session the API stores to resume the agent's next run. */
  "run.started": z.object({ sessionId: z.string().min(1) }),
  /** Assistant text or a tool call, as the run goes. */
  "run.progress": z.object({
    message: z.string(),
    tool: z.string().min(1).optional(),
  }),
  "run.waiting": z.object({ request: PendingRequest }),
  "run.finished": z.object({
    summary: z.string(),
    usage: Usage,
    rollup: RunRollup.optional(),
  }),
  "run.failed": z.object({
    error: z.string().min(1),
    usage: Usage.optional(),
    rollup: RunRollup.optional(),
  }),
  "run.stopped": z.object({}),
} satisfies Record<EventType, z.ZodType>;

const posted = <T extends EventType>(type: T) =>
  z.strictObject({
    runId: RunId,
    type: z.literal(type),
    payload: payloads[type],
  });

/** Body of the runner's `POST /internal/events`; the API assigns `id` and `ts`. */
export const RunnerEventPost = z.discriminatedUnion("type", [
  posted("run.started"),
  posted("run.progress"),
  posted("run.waiting"),
  posted("run.finished"),
  posted("run.failed"),
  posted("run.stopped"),
]);
export type RunnerEventPost = z.infer<typeof RunnerEventPost>;

const stored = <T extends EventType>(type: T) =>
  z.object({
    id: EventId,
    runId: RunId,
    ts: z.iso.datetime(),
    type: z.literal(type),
    payload: payloads[type],
  });

export const Event = z.discriminatedUnion("type", [
  stored("run.started"),
  stored("run.progress"),
  stored("run.waiting"),
  stored("run.finished"),
  stored("run.failed"),
  stored("run.stopped"),
]);
export type Event = z.infer<typeof Event>;
