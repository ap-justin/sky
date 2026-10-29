import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  PermissionResult,
  PreToolUseHookInput,
  SDKMessage,
  SDKResultMessage,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type {
  Decision,
  PendingRequest,
  RequestId,
  RunnerEventPost,
  Usage,
} from "@harness/shared";
import type { Config } from "./config.js";
import type { PostEvent } from "./events.js";
import { matchesPolicy } from "./policy.js";
import type { AwaitDecision } from "./requests.js";
import { commitAll, ensureWorktree } from "./worktree.js";

/** The Agent SDK's `query`, narrowed to what the runner calls; tests feed it scripted streams. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

const MAX_PROGRESS_CHARS = 2000;

type RunnerEvent = Omit<RunnerEventPost, "runId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Every Agent SDK option a run passes is assembled here. */
function sessionOptions(
  config: Config,
  cwd: string,
  abortController: AbortController,
  hooks: Options["hooks"],
  canUseTool: CanUseTool,
): Options {
  // the session's tools can read their env; the event token stays with the runner
  const { AGENT_TOKEN: _, ...env } = process.env;
  return {
    cwd,
    resume: config.sessionId,
    abortController,
    env,
    systemPrompt: { type: "preset", preset: "claude_code" },
    // the approval policy holds calls in the PreToolUse hook; everything else runs unasked
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks,
    // reached only by what bypassPermissions can't approve, AskUserQuestion among them
    canUseTool,
  };
}

/**
 * Hooks forward what Claude is doing without holding it up: the event is queued
 * behind earlier posts and the hook answers `continue` at once, whatever the post does.
 * The one exception is `gate`, which holds a PreToolUse call until it has a decision.
 */
function sessionHooks(on: {
  progress: (event: RunnerEvent) => void;
  stop: (lastMessage: string | undefined) => void;
  gate: (
    input: PreToolUseHookInput,
    signal: AbortSignal,
  ) => Promise<SyncHookJSONOutput>;
}): Options["hooks"] {
  const matcher = <E extends HookEvent>(
    handle: (
      input: Extract<HookInput, { hook_event_name: E }>,
      signal: AbortSignal,
    ) => undefined | Promise<SyncHookJSONOutput>,
  ): HookCallbackMatcher[] => {
    const hook: HookCallback = async (input, _toolUseId, { signal }) =>
      (await handle(
        input as Extract<HookInput, { hook_event_name: E }>,
        signal,
      )) ?? { continue: true };
    return [{ hooks: [hook] }];
  };
  return {
    Notification: matcher<"Notification">((input) => {
      on.progress({
        type: "run.progress",
        payload: { message: clip(input.message) },
      });
    }),
    PreToolUse: matcher<"PreToolUse">((input, signal) => {
      on.progress({
        type: "run.progress",
        payload: {
          message: clip(toolHint(input.tool_input) ?? input.tool_name),
          tool: input.tool_name,
        },
      });
      return on.gate(input, signal);
    }),
    Stop: matcher<"Stop">((input) => {
      on.stop(input.last_assistant_message);
    }),
  };
}

