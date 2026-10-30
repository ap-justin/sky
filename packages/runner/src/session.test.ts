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
import { RUNNER_TEXT_MAX, type RunnerEventPost } from "@sky/shared";
import { delay, HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import type { Config } from "./config.js";
import { createPoster } from "./events.js";
import { createDecisionWaiter } from "./requests.js";
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
    approvalPolicy: [],
    waitTimeoutMs: 60_000,
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
/** Assistant text from inside the subagent the Agent call `parentToolUseId` started. */
const subagentSays = (parentToolUseId: string, text: string) => ({
  ...assistant({ type: "text", text }),
  parent_tool_use_id: parentToolUseId,
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
        // the SDK rejects its stream once its abortController fires
        if (params.options.abortController?.signal.aborted)
          throw new Error("Claude Code process aborted by user");
      }
    })();
  };
  return Object.assign(fn, { calls });
}

/** For runs that hold nothing: any wait fails the test. */
const noDecision = async (): Promise<never> => {
  throw new Error("no request should wait");
};

const recorder = () => {
  const posted: RunnerEventPost[] = [];
  return { posted, post: async (e: RunnerEventPost) => void posted.push(e) };
};

const finished = {
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
    rollup: expect.any(Object),
  },
};

/** Events as the API receives them: through the real poster, so each one passed the shared schema. */
function apiPoster() {
  const sent: RunnerEventPost[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push((await request.json()) as RunnerEventPost);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    warn: () => {},
    sleep: async () => {},
  });
  return { sent, post };
}

test("a finished run posts started, assistant text as claude.Message, then finished with the SDK usage, and exits 0", async () => {
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
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(posted).toEqual([
    { runId: "run_1", type: "run.started", payload: { sessionId: "sess-new" } },
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "I'll add the file." },
    },
    finished,
  ]);
});

test("each hook reaches the API as its claude.* event, in hook order, and nothing posts run.progress", async () => {
  const { sent, post } = apiPoster();
  const query = scripted([
    init,
    hook("Notification", {
      message: "Claude needs your attention",
      title: "Waiting",
      notification_type: "idle_prompt",
    }),
    assistant({ type: "text", text: "Looking around." }),
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls -la src" },
      tool_use_id: "t1",
    }),
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls -la src" },
      tool_response: { stdout: "a.ts", stderr: "" },
      tool_use_id: "t1",
      duration_ms: 12,
    }),
    hook("SubagentStart", { agent_id: "sub_1", agent_type: "Explore" }),
    hook("PreToolUse", {
      agent_id: "sub_1",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_use_id: "t2",
    }),
    hook("PostToolUse", {
      agent_id: "sub_1",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "export {}",
      tool_use_id: "t2",
    }),
    hook("PostToolUseFailure", {
      agent_id: "sub_1",
      tool_name: "Grep",
      tool_input: { pattern: "x" },
      tool_use_id: "t3",
      error: "no matches",
      is_interrupt: false,
      duration_ms: 3,
    }),
    hook("SubagentStop", {
      stop_hook_active: false,
      agent_id: "sub_1",
      agent_transcript_path: "/s.jsonl",
      agent_type: "Explore",
      last_assistant_message: "Found a.ts.",
    }),
    hook("TaskCreated", {
      task_id: "1",
      task_subject: "Add hello.txt",
      task_description: "write the file",
    }),
    hook("TaskCompleted", { task_id: "1", task_subject: "Add hello.txt" }),
    hook("PreCompact", { trigger: "auto", custom_instructions: null }),
    hook("FileChanged", { file_path: "/w/.env", event: "change" }),
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
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  const ls = JSON.stringify({ command: "ls -la src" });
  const read = JSON.stringify({ file_path: "src/a.ts" });
  expect(sent).toEqual(
    [
      { type: "run.started", payload: { sessionId: "sess-new" } },
      {
        type: "claude.Notification",
        payload: {
          message: "Claude needs your attention",
          title: "Waiting",
          notificationType: "idle_prompt",
        },
      },
      { type: "claude.Message", payload: { text: "Looking around." } },
      {
        type: "claude.PreToolUse",
        payload: { toolName: "Bash", toolUseId: "t1", input: ls },
      },
      {
        type: "claude.PostToolUse",
        payload: {
          toolName: "Bash",
          toolUseId: "t1",
          input: ls,
          output: JSON.stringify({ stdout: "a.ts", stderr: "" }),
          durationMs: 12,
        },
      },
      {
        type: "claude.SubagentStart",
        payload: { subagentId: "sub_1", agentType: "Explore" },
      },
      {
        type: "claude.PreToolUse",
        payload: {
          toolName: "Read",
          toolUseId: "t2",
          input: read,
          subagentId: "sub_1",
        },
      },
      {
        type: "claude.PostToolUse",
        payload: {
          toolName: "Read",
          toolUseId: "t2",
          input: read,
          output: "export {}",
          subagentId: "sub_1",
        },
      },
      {
        type: "claude.PostToolUseFailure",
        payload: {
          toolName: "Grep",
          toolUseId: "t3",
          input: JSON.stringify({ pattern: "x" }),
          subagentId: "sub_1",
          error: "no matches",
          isInterrupt: false,
          durationMs: 3,
        },
      },
      {
        type: "claude.SubagentStop",
        payload: {
          subagentId: "sub_1",
          agentType: "Explore",
          lastAssistantMessage: "Found a.ts.",
        },
      },
      {
        type: "claude.TaskCreated",
        payload: {
          taskId: "1",
          taskSubject: "Add hello.txt",
          taskDescription: "write the file",
        },
      },
      {
        type: "claude.TaskCompleted",
        payload: { taskId: "1", taskSubject: "Add hello.txt" },
      },
      {
        type: "claude.PreCompact",
        payload: { trigger: "auto", customInstructions: null },
      },
      {
        type: "claude.FileChanged",
        payload: { filePath: "/w/.env", event: "change" },
      },
      finished,
    ].map((e) => ({ runId: "run_1", ...e })),
  );
});

