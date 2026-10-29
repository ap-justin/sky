import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, environments, migrate, openDb } from "@harness/db";
import type { EnvironmentId } from "@harness/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { failStaleRuns } from "./runs.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const bundle = "// runner bundle v1\n";
let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-agents-"));
  writeFileSync(join(dir, "runner.mjs"), bundle);
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  config = testConfig({ runnerBundlePath: join(dir, "runner.mjs") });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${testConfig().apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

/** A provisioned environment whose sprite exists on the stub. */
function readyEnv(
  overrides: Partial<typeof environments.$inferInsert> = {},
): EnvironmentId {
  const id = `env_${Math.random().toString(36).slice(2)}` as EnvironmentId;
  db.insert(environments)
    .values({
      id,
      name: id,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: `harness-${id}`,
      checkpointId: "v1",
      ...overrides,
    })
    .run();
  wire.sprites.add(`harness-${id}`);
  return id;
}

const launch = (body: unknown) =>
  app.request("/v1/agents", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

type Launched = {
  agent: { id: string; branch: string };
  run: { id: string; status: string };
};

const launched = async (envId: string, prompt = "fix the flaky test") => {
  const res = await launch({ envId, prompt });
  expect(res.status).toBe(202);
  return (await res.json()) as Launched;
};

/** Waits until the background launch has opened its runner session. */
const sessionOpened = (count = 1) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

test("POST returns 202 with the agent on claude/<agentId> and a starting run", async () => {
  const envId = readyEnv();
  const res = await launch({ envId, prompt: "fix the flaky test" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Launched;
  const iso = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  expect(body).toEqual({
    agent: {
      id: expect.stringMatching(/^agt_[0-9A-Za-z]+$/),
      envId,
      sessionId: null,
      branch: `claude/${body.agent.id}`,
      status: "running",
      createdAt: iso,
    },
    run: {
      id: expect.stringMatching(/^run_[0-9A-Za-z]+$/),
      agentId: body.agent.id,
      status: "starting",
      summary: null,
      usage: null,
      error: null,
      createdAt: iso,
    },
  });
  expect(res.headers.get("location")).toBe(
    `/v1/agents/${body.agent.id}/runs/${body.run.id}`,
  );
  await sessionOpened();
});

test("launch uploads the bundle, then starts the runner as a detached session and lets go of it", async () => {
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await sessionOpened();
  const sprite = `harness-${envId}`;
  expect(wire.calls).toEqual([
    `exec ${sprite} - sha256sum /opt/harness/runner.mjs`,
    `write ${sprite} /opt/harness/runner.mjs`,
    `write ${sprite} /workspace/runs/${run.id}.prompt`,
    expect.stringMatching(`^session ${sprite} /workspace/repo bash -c `),
  ]);
  expect(
    new TextDecoder().decode(wire.files.get("/opt/harness/runner.mjs")),
  ).toBe(bundle);
  expect(
    new TextDecoder().decode(
      wire.files.get(`/workspace/runs/${run.id}.prompt`),
    ),
  ).toBe("fix the flaky test");

  const [session] = wire.sessions;
  // detachable: the process outlives the socket, which the API closes as soon as it opens
  expect(session).toMatchObject({ detachable: true, tty: true });
  await vi.waitFor(() => expect(wire.openSockets).toBe(0));
  expect(session?.argv.join(" ")).toContain(
    "exec node /opt/harness/runner.mjs",
  );
  expect(session?.env).toEqual({
    AGENT_ID: agent.id,
    RUN_ID: run.id,
    API_BASE_URL: config.publicBaseUrl,
    AGENT_TOKEN: expect.any(String),
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
    PROMPT_FILE: `/workspace/runs/${run.id}.prompt`,
    REPO_DIR: "/workspace/repo",
    WORKTREES_DIR: "/workspace/worktrees",
  });
});

test("secrets travel as process env only: never argv, the run row, an event or the logs", async () => {
  const { run } = await launched(readyEnv());
  await sessionOpened();
  const session = wire.sessions[0];
  const secrets = [
    config.claudeOauthToken,
    session?.env.AGENT_TOKEN ?? "missing",
  ];
  const stored = JSON.stringify([
    db.$client.prepare("select * from runs").all(),
    db.$client.prepare("select * from agents").all(),
    db.$client.prepare("select * from events").all(),
  ]);
  for (const secret of secrets) {
    expect(session?.argv.join(" ")).not.toContain(secret);
    expect(stored).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
  }
  expect(run.status).toBe("starting");
});

test("a sprite already holding the current bundle gets no upload", async () => {
  wire.files.set("/opt/harness/runner.mjs", new TextEncoder().encode(bundle));
  const envId = readyEnv();
  await launched(envId);
  await sessionOpened();
  expect(wire.calls.filter((c) => c.startsWith("write"))).toEqual([
    expect.stringMatching(/\.prompt$/),
  ]);
});

test("two agents on one env get distinct worktrees and branches", async () => {
  const envId = readyEnv();
  const a = await launched(envId);
  const b = await launched(envId);
  await sessionOpened(2);
  expect(a.agent.branch).toBe(`claude/${a.agent.id}`);
  expect(b.agent.branch).toBe(`claude/${b.agent.id}`);
  expect(a.agent.id).not.toBe(b.agent.id);
  const agentIds = wire.sessions.map((s) => s.env.AGENT_ID);
  expect(new Set(agentIds)).toEqual(new Set([a.agent.id, b.agent.id]));
  // the runner derives its worktree from AGENT_ID: <WORKTREES_DIR>/<agentId> on claude/<agentId>
  expect(new Set(wire.sessions.map((s) => s.env.WORKTREES_DIR)).size).toBe(1);
});

test("launching past the env's cap gets a typed 409 naming the cap, and nothing is queued", async () => {
  const envId = readyEnv({ concurrency: 2 });
  await launched(envId);
  await launched(envId);
  const res = await launch({ envId, prompt: "third" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: {
      code: "concurrency_cap",
      message: "this environment allows 2 active runs",
      limit: 2,
    },
  });
  await sessionOpened(2);
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 2,
  });
});

test("the default cap is 3", async () => {
  const envId = readyEnv();
  for (let i = 0; i < 3; i++) await launched(envId);
  expect((await launch({ envId, prompt: "fourth" })).status).toBe(409);
  await sessionOpened(3);
});

test.each([
  ["provisioning", 409, "env_not_ready"],
  ["failed", 409, "env_not_ready"],
] as const)("an env that is %s gets %i %s", async (status, code, errCode) => {
  const envId = readyEnv({ status });
  const res = await launch({ envId, prompt: "go" });
  expect(res.status).toBe(code);
  expect(await res.json()).toMatchObject({ error: { code: errCode } });
});

test("an unknown env gets 404", async () => {
  const res = await launch({ envId: "env_nope", prompt: "go" });
  expect(res.status).toBe(404);
});

test.each([
  ["no prompt", { envId: "env_x" }],
  ["an empty prompt", { envId: "env_x", prompt: "" }],
  ["an unknown key", { envId: "env_x", prompt: "go", extra: 1 }],
])("a body with %s gets 400", async (_, body) => {
  expect((await launch(body)).status).toBe(400);
});

test("POST without a bearer gets 401 and launches nothing", async () => {
  const envId = readyEnv();
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envId, prompt: "go" }),
  });
  expect(res.status).toBe(401);
  expect(wire.calls).toEqual([]);
});

