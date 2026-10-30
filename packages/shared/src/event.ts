import { z } from "zod";
import { AgentId, EventId, RequestId, RunId } from "./ids.js";
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
  "claude.PreToolUse",
  "claude.PostToolUse",
  "claude.PostToolUseFailure",
  "claude.SubagentStart",
  "claude.SubagentStop",
  "claude.TaskCreated",
  "claude.TaskCompleted",
  "claude.Notification",
  "claude.PreCompact",
  "claude.FileChanged",
  "claude.Message",
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

const runPayloads = {
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
};

/** Most a runner may send in one text field; the API redacts the full text before trimming it. */
export const RUNNER_TEXT_MAX = 65_536;
/** Most the API stores of one text field after redaction, before the truncation marker. */
export const EVENT_TEXT_MAX = 4_096;
/** Appended by the API to a text field it trimmed to `EVENT_TEXT_MAX`. */
export const truncationMarker = (omitted: number) =>
  `\n…[truncated ${omitted} chars]`;

/**
 * Claude Code hook inputs (Agent SDK `<Name>HookInput`), camelCased, minus per-session plumbing;
 * `claude.Message` is assistant text from the message stream.
 * `subagentId` is the SDK's `agent_id` — `agentId` is the sky agent on the envelope.
 */
const claudePayloads = (textMax: number) => {
  const text = z.string().max(textMax);
  const tool = {
    toolName: z.string().min(1),
    toolUseId: z.string().min(1),
    /** the tool input as JSON text */
    input: text,
    /** set when a subagent made the call */
    subagentId: z.string().min(1).optional(),
  };
  const task = {
    taskId: z.string().min(1),
    taskSubject: text,
    taskDescription: text.optional(),
    teammateName: z.string().min(1).optional(),
  };
  const durationMs = z.number().nonnegative().optional();
  return {
    "claude.PreToolUse": z.object(tool),
    "claude.PostToolUse": z.object({ ...tool, output: text, durationMs }),
    "claude.PostToolUseFailure": z.object({
      ...tool,
      error: text,
      isInterrupt: z.boolean().optional(),
      durationMs,
    }),
    "claude.SubagentStart": z.object({
      subagentId: z.string().min(1),
      agentType: z.string().min(1),
    }),
    "claude.SubagentStop": z.object({
      subagentId: z.string().min(1),
      agentType: z.string().min(1),
      lastAssistantMessage: text.optional(),
    }),
    "claude.TaskCreated": z.object(task),
    "claude.TaskCompleted": z.object(task),
    "claude.Notification": z.object({
      message: text,
      title: text.optional(),
      notificationType: z.string().min(1),
    }),
    "claude.PreCompact": z.object({
      trigger: z.enum(["manual", "auto"]),
      customInstructions: text.nullable(),
    }),
    "claude.FileChanged": z.object({
      filePath: text,
      event: z.enum(["change", "add", "unlink"]),
    }),
    "claude.Message": z.object({ text }),
  };
};

const postPayloads = {
  ...runPayloads,
  ...claudePayloads(RUNNER_TEXT_MAX),
} satisfies Record<EventType, z.ZodType>;

/** the extra 64 admits `truncationMarker` after a trimmed field */
const storedPayloads = {
  ...runPayloads,
  ...claudePayloads(EVENT_TEXT_MAX + 64),
} satisfies Record<EventType, z.ZodType>;

const posted = <T extends EventType>(type: T) =>
  z.strictObject({
    runId: RunId,
    type: z.literal(type),
    payload: postPayloads[type],
  });

/** Body of the runner's `POST /internal/events`; the API assigns `id` and `ts`. */
export const RunnerEventPost = z.discriminatedUnion("type", [
  posted("run.started"),
  posted("run.progress"),
  posted("run.waiting"),
  posted("run.finished"),
  posted("run.failed"),
  posted("run.stopped"),
  posted("claude.PreToolUse"),
  posted("claude.PostToolUse"),
  posted("claude.PostToolUseFailure"),
  posted("claude.SubagentStart"),
  posted("claude.SubagentStop"),
  posted("claude.TaskCreated"),
  posted("claude.TaskCompleted"),
  posted("claude.Notification"),
  posted("claude.PreCompact"),
  posted("claude.FileChanged"),
  posted("claude.Message"),
]);
export type RunnerEventPost = z.infer<typeof RunnerEventPost>;

const stored = <T extends EventType>(type: T) =>
  z.object({
    id: EventId,
    agentId: AgentId,
    runId: RunId,
    ts: z.iso.datetime(),
    type: z.literal(type),
    payload: storedPayloads[type],
  });

export const Event = z.discriminatedUnion("type", [
  stored("run.started"),
  stored("run.progress"),
  stored("run.waiting"),
  stored("run.finished"),
  stored("run.failed"),
  stored("run.stopped"),
  stored("claude.PreToolUse"),
  stored("claude.PostToolUse"),
  stored("claude.PostToolUseFailure"),
  stored("claude.SubagentStart"),
  stored("claude.SubagentStop"),
  stored("claude.TaskCreated"),
  stored("claude.TaskCompleted"),
  stored("claude.Notification"),
  stored("claude.PreCompact"),
  stored("claude.FileChanged"),
  stored("claude.Message"),
]);
export type Event = z.infer<typeof Event>;
