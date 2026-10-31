import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  migrate,
  openDb,
  runs,
  webhookDeliveries,
} from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import {
  createDispatcher,
  type Dispatcher,
  retryDelayMs,
  signatureHeader,
} from "./deliveries.js";
import { failStaleRuns } from "./runs.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const key = "webhook-signing-key-for-tests-0123456789";

/** A receiver's check, written from the documented scheme with WebCrypto rather than the sender's code. */
async function verify(
  header: string,
  body: string,
  nowSeconds: number,
): Promise<boolean> {
  const parts = new Map(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const t = Number(parts.get("t"));
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false;
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Buffer.from(parts.get("v1") ?? "", "hex");
  return crypto.subtle.verify(
    "HMAC",
    hmac,
    sig,
    new TextEncoder().encode(`${t}.${body}`),
  );
}

test("the signature header verifies under the documented scheme, and only for its own body and time", async () => {
  const body = '{"id":"evt_1","type":"run.finished"}';
  const header = signatureHeader(key, body, 1_800_000_000);
  expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
  expect(await verify(header, body, 1_800_000_000)).toBe(true);
  expect(await verify(header, `${body} `, 1_800_000_000)).toBe(false);
  expect(await verify(header, body, 1_800_000_000 + 301)).toBe(false);
});

test.each([
  [1, 0.5, 10_000],
  [2, 0.5, 20_000],
  [7, 0.5, 640_000],
  [9, 0.5, 2_560_000],
  [10, 0.5, 3_600_000],
  [20, 0.5, 3_600_000],
  [1, 0, 8_000],
  [1, 1, 12_000],
  [20, 1, 4_320_000],
])(
  "after %i attempts with random %d the next try waits %ims",
  (attempts, random, ms) => {
    expect(retryDelayMs(attempts, random)).toBeCloseTo(ms);
  },
);

const config = testConfig();
const subscriberUrl = "https://hooks.example.com/sky";
let db: Db;
let app: ReturnType<typeof createApp>;
let dispatcher: Dispatcher;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  logs = [];
  // ahead of the real time ingestion stamps next_attempt_at with, so a fresh delivery is due
  clock = new Date(Date.now() + 60_000);
  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    log: (line) => logs.push(line),
    now: () => clock,
    random: () => 0.5,
  });
  stubSprites();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: dispatcher.nudge,
  });
});
afterEach(async () => {
  await dispatcher.stop();
  if (db.$client.open) db.$client.close();
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const auth = { Authorization: `Bearer ${config.apiKey}` };

async function subscribe(eventTypes: string[], url = subscriberUrl) {
  const res = await app.request("/v1/webhooks", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ url, eventTypes }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function runningRun() {
  const envId = "env_test" as EnvironmentId;
  const agentId = "agt_test" as AgentId;
  const runId = "run_test" as RunId;
  db.insert(environments)
    .values({
      id: envId,
      name: "e",
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: "sky-env_test",
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
  return { agentId, runId, token: mintAgentToken(config.apiKey, runId) };
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

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  turns: 1,
  durationMs: 1,
};

type Received = { headers: Headers; body: string };

/** A subscriber answering each POST with the next status in `statuses`. */
function subscriber(statuses: number[], url = subscriberUrl) {
  const received: Received[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  return received;
}

const deliveries = () => db.select().from(webhookDeliveries).all();

test("a subscriber answering 500, 500, 200 gets three signed attempts of one event, then it is delivered", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber([500, 500, 200]);
  const { agentId, runId, token } = runningRun();
  const planted = [
    config.claudeOauthToken,
    config.spritesToken,
    config.webhookSigningKey,
    `ghp_${"a1B2".repeat(9)}`,
  ];

  // claude.Message isn't subscribed, so only the finish is enqueued
  expect(
    (
      await postEvent(token, {
        runId,
        type: "claude.Message",
        payload: { text: "working" },
      })
    ).status,
  ).toBe(201);
  const posted = await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: `done; leaked ${planted.join(" and ")}`, usage },
  });
  expect(posted.status).toBe(201);
  const { id: eventId } = (await posted.json()) as { id: number };

  await dispatcher.drain();
  expect(received).toHaveLength(1);
  // not due until the backoff has passed
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  advance(10_000);
  await dispatcher.drain();
  expect(received).toHaveLength(2);
  advance(20_000);
  await dispatcher.drain();
  expect(received).toHaveLength(3);
  const lastSentAt = Math.floor(clock.getTime() / 1000);
  advance(3_600_000);
  await dispatcher.drain();
  expect(received).toHaveLength(3);

  expect(deliveries()).toEqual([
    expect.objectContaining({
      eventId,
      status: "delivered",
      attempts: 3,
      lastStatus: 200,
    }),
  ]);
  for (const { headers, body } of received) {
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("sky-event-id")).toBe(`evt_${eventId}`);
    expect(headers.get("sky-event-type")).toBe("run.finished");
    const signature = headers.get("sky-signature") ?? "";
    expect(await verify(signature, body, lastSentAt)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      id: `evt_${eventId}`,
      agentId,
      runId,
      ts: expect.stringMatching(/Z$/),
      type: "run.finished",
      payload: { summary: expect.stringContaining("[redacted]"), usage },
    });
    for (const secret of planted) expect(body).not.toContain(secret);
  }
});