test("tool text is sent whole up to RUNNER_TEXT_MAX and cut there, never clipped short ahead of redaction", async () => {
  const { sent, post } = apiPoster();
  const big = "x".repeat(100_000);
  const query = scripted([
    init,
    assistant({ type: "text", text: "y".repeat(20_000) }),
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: big },
      tool_response: big,
      tool_use_id: "t1",
    }),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const message = sent.find((e) => e.type === "claude.Message");
  expect(message?.type === "claude.Message" && message.payload.text).toBe(
    "y".repeat(20_000),
  );
  const tool = sent.find((e) => e.type === "claude.PostToolUse");
  expect(tool?.type === "claude.PostToolUse" && tool.payload).toMatchObject({
    output: big.slice(0, RUNNER_TEXT_MAX),
    input: JSON.stringify({ command: big }).slice(0, RUNNER_TEXT_MAX),
  });
});

test("a subagent's text carries the Agent call's parentToolUseId; main-thread text has none", async () => {
  const { sent, post } = apiPoster();
  const query = scripted([
    init,
    assistant({ type: "text", text: "Delegating." }),
    subagentSays("toolu_agent", "Found a.ts."),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(sent.filter((e) => e.type === "claude.Message")).toEqual([
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "Delegating." },
    },
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "Found a.ts.", parentToolUseId: "toolu_agent" },
    },
  ]);
});

