import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunnerEventPost } from "@harness/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import type { Config } from "./config.js";
import { createPoster } from "./events.js";
import { type QueryFn, runSession } from "./session.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let config: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-session-"));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  git(origin, "add", ".");
  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  execFileSync("git", ["clone", "-q", origin, join(root, "repo")]);
  config = {
    agentId: "agt_1",
    runId: "run_1",
    prompt: "add a file",
    sessionId: undefined,
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    repoDir: join(root, "repo"),
    worktreesDir: join(root, "worktrees"),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const init = { type: "system", subtype: "init", session_id: "sess-new" };
const assistant = (...content: unknown[]) => ({
  type: "assistant",
  session_id: "sess-new",
  parent_tool_use_id: null,
  message: { content },
});
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Added hello.txt",
  num_turns: 2,
  duration_ms: 1234.6,
  total_cost_usd: 0.02,
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    },
  },
  session_id: "sess-new",
};

/** A scripted step that drives the session's options instead of yielding a message, as the SDK does when it fires a hook. */
type Step = (options: Options) => Promise<void>;

/** Fires the session's registered `event` hook the way the SDK does, and returns what the hook answered. */
async function fire(options: Options, event: HookEvent, fields: object) {
  const input = {
    session_id: "sess-new",
    transcript_path: "/t.jsonl",
    cwd: options.cwd ?? "",
    hook_event_name: event,
    ...fields,
  } as HookInput;
  const answers = [];
  for (const matcher of options.hooks?.[event] ?? [])
    for (const hook of matcher.hooks)
      answers.push(
        await hook(input, "toolu_1", { signal: new AbortController().signal }),
      );
  return answers;
}

const hook =
  (event: HookEvent, fields: object): Step =>
  async (options) => {
    expect(await fire(options, event, fields)).toEqual([{ continue: true }]);
  };

/** A scripted SDK stream; `onStart` runs once the session has its cwd, before the first message. */
function scripted(
  messages: unknown[],
  onStart?: (cwd: string) => void,
): QueryFn & { calls: Parameters<QueryFn>[0][] } {
  const calls: Parameters<QueryFn>[0][] = [];
  const fn = (params: Parameters<QueryFn>[0]) => {
    calls.push(params);
    return (async function* () {
      onStart?.(params.options.cwd ?? "");
      for (const m of messages) {
        if (m instanceof Error) throw m;
        if (typeof m === "function") await (m as Step)(params.options);
        else yield m as SDKMessage;
      }
    })();
  };
  return Object.assign(fn, { calls });
}

const recorder = () => {
  const posted: RunnerEventPost[] = [];
  return { posted, post: async (e: RunnerEventPost) => void posted.push(e) };
};

test("a finished run posts started, assistant text progress, then finished with the SDK usage, and exits 0", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    assistant(
      { type: "text", text: "I'll add the file." },
      {
        type: "tool_use",
        id: "t1",
        name: "Write",
        input: { file_path: "hello.txt", content: "x" },
      },
    ),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
  });
  expect(code).toBe(0);
  expect(posted).toEqual([
    { runId: "run_1", type: "run.started", payload: { sessionId: "sess-new" } },
    {
      runId: "run_1",
      type: "run.progress",
      payload: { message: "I'll add the file." },
    },
    {
      runId: "run_1",
      type: "run.finished",
      payload: {
        summary: "Added hello.txt",
        usage: {
          inputTokens: 115,
          outputTokens: 40,
          costUsd: 0.02,
          turns: 2,
          durationMs: 1235,
        },
      },
    },
  ]);
});

test("hooks reach the API in order: a notification, one progress per tool call from PreToolUse, and a single run.finished", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    warn: () => {},
    retryDelayMs: 0,
  });
  const query = scripted([
    init,
    hook("Notification", {
      message: "Claude needs your attention",
      notification_type: "idle_prompt",
    }),
    assistant(
      { type: "text", text: "Looking around." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ),
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls -la src", description: "" },
      tool_use_id: "t1",
    }),
    assistant({
      type: "tool_use",
      id: "t2",
      name: "Read",
      input: { file_path: "src/a.ts" },
    }),
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_use_id: "t2",
    }),
    hook("Stop", {
      stop_hook_active: false,
      last_assistant_message: "Done.",
    }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
  });
  expect(code).toBe(0);
  expect(sent).toEqual([
    { runId: "run_1", type: "run.started", payload: { sessionId: "sess-new" } },
    {
      runId: "run_1",
      type: "run.progress",
      payload: { message: "Claude needs your attention" },
    },
    {
      runId: "run_1",
      type: "run.progress",
      payload: { message: "Looking around." },
    },
    {
      runId: "run_1",
      type: "run.progress",
      payload: { message: "ls -la src", tool: "Bash" },
    },
    {
      runId: "run_1",
      type: "run.progress",
      payload: { message: "src/a.ts", tool: "Read" },
    },
    {
      runId: "run_1",
      type: "run.finished",
      payload: {
        summary: "Added hello.txt",
        usage: {
          inputTokens: 115,
          outputTokens: 40,
          costUsd: 0.02,
          turns: 2,
          durationMs: 1235,
        },
      },
    },
  ]);
});

test("a result with no text takes its summary from the Stop hook's last message", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    hook("Stop", {
      stop_hook_active: false,
      last_assistant_message: "Added hello.txt and a test.",
    }),
    { ...success, result: "" },
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
  });
  expect(posted.filter((e) => e.type === "run.finished")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        summary: "Added hello.txt and a test.",
      }),
    }),
  ]);
});

