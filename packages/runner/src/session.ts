import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunnerEventPost, Usage } from "@harness/shared";
import type { Config } from "./config.js";
import type { PostEvent } from "./events.js";
import { commitAll, ensureWorktree } from "./worktree.js";

/** The Agent SDK's `query`, narrowed to what the runner calls; tests feed it scripted streams. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

const MAX_PROGRESS_CHARS = 2000;

type RunnerEvent = Omit<RunnerEventPost, "runId">;

/** Every Agent SDK option a run passes is assembled here. */
function sessionOptions(
  config: Config,
  cwd: string,
  abortController: AbortController,
  hooks: Options["hooks"],
): Options {
  // the session's tools can read their env; the event token stays with the runner
  const { AGENT_TOKEN: _, ...env } = process.env;
  return {
    cwd,
    resume: config.sessionId,
    abortController,
    env,
    systemPrompt: { type: "preset", preset: "claude_code" },
    // no one is attached to answer a prompt until the approval gate exists
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks,
  };
}

/**
 * Hooks forward what Claude is doing without holding it up: the event is queued
 * behind earlier posts and the hook answers `continue` at once, whatever the post does.
 */
function sessionHooks(on: {
  progress: (event: RunnerEvent) => void;
  stop: (lastMessage: string | undefined) => void;
}): Options["hooks"] {
  const matcher = <E extends HookEvent>(
    handle: (input: Extract<HookInput, { hook_event_name: E }>) => void,
  ): HookCallbackMatcher[] => {
    const hook: HookCallback = async (input) => {
      handle(input as Extract<HookInput, { hook_event_name: E }>);
      return { continue: true };
    };
    return [{ hooks: [hook] }];
  };
  return {
    Notification: matcher<"Notification">((input) =>
      on.progress({
        type: "run.progress",
        payload: { message: clip(input.message) },
      }),
    ),
    PreToolUse: matcher<"PreToolUse">((input) =>
      on.progress({
        type: "run.progress",
        payload: {
          message: clip(toolHint(input.tool_input) ?? input.tool_name),
          tool: input.tool_name,
        },
      }),
    ),
    Stop: matcher<"Stop">((input) => on.stop(input.last_assistant_message)),
  };
}

/** Runs one Claude session for the run and reports it; resolves to the process exit code. */
export async function runSession(
  config: Config,
  deps: { query: QueryFn; post: PostEvent; signal: AbortSignal },
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
  });
  try {
    const stream = deps.query({
      prompt: config.prompt,
      options: sessionOptions(config, cwd, abortController, hooks),
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
  if (streamError) return fail(streamError, usage);
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

/** The one input field that says what a built-in tool call is acting on. */
function toolHint(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of [
    "description",
    "command",
    "file_path",
    "pattern",
    "url",
    "query",
  ]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
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