test("each attempt is signed with its own clock second, so a retry after 300 s still verifies", async () => {
  await subscribe(["run.finished"]);
  const sentAt: number[] = [];
  const received: Received[] = [];
  const statuses = [500, 500, 500, 500, 500, 200];
  server.use(
    http.post(subscriberUrl, async ({ request }) => {
      sentAt.push(Math.floor(clock.getTime() / 1000));
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "done", usage },
  });

  // 10, 20, 40, 80, 160 s backoffs: the sixth attempt lands 310 s after the first
  await dispatcher.drain();
  for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000]) {
    advance(wait);
    await dispatcher.drain();
  }

  expect(received).toHaveLength(6);
  expect(sentAt.at(-1)).toBeGreaterThan((sentAt[0] ?? 0) + 300);
  for (const [i, { headers, body }] of received.entries()) {
    const signature = headers.get("sky-signature") ?? "";
    expect(signature.split(",")[0]).toBe(`t=${sentAt[i]}`);
    expect(await verify(signature, body, sentAt[i] ?? 0)).toBe(true);
  }
});

test("each matching subscription gets its own delivery of the event", async () => {
  await subscribe(["run.finished"]);
  await subscribe(
    ["claude.Message", "run.finished"],
    "https://b.example.com/h",
  );
  await subscribe(["claude.Message"], "https://c.example.com/h");
  const a = subscriber([200]);
  const b = subscriber([200], "https://b.example.com/h");
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect([a.length, b.length]).toEqual([1, 1]);
  expect(deliveries().map((d) => d.status)).toEqual(["delivered", "delivered"]);
});

test("a claude.PostToolUse event reaches a webhook subscribed to it, redacted and trimmed", async () => {
  await subscribe(["claude.PostToolUse"]);
  const received = subscriber([200]);
  const { agentId, runId, token } = runningRun();
  const payload = {
    toolName: "Bash",
    toolUseId: "tu_1",
    input: '{"command":"env"}',
    output: `SIGNING=${config.webhookSigningKey}\n${"a".repeat(5_000)}`,
  };
  expect(
    (await postEvent(token, { runId, type: "claude.PostToolUse", payload }))
      .status,
  ).toBe(201);
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  const body = JSON.parse(received[0]?.body ?? "") as {
    agentId: string;
    type: string;
    payload: { output: string };
  };
  expect(body).toMatchObject({ agentId, runId, type: "claude.PostToolUse" });
  expect(body.payload.output).toMatch(
    /^SIGNING=\[redacted\]\na+\n…\[truncated \d+ chars\]$/,
  );
  expect(received[0]?.body).not.toContain(config.webhookSigningKey);
});

