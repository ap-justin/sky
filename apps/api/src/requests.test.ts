import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { createDispatcher, type Dispatcher } from "./deliveries.js";
import { mintId } from "./ids.js";
import { failAbandonedWaits, failStaleRuns } from "./runs.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const config = testConfig();
const subscriberUrl = "https://hooks.example.com/sky";
let db: Db;
let app: ReturnType<typeof createApp>;
let dispatcher: Dispatcher;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  // ahead of the real time ingestion stamps next_attempt_at with, so a fresh delivery is due
  const clock = new Date(Date.now() + 60_000);
  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    log: () => {},
    now: () => clock,
  });
  stubSprites();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: dispatcher.nudge,
    longPollMs: 200,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await dispatcher.stop();
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${config.apiKey}` };
const agentId = "agt_test" as AgentId;
const runId = "run_test" as RunId;
const token = mintAgentToken(config.apiKey, runId);

function runningRun() {
  const envId = "env_test" as EnvironmentId;
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
}

const postEvent = (event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const question = () => ({
  kind: "question" as const,
  requestId: mintId("req"),
  prompt: "which branch?",
});

async function subscribe(eventTypes: string[]) {
  const res = await app.request("/v1/webhooks", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ url: subscriberUrl, eventTypes }),
  });
  expect(res.status).toBe(201);
}

function subscriber() {
  const received: unknown[] = [];
  server.use(
    http.post(subscriberUrl, async ({ request }) => {
      received.push(await request.json());
      return new HttpResponse(null, { status: 200 });
    }),
  );
  return received;
}

const statuses = () => ({
  run: db.select({ s: runs.status }).from(runs).get()?.s,
  agent: db.select({ s: agents.status }).from(agents).get()?.s,
});

test("a run.waiting event moves the run and agent to waiting and reaches a subscriber", async () => {
  await subscribe(["run.waiting"]);
  const received = subscriber();
  runningRun();
  const request = question();
  const res = await postEvent({
    runId,
    type: "run.waiting",
    payload: { request },
  });
  expect(res.status).toBe(201);
  expect(statuses()).toEqual({ run: "waiting", agent: "waiting" });
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toMatchObject({
    runId,
    type: "run.waiting",
    payload: { request },
  });
});

async function waitingOn<R extends { requestId: string }>(request: R) {
  runningRun();
  const res = await postEvent({
    runId,
    type: "run.waiting",
    payload: { request },
  });
  expect(res.status).toBe(201);
  return request;
}

const decide = (
  verb: "answers" | "approvals",
  body: unknown,
  id: string = agentId,
) =>
  app.request(`/v1/agents/${id}/${verb}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("an answer moves the run back to running and records the answer as progress", async () => {
  await subscribe(["run.progress"]);
  const received = subscriber();
  const { requestId } = await waitingOn(question());
  const res = await decide("answers", { requestId, answer: "main" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    run: { id: runId, status: "running" },
  });
  expect(statuses()).toEqual({ run: "running", agent: "running" });
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toMatchObject({
    runId,
    type: "run.progress",
    payload: { message: `request ${requestId} answered` },
  });
});

const approval = () => ({
  kind: "approval" as const,
  requestId: mintId("req"),
  toolName: "Bash",
  toolSummary: "rm -rf build",
});

test.each([
  ["approve", {}, "approved"],
  ["deny", { reason: "too broad" }, "denied"],
] as const)(
  "an approval decision %s resumes the run as progress",
  async (decision, extra, verb) => {
    await subscribe(["run.progress"]);
    const received = subscriber();
    const { requestId } = await waitingOn(approval());
    const res = await decide("approvals", { requestId, decision, ...extra });
    expect(res.status).toBe(200);
    expect(statuses()).toEqual({ run: "running", agent: "running" });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({
      payload: { message: `request ${requestId} ${verb}` },
    });
  },
);

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

test("an approval for a question gets 409 wrong_kind and leaves it open", async () => {
  const { requestId } = await waitingOn(question());
  const res = await decide("approvals", { requestId, decision: "approve" });
  expect([res.status, await errorCode(res)]).toEqual([409, "wrong_kind"]);
  expect(statuses().run).toBe("waiting");
  // still open: the right kind of decision lands
  expect((await decide("answers", { requestId, answer: "x" })).status).toBe(
    200,
  );
});

test("an answer for an approval gets 409 wrong_kind", async () => {
  const { requestId } = await waitingOn(approval());
  const res = await decide("answers", { requestId, answer: "x" });
  expect([res.status, await errorCode(res)]).toEqual([409, "wrong_kind"]);
});

test("a second decision gets 409 request_closed", async () => {
  const { requestId } = await waitingOn(question());
  expect((await decide("answers", { requestId, answer: "a" })).status).toBe(
    200,
  );
  const res = await decide("answers", { requestId, answer: "b" });
  expect([res.status, await errorCode(res)]).toEqual([409, "request_closed"]);
});

test("a request unknown to the agent gets 404", async () => {
  const { requestId } = await waitingOn(question());
  const unknown = await decide("answers", {
    requestId: mintId("req"),
    answer: "a",
  });
  expect(unknown.status).toBe(404);
  const otherAgent = await decide(
    "answers",
    { requestId, answer: "a" },
    "agt_other",
  );
  expect(otherAgent.status).toBe(404);
  expect(statuses().run).toBe("waiting");
});

test("a second run.waiting while a request is open gets 409 request_open", async () => {
  await waitingOn(question());
  const res = await postEvent({
    runId,
    type: "run.waiting",
    payload: { request: question() },
  });
  expect([res.status, await errorCode(res)]).toEqual([409, "request_open"]);
});