test("a launch the sprite rejects fails the run with a redacted error and frees the agent", async () => {
  wire.writeStatus = 500;
  const { agent, run } = await launched(readyEnv());
  await vi.waitFor(() =>
    expect(
      db.$client.prepare("select status from runs where id = ?").get(run.id),
    ).toEqual({ status: "failed" }),
  );
  const res = await app.request(`/v1/agents/${agent.id}/runs/${run.id}`, {
    headers: auth,
  });
  expect(await res.json()).toMatchObject({
    status: "failed",
    error: expect.stringMatching(/^launch_failed: /),
  });
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
  expect(wire.sessions).toEqual([]);
});

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  costUsd: 0.04,
  turns: 3,
  durationMs: 41_000,
};

/** Launches a run and returns the agent token its runner was handed. */
async function runningRun(envId = readyEnv()) {
  const before = wire.sessions.length;
  const ids = await launched(envId);
  await sessionOpened(before + 1);
  const token = wire.sessions[before]?.env.AGENT_TOKEN ?? "";
  return { ...ids, envId, token };
}

const postEvent = (token: string, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const getRun = async (agentId: string, runId: string) => {
  const res = await app.request(`/v1/agents/${agentId}/runs/${runId}`, {
    headers: auth,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

test("events from the run's own token advance it: started stores the session, finished the result", async () => {
  const { agent, run, token } = await runningRun();
  const started = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "sess-1" },
  });
  expect(started.status).toBe(201);
  expect(await started.json()).toEqual({ id: expect.any(Number) });
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(
    db.$client.prepare("select session_id, status from agents").get(),
  ).toEqual({ session_id: "sess-1", status: "running" });

  const progress = await postEvent(token, {
    runId: run.id,
    type: "run.progress",
    payload: { message: "reading the test", tool: "Read" },
  });
  expect(progress.status).toBe(201);
  expect(
    (
      await postEvent(token, {
        runId: run.id,
        type: "run.finished",
        payload: { summary: "fixed the race", usage },
      })
    ).status,
  ).toBe(201);

  expect(
    db.$client.prepare("select type from events order by id").all(),
  ).toEqual([
    { type: "run.started" },
    { type: "run.progress" },
    { type: "run.finished" },
  ]);
  expect(db.$client.prepare("select status from agents").get()).toEqual({
    status: "idle",
  });
  const { body } = await getRun(agent.id, run.id);
  expect(body).toMatchObject({
    status: "finished",
    summary: "fixed the race",
    usage,
    error: null,
  });
});

test("a failed event records its error and frees the agent", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.failed",
    payload: { error: "claude exited 1" },
  });
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "claude exited 1",
    usage: null,
  });
});