/** Runs one Claude session for the run and reports it; resolves to the process exit code. */
export async function runSession(
  config: Config,
  deps: {
    query: QueryFn;
    post: PostEvent;
    awaitDecision: AwaitDecision;
    signal: AbortSignal;
  },
): Promise<0 | 1> {
  const { runId } = config;
  // one queue keeps the API's order the order things happened, hooks included
  let queue = Promise.resolve();
  const post = (event: RunnerEvent) => {
    const posted = queue.then(() =>
      deps.post({ runId, ...event } as RunnerEventPost),
    );
    queue = posted.catch(() => {});
    return posted;
  };
  let ended = false;
  const end = async (event: RunnerEvent) => {
    if (ended) return;
    ended = true;
    await post(event);
  };
  const fail = async (error: string, usage?: Usage) => {
    await end({
      type: "run.failed",
      payload: usage ? { error, usage } : { error },
    });
    return 1 as const;
  };

  let cwd: string;
  try {
    cwd = await ensureWorktree(config);
  } catch (error) {
    return fail(`worktree setup failed: ${messageOf(error)}`);
  }

  const abortController = new AbortController();
  const forward = () => abortController.abort(deps.signal.reason);
  deps.signal.addEventListener("abort", forward, { once: true });

  // why the runner itself aborted the session; it outranks the stream error or result that follows
  let stopReason: string | undefined;
  const stopSession = (reason: string) => {
    stopReason ??= reason;
    abortController.abort(reason);
  };

  // the API keeps one open request per run, so parallel tool calls take turns
  let turn = Promise.resolve();
  const decide = (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ) => {
    const decided = turn.then(() => waitForDecision(request, signal));
    turn = decided.then(
      () => {},
      () => {},
    );
    return decided;
  };
  /** The person's decision, or undefined once the session is being torn down. */
  const waitForDecision = async (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<Decision | undefined> => {
    if (abortController.signal.aborted || signal.aborted) return undefined;
    const requestId: RequestId = `req_${randomUUID().replaceAll("-", "")}`;
    await post({
      type: "run.waiting",
      payload: { request: { ...request, requestId } },
    }).catch(() => {});
    const expired = new AbortController();
    const timer = setTimeout(() => expired.abort(), config.waitTimeoutMs);
    try {
      const outcome = await deps.awaitDecision(
        requestId,
        AbortSignal.any([abortController.signal, signal, expired.signal]),
      );
      switch (outcome.kind) {
        case "decided":
          return outcome.decision;
        case "run_ended":
          // the API already recorded how the run ended
          ended = true;
          stopSession("run ended while waiting");
          return undefined;
        case "lost":
          stopSession(`request ${requestId} was never recorded`);
          return undefined;
      }
    } catch (error) {
      if (expired.signal.aborted) stopSession("waiting_timeout");
      else if (!abortController.signal.aborted && !signal.aborted)
        stopSession(`waiting failed: ${messageOf(error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const gate = async (
    input: PreToolUseHookInput,
    signal: AbortSignal,
  ): Promise<SyncHookJSONOutput> => {
    if (
      !matchesPolicy(config.approvalPolicy, input.tool_name, input.tool_input)
    )
      return { continue: true };
    const decision = await decide(
      {
        kind: "approval",
        toolName: input.tool_name,
        toolSummary: clip(
          toolHint(input.tool_input, SUBJECT_KEYS) ??
            (JSON.stringify(input.tool_input) || input.tool_name),
        ),
      },
      signal,
    );
    // approve adds nothing: an explicit allow would also skip canUseTool, which answers AskUserQuestion
    if (decision?.decision === "approve") return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          (decision?.decision === "deny" && decision.reason) ||
          (decision ? "The user denied this tool call." : "The run is ending."),
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (toolName !== "AskUserQuestion")
      return { behavior: "allow", updatedInput: input };
    return askPerson(input as unknown as AskUserQuestionInput, signal);
  };
  const askPerson = async (
    input: AskUserQuestionInput,
    signal: AbortSignal,
  ): Promise<PermissionResult> => {
    const decision = await decide(
      { kind: "question", prompt: questionPrompt(input) },
      signal,
    );
    if (decision?.decision !== "answer")
      return {
        behavior: "deny",
        message:
          (decision?.decision === "deny" && decision.reason) ||
          (decision ? "The user declined to answer." : "The run is ending."),
      };
    // one answer covers every question: the person replies once, in their own words
    const answers = Object.fromEntries(
      input.questions.map((q) => [q.question, decision.answer]),
    );
    return {
      behavior: "allow",
      updatedInput: { questions: input.questions, answers },
    };
  };

  let result: SDKResultMessage | undefined;
  let streamError: string | undefined;
  let started = false;
  let stopMessage: string | undefined;
  const hooks = sessionHooks({
    // a failed post must not fail the tool call that triggered it
    progress: (event) => void post(event).catch(() => {}),
    stop: (lastMessage) => {
      stopMessage = lastMessage || stopMessage;
    },
    gate,
  });
  try {
    const stream = deps.query({
      prompt: config.prompt,
      options: sessionOptions(config, cwd, abortController, hooks, canUseTool),
    });
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init" && !started) {
        started = true;
        await post({
          type: "run.started",
          payload: { sessionId: message.session_id },
        });
      } else if (message.type === "assistant") {
        for (const text of textOf(message.message.content))
          await post({ type: "run.progress", payload: { message: text } });
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (error) {
    streamError = deps.signal.aborted
      ? `interrupted by ${String(deps.signal.reason)}`
      : messageOf(error);
  } finally {
    deps.signal.removeEventListener("abort", forward);
  }

  let commitError: string | undefined;
  try {
    await commitAll({ cwd, agentId: config.agentId, runId });
  } catch (error) {
    commitError = `commit failed: ${messageOf(error)}`;
  }

  const usage = result && usageOf(result);
  const failure = stopReason ?? streamError;
  if (failure) return fail(failure, usage);
  if (!result) return fail("session ended without a result");
  if (result.subtype !== "success" || result.is_error) {
    const reason =
      ("errors" in result && result.errors.join("; ")) || result.subtype;
    return fail(reason, usage);
  }
  if (commitError) return fail(commitError, usage);
  await end({
    type: "run.finished",
    payload: {
      summary: result.result || stopMessage || "",
      usage: usageOf(result),
    },
  });
  return 0;
}

type AssistantContent = Extract<
  SDKMessage,
  { type: "assistant" }
>["message"]["content"];

/** Assistant text, as progress lines; tool calls report through the PreToolUse hook instead. */
function textOf(content: AssistantContent): string[] {
  return content.flatMap((block) =>
    block.type === "text" && block.text.trim() ? [clip(block.text.trim())] : [],
  );
}

const HINT_KEYS = [
  "description",
  "command",
  "file_path",
  "pattern",
  "url",
  "query",
];
/** What an approver judges: the command itself, not Claude's description of it. */
const SUBJECT_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "url",
  "pattern",
  "query",
];

/** The one input field that says what a built-in tool call is acting on. */
function toolHint(input: unknown, keys = HINT_KEYS): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Claude's questions as one prompt for the person: each question with its options beneath. */
function questionPrompt(input: AskUserQuestionInput): string {
  return input.questions
    .map((q) =>
      [
        q.question,
        ...q.options.map((o) => `- ${o.label}: ${o.description}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function usageOf(result: SDKResultMessage): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  // modelUsage covers subagents and compaction too; `usage` is the main loop only
  for (const m of Object.values(result.modelUsage)) {
    inputTokens +=
      m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
    outputTokens += m.outputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: Math.round(result.duration_ms),
  };
}

const clip = (s: string) =>
  s.length > MAX_PROGRESS_CHARS ? `${s.slice(0, MAX_PROGRESS_CHARS - 1)}…` : s;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