test("a hook answers continue without waiting on its post, and a post that rejects doesn't fail the tool call", async () => {
  const posted: RunnerEventPost[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const post = async (e: RunnerEventPost) => {
    if (e.type === "run.progress" && e.payload.tool === "Bash") {
      await held;
      throw new Error("post blew up");
    }
    posted.push(e);
  };
  const query = scripted([
    init,
    async (options: Options) => {
      const answers = await fire(options, "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "t1",
      });
      expect(answers).toEqual([{ continue: true }]);
      release();
    },
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "t2",
    }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
  });
  expect(code).toBe(0);
  expect(posted.map((e) => e.type)).toEqual([
    "run.started",
    "run.progress",
    "run.finished",
  ]);
});

test("runs the session in the agent worktree, resuming the stored session, without AGENT_TOKEN in its env", async () => {
  process.env.AGENT_TOKEN = "agent-secret";
  try {
    const query = scripted([init, success]);
    await runSession(
      { ...config, sessionId: "sess-old" },
      { query, post: recorder().post, signal: new AbortController().signal },
    );
    const [call] = query.calls;
    expect(call?.prompt).toBe("add a file");
    expect(call?.options.cwd).toBe(join(root, "worktrees", "agt_1"));
    expect(call?.options.resume).toBe("sess-old");
    expect(call?.options.env).not.toHaveProperty("AGENT_TOKEN");
    expect(call?.options.env?.PATH).toBe(process.env.PATH);
  } finally {
    delete process.env.AGENT_TOKEN;
  }
});

test("a new session passes no resume", async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
  });
  expect(query.calls[0]?.options.resume).toBeUndefined();
});

test("commits what the session left uncommitted on the agent branch", async () => {
  const query = scripted([init, success], (cwd) =>
    writeFileSync(join(cwd, "hello.txt"), "x\n"),
  );
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
  });
  const wt = join(root, "worktrees", "agt_1");
  expect(git(wt, "status", "--porcelain")).toBe("");
  expect(git(wt, "log", "-1", "--format=%s")).toBe("agent agt_1 run run_1");
  expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
});

test("an SDK error result posts run.failed with its errors and usage, still commits, and exits 1", async () => {
  const { posted, post } = recorder();
  const query = scripted(
    [
      init,
      {
        ...success,
        subtype: "error_max_turns",
        is_error: true,
        errors: ["hit max turns"],
        result: undefined,
      },
    ],
    (cwd) => writeFileSync(join(cwd, "partial.txt"), "x\n"),
  );
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
  });
  expect(code).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: {
      error: "hit max turns",
      usage: {
        inputTokens: 115,
        outputTokens: 40,
        costUsd: 0.02,
        turns: 2,
        durationMs: 1235,
      },
    },
  });
  expect(git(join(root, "worktrees", "agt_1"), "status", "--porcelain")).toBe(
    "",
  );
});

test("an SDK that throws posts run.failed and exits 1", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    new Error("Claude Code process exited with code 1"),
  ]);
  expect(
    await runSession(config, {
      query,
      post,
      signal: new AbortController().signal,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "Claude Code process exited with code 1" },
  });
});

test("a stream that ends without a result is a failure", async () => {
  const { posted, post } = recorder();
  expect(
    await runSession(config, {
      query: scripted([init]),
      post,
      signal: new AbortController().signal,
    }),
  ).toBe(1);
  expect(posted.at(-1)?.type).toBe("run.failed");
});

test("a worktree that can't be made fails the run before any session starts", async () => {
  const { posted, post } = recorder();
  const query = scripted([init, success]);
  const code = await runSession(
    { ...config, repoDir: join(root, "missing") },
    { query, post, signal: new AbortController().signal },
  );
  expect(code).toBe(1);
  expect(query.calls).toHaveLength(0);
  expect(posted).toEqual([
    {
      runId: "run_1",
      type: "run.failed",
      payload: { error: expect.stringMatching(/worktree/) },
    },
  ]);
});

test("an abort mid-session posts run.failed naming the signal", async () => {
  const { posted, post } = recorder();
  const controller = new AbortController();
  const query = scripted([init, success]);
  const wrapped: QueryFn = (params) => {
    const inner = query(params);
    return (async function* () {
      for await (const m of inner) {
        yield m;
        // the SDK rejects its stream once its abortController fires
        controller.abort("SIGTERM");
        throw new Error("Claude Code process aborted by user");
      }
    })();
  };
  expect(
    await runSession(config, {
      query: wrapped,
      post,
      signal: controller.signal,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM" },
  });
});

/**
 * Live resources once handles closed earlier have finished closing: libuv runs close
 * callbacks after the check phase, so the second `setImmediate` lands past them.
 */
async function liveResources() {
  await setImmediate();
  await setImmediate();
  return process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap");
}

/** What `after` holds beyond `before`; a harness timer that fired meanwhile is not a leak. */
function added(before: string[], after: string[]) {
  const unmatched = [...before];
  return after.filter((r) => {
    const i = unmatched.indexOf(r);
    if (i === -1) return true;
    unmatched.splice(i, 1);
    return false;
  });
}

test("leaves no child process or other handle behind", async () => {
  const before = await liveResources();
  await runSession(config, {
    query: scripted([init, success], (cwd) =>
      writeFileSync(join(cwd, "a.txt"), "a\n"),
    ),
    post: recorder().post,
    signal: new AbortController().signal,
  });
  expect(added(before, await liveResources())).toEqual([]);
});
