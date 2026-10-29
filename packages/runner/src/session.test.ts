import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerEventPost } from "@harness/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Config } from "./config.js";
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
        yield m as SDKMessage;
      }
    })();
  };
  return Object.assign(fn, { calls });
}

const recorder = () => {
  const posted: RunnerEventPost[] = [];
  return { posted, post: async (e: RunnerEventPost) => void posted.push(e) };
};

test("a finished run posts started, progress, then finished with the SDK usage, and exits 0", async () => {
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
      type: "run.progress",
      payload: { message: "hello.txt", tool: "Write" },
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

test("leaves no child process or other handle behind", async () => {
  const before = process
    .getActiveResourcesInfo()
    .filter((r) => r !== "TTYWrap");
  await runSession(config, {
    query: scripted([init, success], (cwd) =>
      writeFileSync(join(cwd, "a.txt"), "a\n"),
    ),
    post: recorder().post,
    signal: new AbortController().signal,
  });
  const after = process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap");
  expect(after).toEqual(before);
});