/** A query whose producer runs ahead of the consumer, as the SDK reads the CLI's stdout while the runner is still posting. */
function eager(
  produce: (options: Options, push: (m: unknown) => void) => Promise<void>,
): QueryFn {
  return ({ options }) => {
    const buffered: unknown[] = [];
    let done = false;
    let wake = () => {};
    void produce(options, (m) => {
      buffered.push(m);
      wake();
    }).finally(() => {
      done = true;
      wake();
    });
    return (async function* () {
      while (true) {
        const next = buffered.shift();
        if (next !== undefined) yield next as SDKMessage;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    })();
  };
}

test("with a slow API, text and hook events post in stream order and the ending event comes after all of them", async () => {
  const posted: RunnerEventPost[] = [];
  const post = async (e: RunnerEventPost) => {
    await new Promise((r) => setTimeout(r, 20));
    posted.push(e);
  };
  const query = eager(async (options, push) => {
    push(init);
    // run.started has landed before Claude says anything
    await new Promise((r) => setTimeout(r, 60));
    push(assistant({ type: "text", text: "First." }));
    await setImmediate();
    push(assistant({ type: "text", text: "Second." }));
    await setImmediate();
    await fire(options, "PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "t1",
    });
    await setImmediate();
    push(success);
  });
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(
    posted.map((e) =>
      e.type === "claude.Message" ? `${e.type}:${e.payload.text}` : e.type,
    ),
  ).toEqual([
    "run.started",
    "claude.Message:First.",
    "claude.Message:Second.",
    "claude.PreToolUse",
    "run.finished",
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
    awaitDecision: noDecision,
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
    if (e.type === "claude.PreToolUse" && e.payload.toolName === "Bash") {
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
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(posted.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.finished",
  ]);
});

test("runs the session in the agent worktree, resuming the stored session, without AGENT_TOKEN in its env", async () => {
  process.env.AGENT_TOKEN = "agent-secret";
  try {
    const query = scripted([init, success]);
    await runSession(
      { ...config, sessionId: "sess-old" },
      {
        query,
        post: recorder().post,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
      },
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

test("the session commits as Claude through its env, so nothing writes the clone's git config", async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(query.calls[0]?.options.env).toMatchObject({
    GIT_AUTHOR_NAME: "Claude",
    GIT_AUTHOR_EMAIL: "noreply@anthropic.com",
    GIT_COMMITTER_NAME: "Claude",
    GIT_COMMITTER_EMAIL: "noreply@anthropic.com",
  });
});

test("the PreToolUse hook outlasts the longest wait, so a late approval still reaches the tool call", async () => {
  const query = scripted([init, success]);
  const waitTimeoutMs = 120 * 60_000;
  await runSession(
    { ...config, waitTimeoutMs },
    {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  const matchers = query.calls[0]?.options.hooks?.PreToolUse ?? [];
  expect(matchers).not.toHaveLength(0);
  for (const { timeout } of matchers) {
    // seconds; a call queued behind other waits needs several wait timeouts
    expect(timeout).toBeGreaterThanOrEqual((10 * waitTimeoutMs) / 1000);
    // past 2^31-1 ms a Node timer fires at once; a tenth of that leaves room for drift in the SDK
    expect((timeout ?? 0) * 1000).toBeLessThan(2 ** 31 / 10);
  }
});

test("a stop before the session starts still aborts it", async () => {
  const { posted, post } = recorder();
  const controller = new AbortController();
  controller.abort("SIGTERM");
  const query = scripted([init, success]);
  expect(
    await runSession(config, {
      query,
      post,
      signal: controller.signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(query.calls[0]?.options.abortController?.signal.aborted).toBe(true);
  expect(posted.at(-1)).toMatchObject({
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM" },
  });
});

test("a new session passes no resume", async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
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
    awaitDecision: noDecision,
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
    awaitDecision: noDecision,
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
      rollup: expect.any(Object),
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
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: {
      error: "Claude Code process exited with code 1",
      rollup: expect.any(Object),
    },
  });
});

test("a stream that ends without a result is a failure", async () => {
  const { posted, post } = recorder();
  expect(
    await runSession(config, {
      query: scripted([init]),
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)?.type).toBe("run.failed");
});

test("a worktree that can't be made fails the run before any session starts", async () => {
  const { posted, post } = recorder();
  const query = scripted([init, success]);
  const code = await runSession(
    { ...config, repoDir: join(root, "missing") },
    {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
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
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM", rollup: expect.any(Object) },
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

/** What `after` holds beyond `before`; a sky timer that fired meanwhile is not a leak. */
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
    awaitDecision: noDecision,
  });
  expect(added(before, await liveResources())).toEqual([]);
});

type DecisionReply = (requestId: string) => Promise<Response> | Response;

/** The API's two internal routes: events land in `sent`; each decision poll is answered by the next reply, the last one repeating. */
function api(...replies: DecisionReply[]) {
  const sent: RunnerEventPost[] = [];
  const polls: { auth: string | null; requestId: string }[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push((await request.json()) as RunnerEventPost);
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
    http.get(
      "https://api.test/internal/runs/run_1/requests/:requestId",
      ({ request, params }) => {
        const requestId = String(params.requestId);
        polls.push({ auth: request.headers.get("authorization"), requestId });
        const reply = replies[Math.min(polls.length, replies.length) - 1];
        return reply?.(requestId) ?? new HttpResponse(null, { status: 500 });
      },
    ),
  );
  const deps = {
    post: createPoster({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      warn: () => {},
      sleep: async () => {},
    }),
    awaitDecision: createDecisionWaiter({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      runId: "run_1",
      retryDelayMs: 0,
    }),
    signal: new AbortController().signal,
  };
  return { sent, polls, deps };
}

const pending: DecisionReply = () => HttpResponse.json({ status: "pending" });
const decided =
  (decision: object): DecisionReply =>
  (requestId) =>
    HttpResponse.json({
      status: "decided",
      decision: { requestId, ...decision },
    });

const gitPush = {
  tool_name: "Bash",
  tool_input: { command: "git push origin main", description: "Push" },
  tool_use_id: "t1",
};
/** Fires PreToolUse for `gitPush` whatever the hook answers. */
const firePush: Step = async (options) =>
  void (await fire(options, "PreToolUse", gitPush));

test("a held tool call posts approval waiting, polls past pending, and an approval lets the tool run", async () => {
  const { sent, polls, deps } = api(pending, decided({ decision: "approve" }));
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(code).toBe(0);
  expect(answers).toEqual([{ continue: true }]);
  const waiting = sent.find((e) => e.type === "run.waiting");
  expect(waiting).toEqual({
    runId: "run_1",
    type: "run.waiting",
    payload: {
      request: {
        kind: "approval",
        requestId: expect.stringMatching(/^req_[0-9A-Za-z]+$/),
        toolName: "Bash",
        toolSummary: "git push origin main",
      },
    },
  });
  const requestId =
    waiting?.type === "run.waiting" ? waiting.payload.request.requestId : "";
  expect(polls).toEqual([
    { auth: "Bearer agent-secret", requestId },
    { auth: "Bearer agent-secret", requestId },
  ]);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.waiting",
    "run.finished",
  ]);
});

test("a long approval summary reaches run.waiting whole, for the API to redact before it trims", async () => {
  const { sent, deps } = api(decided({ decision: "approve" }));
  const command = `git push ${"x".repeat(5000)}`;
  const query = scripted([
    init,
    async (options: Options) =>
      void (await fire(options, "PreToolUse", {
        ...gitPush,
        tool_input: { command },
      })),
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  const waiting = sent.find((e) => e.type === "run.waiting");
  expect(
    waiting?.type === "run.waiting" &&
      waiting.payload.request.kind === "approval" &&
      waiting.payload.request.toolSummary,
  ).toBe(command);
});

test("a denial blocks the tool and hands Claude the reason", async () => {
  const { deps } = api(decided({ decision: "deny", reason: "open a PR" }));
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(answers).toEqual([
    {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "open a PR",
      },
    },
  ]);
});

test("a call the policy doesn't hold never waits", async () => {
  const { sent, polls, deps } = api();
  const query = scripted([
    init,
    hook("PreToolUse", { ...gitPush, tool_input: { command: "git status" } }),
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(polls).toEqual([]);
  expect(sent.map((e) => e.type)).not.toContain("run.waiting");
});

const questions = [
  {
    question: "Which database?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "Postgres", description: "Managed, relational" },
      { label: "SQLite", description: "One file" },
    ],
  },
];

test("Claude's question posts question waiting, and the answer goes back as the tool's answers", async () => {
  const { sent, deps } = api(decided({ decision: "answer", answer: "SQLite" }));
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  expect(await runSession(config, { ...deps, query })).toBe(0);
  expect(sent.find((e) => e.type === "run.waiting")?.payload).toEqual({
    request: {
      kind: "question",
      requestId: expect.stringMatching(/^req_/),
      prompt:
        "Which database?\n- Postgres: Managed, relational\n- SQLite: One file",
    },
  });
  expect(permission).toEqual({
    behavior: "allow",
    updatedInput: { questions, answers: { "Which database?": "SQLite" } },
  });
});

test("a declined question tells Claude the user declined", async () => {
  const { deps } = api(decided({ decision: "deny" }));
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  await runSession(config, { ...deps, query });
  expect(permission).toEqual({
    behavior: "deny",
    message: "The user declined to answer.",
  });
});

test("a wait past the max aborts the session, commits, and fails the run with waiting_timeout", async () => {
  const { sent, deps } = api(async () => {
    await delay("infinite");
    return new HttpResponse(null, { status: 500 });
  });
  const timed = scripted([init, firePush, success], (cwd) =>
    writeFileSync(join(cwd, "partial.txt"), "x\n"),
  );
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"], waitTimeoutMs: 50 },
    { ...deps, query: timed },
  );
  expect(code).toBe(1);
  expect(sent.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "waiting_timeout", rollup: expect.any(Object) },
  });
  expect(git(join(root, "worktrees", "agt_1"), "status", "--porcelain")).toBe(
    "",
  );
});

test("a run the API already ended stops the session and posts nothing terminal", async () => {
  const { sent, deps } = api(() =>
    HttpResponse.json(
      { error: { code: "run_ended", message: "the run has ended" } },
      { status: 401 },
    ),
  );
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query: scripted([init, firePush, success]) },
  );
  expect(code).toBe(1);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.waiting",
  ]);
});

const rollupOf = (event: RunnerEventPost | undefined) =>
  event?.type === "run.finished" || event?.type === "run.failed"
    ? event.payload.rollup
    : undefined;

test("run.finished carries the rollup: this run's commit, and the branch's commits since base", async () => {
  const worktree = join(root, "worktrees", "agt_1");
  const base = git(join(root, "repo"), "rev-parse", "origin/HEAD");
  const first = recorder();
  await runSession(config, {
    query: scripted([init, success], (cwd) =>
      writeFileSync(join(cwd, "hello.txt"), "hi\n"),
    ),
    post: first.post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const firstSha = git(worktree, "rev-parse", "HEAD");
  const firstRun = {
    commits: [{ sha: firstSha, subject: "agent agt_1 run run_1" }],
    files: 1,
    added: 1,
    removed: 0,
  };
  expect(rollupOf(first.posted.at(-1))).toEqual({
    base,
    run: firstRun,
    cumulative: firstRun,
  });

  const second = recorder();
  await runSession(
    { ...config, runId: "run_2" },
    {
      query: scripted([init, success], (cwd) =>
        writeFileSync(join(cwd, "hello.txt"), "hello\n"),
      ),
      post: second.post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  const secondSha = git(worktree, "rev-parse", "HEAD");
  expect(rollupOf(second.posted.at(-1))).toEqual({
    base,
    run: {
      commits: [{ sha: secondSha, subject: "agent agt_1 run run_2" }],
      files: 1,
      added: 1,
      removed: 1,
    },
    cumulative: {
      commits: [
        { sha: secondSha, subject: "agent agt_1 run run_2" },
        { sha: firstSha, subject: "agent agt_1 run run_1" },
      ],
      files: 1,
      added: 1,
      removed: 0,
    },
  });
});

test("a run that changed nothing finishes with an empty run rollup", async () => {
  const { posted, post } = recorder();
  await runSession(config, {
    query: scripted([init, success]),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const empty = { commits: [], files: 0, added: 0, removed: 0 };
  expect(rollupOf(posted.at(-1))).toEqual({
    base: git(join(root, "repo"), "rev-parse", "origin/HEAD"),
    run: empty,
    cumulative: empty,
  });
});

test("run.failed still carries the rollup of what the run committed", async () => {
  const { posted, post } = recorder();
  const code = await runSession(config, {
    query: scripted(
      [init, new Error("Claude Code process exited with code 1")],
      (cwd) => writeFileSync(join(cwd, "partial.txt"), "x\n"),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(1);
  expect(posted.at(-1)).toMatchObject({
    type: "run.failed",
    payload: {
      error: "Claude Code process exited with code 1",
      rollup: {
        run: {
          commits: [{ subject: "agent agt_1 run run_1" }],
          files: 1,
          added: 1,
          removed: 0,
        },
      },
    },
  });
});

test("a rollup that can't be computed is left off with one warning; the run still finishes", async () => {
  const { posted, post } = recorder();
  const warnings: string[] = [];
  const code = await runSession(config, {
    // without origin/HEAD there is no base to diff against
    query: scripted([init, success], () =>
      git(join(root, "repo"), "remote", "set-head", "origin", "--delete"),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    warn: (line) => warnings.push(line),
  });
  expect(code).toBe(0);
  expect(posted.at(-1)?.type).toBe("run.finished");
  expect(rollupOf(posted.at(-1))).toBeUndefined();
  expect(warnings).toEqual([
    expect.stringMatching(/^runner: rollup skipped: /),
  ]);
});