test("a slow subscriber never holds up the runner's post", async () => {
  await subscribe(["run.finished"]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  server.use(
    http.post(subscriberUrl, async () => {
      reached = true;
      await gate;
      return new HttpResponse(null, { status: 200 });
    }),
  );
  const { runId, token } = runningRun();
  const posted = await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  expect(posted.status).toBe(201);
  await expect.poll(() => reached).toBe(true);
  expect(deliveries()[0]?.status).toBe("pending");
  release();
  await dispatcher.drain();
  expect(deliveries()[0]?.status).toBe("delivered");
});

test("a network error records no status, the reason, and a retry", async () => {
  await subscribe(["run.finished"]);
  server.use(http.post(subscriberUrl, () => HttpResponse.error()));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastStatus: null,
      lastError: expect.any(String),
      nextAttemptAt: new Date(clock.getTime() + 10_000).toISOString(),
    }),
  ]);
});

test("a redirect is a failed attempt, never followed", async () => {
  await subscribe(["run.finished"]);
  server.use(
    http.post(
      subscriberUrl,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.com/" },
        }),
    ),
  );
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastStatus: 302,
    }),
  ]);
});

test("an attempt is cut off after 30 s and recorded as a timeout", async () => {
  await subscribe(["run.finished"]);
  subscriber([200]);
  const { runId, token } = runningRun();
  // AbortSignal.timeout runs on Node's own timers, out of reach of fake ones
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
  let timeouts: unknown[][];
  try {
    // ingestion nudges the dispatcher, so the attempt may start before drain() is called
    await postEvent(token, {
      runId,
      type: "run.finished",
      payload: { summary: "ok", usage },
    });
    await dispatcher.drain();
  } finally {
    timeouts = [...timeout.mock.calls];
    timeout.mockRestore();
  }
  expect(timeouts).toEqual([[30_000]]);
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastError: "timed out after 30s",
    }),
  ]);
});

test("each failed attempt logs one line naming the webhook, event, attempt and status", async () => {
  const webhookId = await subscribe(["run.finished"]);
  server.use(http.post(subscriberUrl, () => HttpResponse.error()));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  subscriber([500]);
  advance(3_600_000);
  await dispatcher.drain();
  const eventId = `evt_${deliveries()[0]?.eventId}`;
  expect(logs).toEqual([
    expect.stringMatching(
      new RegExp(`^webhook ${webhookId} ${eventId}: attempt 1/30 failed: \\S`),
    ),
    `webhook ${webhookId} ${eventId}: attempt 2/30 failed: status 500`,
  ]);
});

test("after 30 failed attempts the delivery is failed and never tried again", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber(Array(31).fill(503));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  for (let i = 0; i < 31; i++) {
    await dispatcher.drain();
    advance(3_600_000);
  }
  expect(received).toHaveLength(30);
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "failed",
      attempts: 30,
      lastStatus: 503,
    }),
  ]);
  expect(logs).toHaveLength(30);
  expect(logs.at(-1)).toMatch(
    /^warn: webhook whk_\w+ evt_\d+: attempt 30\/30 failed: status 503; giving up$/,
  );
});

/** A subscriber answering every POST with a 429, carrying `retryAfter` when given. */
function rateLimited(retryAfter?: string, url = subscriberUrl) {
  const received: string[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      received.push(await request.text());
      return new HttpResponse(null, {
        status: 429,
        headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      });
    }),
  );
  return received;
}

const finishRun = async () => {
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
};

