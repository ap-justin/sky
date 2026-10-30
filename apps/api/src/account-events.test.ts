import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, RunId } from "@sky/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { anyRun, runEvents } from "./run-events.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";
import { sseReader } from "./testing/sse.js";

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
  vi.useRealTimers();
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
      spriteName: `sky-${envId}`,
      checkpointId: "v1",
    })
    .run();
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status: "running" }).run();
  return { agentId, runId };
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

const say = (runId: RunId, text: string) =>
  post(runId, "claude.Message", { text });
const toolUse = (runId: RunId) =>
  post(runId, "claude.PreToolUse", {
    toolName: "Bash",
    toolUseId: "t1",
    input: '{"command":"ls"}',
  });

const stream = (query = "", headers: Record<string, string> = {}) =>
  app.request(`/v1/stream${query}`, { headers: { ...auth, ...headers } });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

test("the stream delivers new events from every agent in id order", async () => {
  const a = runningRun();
  const b = runningRun();
  await say(a.runId, "before connect");
  const res = await stream();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const s = sseReader(res);
  await until(() => runEvents.listenerCount(anyRun) === 1);
  const ids = [
    await say(a.runId, "a1"),
    await say(b.runId, "b1"),
    await say(a.runId, "a2"),
  ];
  const frames = [await s.event(), await s.event(), await s.event()];
  await s.cancel();
  expect(frames.map((f) => f?.id)).toEqual(ids.map(String));
  expect(frames.map((f) => f?.event)).toEqual(Array(3).fill("claude.Message"));
  expect(JSON.parse(frames[1]?.data ?? "")).toEqual({
    id: `evt_${ids[1]}`,
    agentId: b.agentId,
    runId: b.runId,
    ts: expect.any(String),
    type: "claude.Message",
    payload: { text: "b1" },
  });
});

test("a reconnect with Last-Event-ID gets exactly the events it missed", async () => {
  const a = runningRun();
  const b = runningRun();
  const seen = await say(a.runId, "seen");
  const missed = [await say(b.runId, "m1"), await say(a.runId, "m2")];
  const s = sseReader(await stream("", { "Last-Event-ID": String(seen) }));
  expect((await s.event())?.id).toBe(String(missed[0]));
  expect((await s.event())?.id).toBe(String(missed[1]));
  const live = await say(b.runId, "live");
  expect((await s.event())?.id).toBe(String(live));
  await s.cancel();
});

test("the stream takes ?after= as an event id, and Last-Event-ID over it", async () => {
  const a = runningRun();
  const one = await say(a.runId, "one");
  const two = await say(a.runId, "two");
  const three = await say(a.runId, "three");
  const fromQuery = sseReader(await stream(`?after=evt_${one}`));
  expect((await fromQuery.event())?.id).toBe(String(two));
  await fromQuery.cancel();
  const s = sseReader(
    await stream(`?after=evt_${one}`, { "Last-Event-ID": String(two) }),
  );
  expect((await s.event())?.id).toBe(String(three));
  await s.cancel();
});

test("?types= and ?agentId= filter the stream", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  await say(a.runId, "not a tool");
  await toolUse(b.runId);
  const wanted = await toolUse(a.runId);
  await say(a.runId, "after");
  const s = sseReader(
    await stream(
      `?after=evt_${start}&types=claude.PreToolUse,run.failed&agentId=${a.agentId}`,
    ),
  );
  expect((await s.event())?.id).toBe(String(wanted));
  const failed = await post(a.runId, "run.failed", { error: "boom" });
  expect((await s.event())?.id).toBe(String(failed));
  await s.cancel();
});

test("a quiet stream pings, and a disconnect releases its listener", async () => {
  const s = sseReader(await stream());
  expect(await s.next()).toEqual({ id: "0" });
  expect(await s.next()).toEqual({ comment: "ping", id: "0" });
  expect(runEvents.listenerCount(anyRun)).toBe(1);
  await s.cancel();
  await until(() => runEvents.listenerCount(anyRun) === 0);
});

const waiting = (runId: RunId) =>
  post(runId, "run.waiting", {
    request: { kind: "question", requestId: "req_1", prompt: "which?" },
  });