test("stopping a waiting run leaves its request undecided, and a late answer gets 409 request_closed", async () => {
  const { requestId } = await waitingOn(question());
  const stop = await app.request(`/v1/agents/${agentId}/stop`, {
    method: "POST",
    headers: auth,
  });
  expect(stop.status).toBe(200);
  expect(statuses()).toEqual({ run: "stopped", agent: "idle" });
  const res = await decide("answers", { requestId, answer: "a" });
  expect([res.status, await errorCode(res)]).toEqual([409, "request_closed"]);
});

test("deciding without a bearer gets 401 and decides nothing", async () => {
  const { requestId } = await waitingOn(question());
  const res = await app.request(`/v1/agents/${agentId}/answers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, answer: "a" }),
  });
  expect(res.status).toBe(401);
  expect(statuses().run).toBe("waiting");
});

test("an approve with a reason gets 400", async () => {
  const { requestId } = await waitingOn(approval());
  const res = await decide("approvals", {
    requestId,
    decision: "approve",
    reason: "fine",
  });
  expect(res.status).toBe(400);
});

const poll = (requestId: string, bearer = token, signal?: AbortSignal) =>
  app.request(`/internal/runs/${runId}/requests/${requestId}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal,
  });

// only the poll's own timers are faked, so the wait is exact and a decision's wake-up is the only way out early
const settled = (p: unknown) => {
  let done = false;
  void Promise.resolve(p).then(() => {
    done = true;
  });
  return () => done;
};

test("the long-poll answers pending once its wait runs out, and not before", async () => {
  const { requestId } = await waitingOn(question());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll(requestId);
  const isSettled = settled(pending);
  await vi.advanceTimersByTimeAsync(199);
  expect(isSettled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const res = await pending;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "pending" });
});

test("the long-poll returns the decision as soon as it lands, without its wait running out", async () => {
  const { requestId } = await waitingOn(question());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll(requestId);
  const isSettled = settled(pending);
  // inside the 200 ms wait: the poll is parked when the answer lands
  await vi.advanceTimersByTimeAsync(20);
  expect(isSettled()).toBe(false);
  expect((await decide("answers", { requestId, answer: "main" })).status).toBe(
    200,
  );
  // the clock never reaches 200 ms, so only the decision can have woken it
  const res = await pending;
  expect(await res.json()).toEqual({
    status: "decided",
    decision: { requestId, decision: "answer", answer: "main" },
  });
});

test("the long-poll on an already decided request returns its decision at once", async () => {
  const { requestId } = await waitingOn(approval());
  await decide("approvals", { requestId, decision: "deny", reason: "no" });
  expect(await (await poll(requestId)).json()).toEqual({
    status: "decided",
    decision: { requestId, decision: "deny", reason: "no" },
  });
});

test("the long-poll takes only the run's own agent token", async () => {
  const { requestId } = await waitingOn(question());
  const missing = await app.request(
    `/internal/runs/${runId}/requests/${requestId}`,
  );
  expect(missing.status).toBe(401);
  const other = await poll(
    requestId,
    mintAgentToken(config.apiKey, "run_other"),
  );
  expect(other.status).toBe(401);
  const apiKey = await poll(requestId, config.apiKey);
  expect(apiKey.status).toBe(401);
});

test("an agent token minted under another API key is refused for the run", async () => {
  const { requestId } = await waitingOn(question());
  const rotated = await poll(
    requestId,
    mintAgentToken("other-key".repeat(5), runId),
  );
  expect(rotated.status).toBe(401);
});

test("the long-poll for a request not on the run gets 404", async () => {
  await waitingOn(question());
  expect((await poll(mintId("req"))).status).toBe(404);
});

test("the inactivity sweep leaves a waiting run alone", async () => {
  await waitingOn(question());
  expect(failStaleRuns(db, 1000, Date.now() + 60_000)).toEqual([]);
  expect(statuses().run).toBe("waiting");
});

test("a run waiting past the wait timeout plus 5 minutes is failed with waiting_timeout", async () => {
  await subscribe(["run.failed"]);
  const received = subscriber();
  const { requestId } = await waitingOn(question());
  const wait = 10 * 60_000;
  const grace = 5 * 60_000;
  expect(
    failAbandonedWaits(db, wait, Date.now() + wait + grace - 1000),
  ).toEqual([]);
  expect(
    failAbandonedWaits(db, wait, Date.now() + wait + grace + 1000),
  ).toEqual([runId]);
  expect(statuses()).toEqual({ run: "failed", agent: "idle" });
  await dispatcher.drain();
  expect(received).toEqual([
    expect.objectContaining({ payload: { error: "waiting_timeout" } }),
  ]);
  // the request stays undecided; a late answer finds the run closed
  const res = await decide("answers", { requestId, answer: "a" });
  expect(res.status).toBe(409);
});

const pendingOf = async () => {
  const res = await app.request(`/v1/agents/${agentId}/runs/${runId}`, {
    headers: auth,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { pendingRequest: unknown }).pendingRequest;
};

test.each([
  ["a question", question, { answer: "main" }, "answers"],
  ["an approval", approval, { decision: "approve" }, "approvals"],
] as const)(
  "GET run shows %s as pendingRequest only while it is undecided",
  async (_, make, decision, verb) => {
    runningRun();
    expect(await pendingOf()).toBeNull();
    const request = make();
    const res = await postEvent({
      runId,
      type: "run.waiting",
      payload: { request },
    });
    expect(res.status).toBe(201);
    expect(await pendingOf()).toEqual(request);
    const { requestId } = request;
    expect((await decide(verb, { requestId, ...decision })).status).toBe(200);
    expect(await pendingOf()).toBeNull();
  },
);