test.each([
  ["delta-seconds", () => "120", () => 120_000],
  [
    "an HTTP-date",
    () => new Date(clock.getTime() + 300_000).toUTCString(),
    () =>
      Date.parse(new Date(clock.getTime() + 300_000).toUTCString()) -
      clock.getTime(),
  ],
  ["a value past the 1 h cap", () => "86400", () => 3_600_000],
  ["a date in the past", () => new Date(0).toUTCString(), () => 5_000],
  ["zero", () => "0", () => 5_000],
  ["an unparseable value", () => "soon", () => 10_000],
])(
  "a 429 with Retry-After as %s sets the next attempt from it",
  async (_, header, delayMs) => {
    await subscribe(["run.finished"]);
    rateLimited(header());
    await finishRun();
    expect(deliveries()).toEqual([
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        lastStatus: 429,
        nextAttemptAt: new Date(clock.getTime() + delayMs()).toISOString(),
      }),
    ]);
  },
);

test("a 429 without Retry-After backs off as any failed attempt does", async () => {
  await subscribe(["run.finished"]);
  rateLimited();
  await finishRun();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      attempts: 1,
      lastStatus: 429,
      nextAttemptAt: new Date(clock.getTime() + 10_000).toISOString(),
    }),
  ]);
});

test("a 429 holds the webhook's other pending deliveries, without spending their attempts, while another webhook's are still sent", async () => {
  const limited = await subscribe(["claude.PostToolUse"]);
  const other = await subscribe(
    ["claude.PostToolUse"],
    "https://b.example.com/h",
  );
  await dispatcher.stop();
  const { runId, token } = runningRun();
  for (const toolUseId of ["tu_1", "tu_2"]) {
    const payload = { toolName: "Bash", toolUseId, input: "{}", output: "" };
    await postEvent(token, { runId, type: "claude.PostToolUse", payload });
  }
  // the second of the limited webhook's deliveries comes due after the 429 lands, before it expires
  const [, held] = deliveries().filter((d) => d.webhookId === limited);
  db.update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(clock.getTime() + 30_000).toISOString() })
    .where(eq(webhookDeliveries.id, held?.id ?? -1))
    .run();
  const a = rateLimited("120");
  const b = subscriber([200, 200], "https://b.example.com/h");
  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    log: () => {},
    now: () => clock,
    random: () => 0.5,
  });
  await dispatcher.drain();
  expect([a.length, b.length]).toEqual([1, 2]);
  const retryAt = new Date(clock.getTime() + 120_000).toISOString();
  expect(
    deliveries().map((d) => [
      d.webhookId,
      d.status,
      d.attempts,
      d.nextAttemptAt,
    ]),
  ).toEqual([
    [limited, "pending", 1, retryAt],
    [other, "delivered", 1, expect.any(String)],
    [limited, "pending", 0, retryAt],
    [other, "delivered", 1, expect.any(String)],
  ]);
  advance(60_000);
  await dispatcher.drain();
  expect(a).toHaveLength(1);
});

test("pending deliveries left by a previous process are sent once a dispatcher starts", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber([200]);
  const { runId, token } = runningRun();
  await dispatcher.stop();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  expect(received).toHaveLength(0);

  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    log: () => {},
    now: () => clock,
  });
  dispatcher.start();
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  expect(deliveries()[0]?.status).toBe("delivered");
});

test("stopping a run delivers its run.stopped event to a subscriber", async () => {
  await subscribe(["run.stopped"]);
  const received = subscriber([200]);
  const { runId } = runningRun();
  const res = await app.request("/v1/agents/agt_test/stop", {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(200);
  // no drain: the stop itself wakes the dispatcher
  await expect.poll(() => received.length).toBe(1);
  expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
    runId,
    type: "run.stopped",
  });
});

test("a run the sweep times out delivers its run.failed event to a subscriber", async () => {
  await subscribe(["run.failed"]);
  const received = subscriber([200]);
  const { runId } = runningRun();
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([runId]);
  await dispatcher.drain();
  expect(received.map((r) => JSON.parse(r.body))).toEqual([
    expect.objectContaining({
      runId,
      type: "run.failed",
      payload: { error: "runner_timeout" },
    }),
  ]);
});