/** Resolves true once `count` pings arrive within `ms`, false if the stream ends or time runs out first. */
const pings = (s: ReturnType<typeof sseReader>, count: number, ms: number) =>
  Promise.race([
    (async () => {
      for (let seen = 0; seen < count; ) {
        const frame = await s.next();
        if (!frame) return false;
        if (frame.comment === "ping") seen++;
      }
      return true;
    })(),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

test("a stream filtered to run.waiting keeps pinging every heartbeat while unrelated events flow", async () => {
  const a = runningRun();
  const s = sseReader(await stream("?types=run.waiting"));
  let flowing = true;
  const flow = (async () => {
    while (flowing) {
      await say(a.runId, "busy");
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    // heartbeatMs is 50, so three pings fit in 150 ms plus slack
    expect(await pings(s, 3, 400)).toBe(true);
  } finally {
    flowing = false;
    await flow;
    await s.cancel();
  }
});

test("a stream opened with no cursor sends its id before any event and with each ping, past filtered-out rows", async () => {
  const a = runningRun();
  const before = await say(a.runId, "before");
  const s = sseReader(await stream("?types=run.waiting"));
  expect(await s.next()).toEqual({ id: String(before) });
  const skipped = await say(a.runId, "filtered out");
  let ping = await s.next();
  // a ping already due when `skipped` landed may still carry the open cursor
  if (ping?.id === String(before)) ping = await s.next();
  expect(ping).toEqual({ comment: "ping", id: String(skipped) });
  await s.cancel();
});

test("a reconnect with the id from a stream's open gets the events published in between", async () => {
  const a = runningRun();
  await say(a.runId, "before");
  const first = sseReader(await stream("?types=run.waiting"));
  const opened = await first.next();
  await first.cancel();
  await say(a.runId, "while away");
  const missed = await waiting(a.runId);
  const again = sseReader(
    await stream("?types=run.waiting", { "Last-Event-ID": opened?.id ?? "" }),
  );
  expect((await again.event())?.id).toBe(String(missed));
  await again.cancel();
});

const poll = (query = "", signal?: AbortSignal) =>
  app.request(`/v1/events${query}`, { headers: auth, signal });

type Page = { data: { id: string; type: string }[]; cursor: string };

/** Resolves once a poll is subscribed and waiting; setImmediate isn't among the faked timers. */
const parked = async () => {
  for (let i = 0; i < 100 && runEvents.listenerCount(anyRun) === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(runEvents.listenerCount(anyRun)).toBe(1);
};

// only the poll's own timers are faked, so a wake-up is the only way out before the wait runs out
const settled = (p: unknown) => {
  let done = false;
  void Promise.resolve(p).then(() => {
    done = true;
  });
  return () => done;
};

test("a poll with events already past its cursor returns them at once, oldest first", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  const ids = [await say(b.runId, "one"), await say(a.runId, "two")];
  const res = await poll(`?after=evt_${start}`);
  expect(res.status).toBe(200);
  const page = (await res.json()) as Page;
  expect(page.data.map((e) => e.id)).toEqual(ids.map((id) => `evt_${id}`));
  expect(page.cursor).toBe(`evt_${ids[1]}`);
});

test("a poll returns a page of 100 and a cursor at its last event", async () => {
  const a = runningRun();
  const start = await say(a.runId, "start");
  const ids = [];
  for (let i = 0; i < 101; i++) ids.push(await say(a.runId, `m${i}`));
  const page = (await (await poll(`?after=evt_${start}`)).json()) as Page;
  expect(page.data).toHaveLength(100);
  expect(page.cursor).toBe(`evt_${ids[99]}`);
  const next = (await (await poll(`?after=${page.cursor}`)).json()) as Page;
  expect(next.data.map((e) => e.id)).toEqual([`evt_${ids[100]}`]);
});

test("a waiting poll returns as soon as a matching event lands", async () => {
  const a = runningRun();
  await say(a.runId, "old");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll("?types=claude.PreToolUse");
  const isSettled = settled(pending);
  await parked();
  await vi.advanceTimersByTimeAsync(1000);
  expect(isSettled()).toBe(false);
  await say(a.runId, "not a tool");
  await vi.advanceTimersByTimeAsync(1000);
  expect(isSettled()).toBe(false);
  const id = await toolUse(a.runId);
  // the clock stays well inside the 30 s wait, so only the event can have woken it
  const page = (await (await pending).json()) as Page;
  expect(page).toEqual({
    data: [expect.objectContaining({ id: `evt_${id}` })],
    cursor: `evt_${id}`,
  });
});

test("a poll that times out returns no events and the start as its cursor", async () => {
  const a = runningRun();
  const latest = await say(a.runId, "old");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll("?wait=5");
  const isSettled = settled(pending);
  await parked();
  await vi.advanceTimersByTimeAsync(4999);
  expect(isSettled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await pending).json()).toEqual({
    data: [],
    cursor: `evt_${latest}`,
  });
});

test("a timed-out poll's cursor moves past the events its filter skipped", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  await toolUse(b.runId);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll(`?after=evt_${start}&agentId=${a.agentId}`);
  await parked();
  await vi.advanceTimersByTimeAsync(1000);
  const skipped = await say(b.runId, "other agent");
  await vi.advanceTimersByTimeAsync(29_000);
  expect(await (await pending).json()).toEqual({
    data: [],
    cursor: `evt_${skipped}`,
  });
});

test("?wait=0 answers at once", async () => {
  runningRun();
  expect(await (await poll("?wait=0&after=evt_0")).json()).toEqual({
    data: [],
    cursor: "evt_0",
  });
});

test.each([
  ["an after that isn't an event id", "?after=run_1", "invalid_cursor"],
  ["a Last-Event-ID-style negative", "?after=-1", "invalid_cursor"],
  ["a cursor with trailing junk", "?after=evt_1%26x%3D2", "invalid_cursor"],
  ["an unknown type", "?types=claude.Message,run.progress", "invalid_query"],
  ["an empty types", "?types=", "invalid_query"],
])("%s gets 400 on both routes", async (_, query, code) => {
  for (const res of [await poll(query), await stream(query)]) {
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
  }
});

test.each(["?wait=31", "?wait=1.5", "?wait=soon"])(
  "a poll with %s gets 400",
  async (query) => {
    const res = await poll(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  },
);

test("a malformed Last-Event-ID gets 400", async () => {
  const res = await stream("", { "Last-Event-ID": "nope" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
});

test.each(["agt_missing", "nope"])(
  "an unknown agentId %s gets 404 on both routes",
  async (agentId) => {
    for (const res of [
      await poll(`?agentId=${agentId}`),
      await stream(`?agentId=${agentId}`),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", message: "no such agent" },
      });
    }
  },
);

test("both routes take only the API key", async () => {
  for (const path of ["/v1/events?wait=0", "/v1/stream"]) {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  }
  expect(runEvents.listenerCount(anyRun)).toBe(0);
});

test("reading events makes no sprite call", async () => {
  const a = runningRun();
  const start = await say(a.runId, "start");
  const s = sseReader(await stream(`?after=evt_${start}`));
  await say(a.runId, "live");
  await s.event();
  await s.next();
  await s.cancel();
  await (await poll(`?after=evt_${start}`)).json();
  expect(wire.calls).toEqual([]);
});