test("another live run's token gets 403 and stores nothing", async () => {
  const envId = readyEnv();
  const a = await runningRun(envId);
  const b = await runningRun(envId);
  const res = await postEvent(b.token, {
    runId: a.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(res.status).toBe(403);
  expect(db.$client.prepare("select count(*) n from events").get()).toEqual({
    n: 0,
  });
});

test("an ended run's token gets 401", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.stopped",
    payload: {},
  });
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.progress",
    payload: { message: "late" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: "run_ended" } });
});

test.each([
  ["a garbage token", { Authorization: "Bearer not-a-token" }],
  ["the API key", { Authorization: `Bearer ${testConfig().apiKey}` }],
  ["no token", {}],
])("%s gets 401", async (_, authHeader) => {
  const { run } = await runningRun();
  const res = await app.request("/internal/events", {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    }),
  });
  expect(res.status).toBe(401);
});

test("an event outside the shared schema gets 400", async () => {
  const { run, token } = await runningRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: {},
  });
  expect(res.status).toBe(400);
});

test("an event the transition table forbids gets 409 and leaves the run as it was", async () => {
  const { agent, run, token } = await runningRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "skipped start", usage },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "invalid_transition" },
  });
  expect((await getRun(agent.id, run.id)).body.status).toBe("starting");
});

test("secrets a runner echoes are redacted before the event is stored", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.progress",
    payload: {
      message: `env: AGENT_TOKEN=${token} CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`,
    },
  });
  const stored = JSON.stringify(
    db.$client.prepare("select * from events").all(),
  );
  expect(stored).not.toContain(token);
  expect(stored).not.toContain(config.claudeOauthToken);
  expect(stored).toContain("AGENT_TOKEN=[redacted]");
});

async function finishedRun() {
  const r = await runningRun();
  await postEvent(r.token, {
    runId: r.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(r.token, {
    runId: r.run.id,
    type: "run.finished",
    payload: { summary: "done", usage },
  });
  return r;
}

const patch = "diff --git a/x b/x\n+fixed\n";

test("GET of an ended run returns its branch and its diff against the env's base branch", async () => {
  const { agent, run, envId } = await finishedRun();
  wire.exec = (argv) =>
    argv[0] === "git" ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toEqual({
    id: run.id,
    agentId: agent.id,
    status: "finished",
    summary: "done",
    usage,
    error: null,
    createdAt: expect.any(String),
    branch: `claude/${agent.id}`,
    diff: patch,
  });
  expect(wire.calls.at(-1)).toBe(
    `exec harness-${envId} /workspace/repo git diff origin/HEAD...claude/${agent.id}`,
  );
});

test("GET of an active run has a null diff and never wakes the sprite", async () => {
  const { agent, run } = await runningRun();
  const calls = wire.calls.length;
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
    diff: null,
  });
  expect(wire.calls).toHaveLength(calls);
});

test("GET of an ended run whose branch never existed has a null diff", async () => {
  const { agent, run } = await finishedRun();
  wire.exec = () => ({ exitCode: 128, stderr: "fatal: bad revision\n" });
  expect((await getRun(agent.id, run.id)).body).toMatchObject({ diff: null });
});

test("GET while the sprite is unreachable gets 502", async () => {
  const { agent, run, envId } = await finishedRun();
  wire.sprites.delete(`harness-${envId}`);
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(502);
  expect(body).toMatchObject({ error: { code: "sprite_unreachable" } });
});

test.each([
  ["an unknown run", (a: string) => `/v1/agents/${a}/runs/run_nope`],
  ["a malformed id", () => "/v1/agents/nope/runs/nope"],
])("GET of %s gets 404", async (_, path) => {
  const { agent } = await runningRun();
  const res = await app.request(path(agent.id), { headers: auth });
  expect(res.status).toBe(404);
});

test("GET of a run under another agent gets 404", async () => {
  const envId = readyEnv();
  const a = await runningRun(envId);
  const b = await runningRun(envId);
  expect((await getRun(b.agent.id, a.run.id)).status).toBe(404);
});

test("GET without a bearer gets 401", async () => {
  const { agent, run } = await runningRun();
  const res = await app.request(`/v1/agents/${agent.id}/runs/${run.id}`);
  expect(res.status).toBe(401);
});

test("a run silent past the timeout is failed with runner_timeout, freeing its cap slot", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const timeout = config.runTimeoutMs;
  expect(failStaleRuns(db, timeout, Date.now() + timeout - 1000)).toEqual([]);
  expect(failStaleRuns(db, timeout, Date.now() + timeout + 1000)).toEqual([
    run.id,
  ]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "runner_timeout",
  });
  // the runner, if it was only slow, is now told its run is over
  expect(
    (
      await postEvent(token, {
        runId: run.id,
        type: "run.progress",
        payload: { message: "late" },
      })
    ).status,
  ).toBe(401);
  await launched(envId);
  await sessionOpened(2);
});
