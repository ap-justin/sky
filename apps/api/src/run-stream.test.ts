import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  migrate,
  openDb,
  runs,
} from "@harness/db";
import type { AgentId, RunId } from "@harness/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { runEvents } from "./run-events.js";
import { failStaleRuns } from "./runs.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const config = testConfig();
const auth = { Authorization: `Bearer ${config.apiKey}` };
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
    heartbeatMs: 50,
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

/** A running run on a fresh agent, inserted directly so no sprite is involved. */
function runningRun() {
  const n = Math.random().toString(36).slice(2);
  const envId = `env_${n}` as const;
  const agentId = `agt_${n}` as AgentId;
  const runId = `run_${n}` as RunId;
  db.insert(environments)
    .values({
      id: envId,
      name: envId,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: `harness-${envId}`,
      checkpointId: "v1",
    })
    .run();
  wire.sprites.add(`harness-${envId}`);
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status: "running" }).run();
  return { agentId, runId, token: mintAgentToken(config.apiKey, runId) };
}

async function post(runId: RunId, type: string, payload: object) {
  const res = await app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mintAgentToken(config.apiKey, runId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId, type, payload }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const progress = (runId: RunId, message: string) =>
  post(runId, "run.progress", { message });

type Frame = { id?: string; event?: string; data?: string; comment?: string };

/** Reads SSE frames off a response body, one at a time. */
function sseReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Frame | null> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame: Frame = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) frame.comment = line.slice(1).trim();
            const m = /^(id|event|data): ?(.*)$/.exec(line);
            if (m) frame[m[1] as "id" | "event" | "data"] = m[2];
          }
          return frame;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /** The next frame that isn't a heartbeat. */
    async event(): Promise<Frame | null> {
      for (;;) {
        const frame = await this.next();
        if (!frame?.comment) return frame;
      }
    },
    cancel: () => reader.cancel(),
  };
}

const stream = (
  agentId: AgentId,
  runId: RunId,
  headers: Record<string, string> = {},
  query = "",
) =>
  app.request(`/v1/agents/${agentId}/runs/${runId}/stream${query}`, {
    headers: { ...auth, ...headers },
  });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

test("a reconnect with Last-Event-ID continues at the next event with no gap or duplicate", async () => {
  const { agentId, runId } = runningRun();
  const ids = [];
  for (const m of ["one", "two", "three", "four", "five"]) {
    ids.push(await progress(runId, m));
  }
  const first = await stream(agentId, runId);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const a = sseReader(first);
  const seen: Frame[] = [];
  for (let i = 0; i < 3; i++) seen.push((await a.event()) as Frame);
  await a.cancel();
  expect(seen.map((f) => f.id)).toEqual(ids.slice(0, 3).map(String));

  const second = await stream(agentId, runId, {
    "Last-Event-ID": String(ids[2]),
  });
  const b = sseReader(second);
  const fourth = await b.event();
  expect(fourth).toEqual({
    id: String(ids[3]),
    event: "run.progress",
    data: expect.any(String),
  });
  expect(JSON.parse(fourth?.data ?? "")).toEqual({
    id: `evt_${ids[3]}`,
    runId,
    ts: expect.any(String),
    type: "run.progress",
    payload: { message: "four" },
  });
  expect((await b.event())?.id).toBe(String(ids[4]));
  const live = await progress(runId, "six");
  expect((await b.event())?.id).toBe(String(live));
  await b.cancel();
});

test("a client disconnect releases its listener", async () => {
  const { agentId, runId } = runningRun();
  await progress(runId, "one");
  const s = sseReader(await stream(agentId, runId));
  await s.event();
  expect(runEvents.listenerCount(runId)).toBe(1);
  await s.cancel();
  await until(() => runEvents.listenerCount(runId) === 0);
});

test("a quiet stream sends heartbeat comments", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  expect(await s.next()).toEqual({ comment: "ping" });
  await s.cancel();
});

/** Every event frame until the stream ends. */
async function rest(s: ReturnType<typeof sseReader>) {
  const frames: Frame[] = [];
  for (let f = await s.event(); f; f = await s.event()) frames.push(f);
  return frames;
}

test("the stream closes after the run's terminal event and lets go of its listener", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  await progress(runId, "working");
  await post(runId, "run.finished", {
    summary: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
      durationMs: 1,
    },
  });
  expect((await rest(s)).map((f) => f.event)).toEqual([
    "run.progress",
    "run.finished",
  ]);
  expect(runEvents.listenerCount(runId)).toBe(0);
});

test("an ended run's stream replays from the cursor and closes", async () => {
  const { agentId, runId } = runningRun();
  const first = await progress(runId, "one");
  await progress(runId, "two");
  const failed = await post(runId, "run.failed", { error: "boom" });
  const s = sseReader(await stream(agentId, runId, {}, `?after=${first}`));
  expect((await rest(s)).map((f) => f.event)).toEqual([
    "run.progress",
    "run.failed",
  ]);
  const past = sseReader(
    await stream(agentId, runId, { "Last-Event-ID": String(failed) }),
  );
  expect(await rest(past)).toEqual([]);
});

test("Last-Event-ID wins over a stale ?after= from the original URL", async () => {
  const { agentId, runId } = runningRun();
  const one = await progress(runId, "one");
  const two = await progress(runId, "two");
  const three = await progress(runId, "three");
  const s = sseReader(
    await stream(
      agentId,
      runId,
      { "Last-Event-ID": String(two) },
      `?after=${one}`,
    ),
  );
  expect((await s.event())?.id).toBe(String(three));
  await s.cancel();
});

test("a stop ends a live stream with run.stopped", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  const res = await app.request(`/v1/agents/${agentId}/stop`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(200);
  expect((await rest(s)).map((f) => f.event)).toEqual(["run.stopped"]);
});

test("the inactivity sweep ends a live stream with run.failed", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([runId]);
  const [failed, ...after] = await rest(s);
  expect(failed?.event).toBe("run.failed");
  expect(JSON.parse(failed?.data ?? "").payload).toEqual({
    error: "runner_timeout",
  });
  expect(after).toEqual([]);
});

test("a stream without a bearer gets 401 and subscribes nothing", async () => {
  const { agentId, runId } = runningRun();
  const res = await app.request(`/v1/agents/${agentId}/runs/${runId}/stream`);
  expect(res.status).toBe(401);
  expect(runEvents.listenerCount(runId)).toBe(0);
});

test("a run under another agent gets 404", async () => {
  const { runId } = runningRun();
  const other = runningRun();
  const res = await stream(other.agentId, runId);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no such run" },
  });
});

test.each([
  ["a Last-Event-ID", { "Last-Event-ID": "evt_3" }, ""],
  ["an ?after=", {}, "?after=-1"],
])("%s that isn't an event row id gets 400", async (_, headers, query) => {
  const { agentId, runId } = runningRun();
  const res = await stream(agentId, runId, headers, query);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
});
