import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { createDecisionWaiter } from "./requests.js";

const url = "https://api.test/internal/runs/run_1/requests/req_1";
const options = {
  apiBaseUrl: "https://api.test",
  agentToken: "agent-secret",
  runId: "run_1",
  sleep: async () => {},
};
const waitFor = createDecisionWaiter(options);
const inAMinute = () => Date.now() + 60_000;

/** A sleep that only advances a virtual clock, so a long wait runs at once. */
function virtualClock() {
  const clock = {
    time: 0,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

const approved = () =>
  HttpResponse.json({
    status: "decided",
    decision: { requestId: "req_1", decision: "approve" },
  });

test("rides out a dropped connection and a 5xx, then returns the decision", async () => {
  let calls = 0;
  server.use(
    http.get(url, () => {
      calls++;
      if (calls === 1) return HttpResponse.error();
      if (calls === 2) return new HttpResponse(null, { status: 502 });
      return approved();
    }),
  );
  expect(
    await waitFor("req_1", new AbortController().signal, inAMinute()),
  ).toEqual({
    kind: "decided",
    decision: { requestId: "req_1", decision: "approve" },
  });
  expect(calls).toBe(3);
});

test("a request the API never stored is lost", async () => {
  server.use(
    http.get(url, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "no such request" } },
        { status: 404 },
      ),
    ),
  );
  expect(
    await waitFor("req_1", new AbortController().signal, inAMinute()),
  ).toEqual({ kind: "lost" });
});

test("rejects with the signal's reason once it aborts", async () => {
  server.use(http.get(url, () => HttpResponse.json({ status: "pending" })));
  const controller = new AbortController();
  const waiting = waitFor("req_1", controller.signal, inAMinute());
  controller.abort(new Error("deadline"));
  await expect(waiting).rejects.toThrow("deadline");
});

test("gives up on a poll the API never answers and asks again", async () => {
  // a sprite pause can leave the poll's connection open on this side and gone on the API's
  let calls = 0;
  server.use(
    http.get(url, async () => {
      calls++;
      if (calls === 1) await new Promise(() => {});
      return approved();
    }),
  );
  const waitBounded = createDecisionWaiter({ ...options, pollTimeoutMs: 50 });
  expect(
    await waitBounded("req_1", new AbortController().signal, inAMinute()),
  ).toEqual({
    kind: "decided",
    decision: { requestId: "req_1", decision: "approve" },
  });
  expect(calls).toBe(2);
});

test("a stop during a poll the API never answers rejects with its reason at once", async () => {
  server.use(http.get(url, () => new Promise<never>(() => {})));
  const controller = new AbortController();
  const waiting = waitFor("req_1", controller.signal, inAMinute());
  setTimeout(() => controller.abort(new Error("deadline")), 10);
  await expect(waiting).rejects.toThrow("deadline");
});

test("a stop during a backoff pause rejects with its reason at once", async () => {
  server.use(http.get(url, () => new HttpResponse(null, { status: 503 })));
  const controller = new AbortController();
  const waitStoppable = createDecisionWaiter({
    ...options,
    // a pause that only a stop ends
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        controller.abort(new Error("stopped"));
      }),
  });
  await expect(
    waitStoppable("req_1", controller.signal, inAMinute()),
  ).rejects.toThrow("stopped");
});

test("failed polls back off with jitter, and a good reply resets the backoff", async () => {
  const clock = virtualClock();
  const replies = [503, 503, 503, "pending", 429, "decided"] as const;
  let calls = 0;
  server.use(
    http.get(url, () => {
      const reply = replies[calls++];
      if (reply === "pending") return HttpResponse.json({ status: "pending" });
      if (reply === "decided") return approved();
      return new HttpResponse(null, { status: reply });
    }),
  );
  const wait = createDecisionWaiter({
    ...options,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
  });
  expect(
    await wait("req_1", new AbortController().signal, 600_000),
  ).toMatchObject({ kind: "decided" });
  // half of 500 · 2^n; pending is asked again at once, and the 429 after it starts over
  expect(clock.slept).toEqual([250, 500, 1000, 250]);
});

test("an API unreachable until the deadline rejects naming the last failure", async () => {
  const clock = virtualClock();
  server.use(http.get(url, () => new HttpResponse(null, { status: 503 })));
  const wait = createDecisionWaiter({
    ...options,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
  });
  await expect(
    wait("req_1", new AbortController().signal, 300_000),
  ).rejects.toThrow(
    "API unreachable while waiting for request req_1: HTTP 503",
  );
  expect(clock.time).toBe(300_000);
});

test("a deadline reached while the API keeps answering pending expires the wait", async () => {
  const clock = virtualClock();
  let calls = 0;
  server.use(
    http.get(url, () => {
      // a regression in the deadline check ends in this failure, not in a loop
      if (++calls > 20) return new HttpResponse(null, { status: 403 });
      // the API holds each poll; here the hold is virtual
      clock.time += 25_000;
      return HttpResponse.json({ status: "pending" });
    }),
  );
  const wait = createDecisionWaiter({
    ...options,
    sleep: clock.sleep,
    now: clock.now,
  });
  expect(await wait("req_1", new AbortController().signal, 100_000)).toEqual({
    kind: "expired",
  });
  expect(calls).toBe(4);
});

test("a deadline reached with failures and pending replies alternating expires the wait rather than reporting the API unreachable", async () => {
  // a good reply clears the last failure, so only a run of failures up to the deadline reads as unreachable
  const clock = virtualClock();
  let calls = 0;
  server.use(
    http.get(url, () => {
      if (++calls > 20) return new HttpResponse(null, { status: 403 });
      if (calls % 2) return new HttpResponse(null, { status: 503 });
      clock.time += 25_000;
      return HttpResponse.json({ status: "pending" });
    }),
  );
  const wait = createDecisionWaiter({
    ...options,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
  });
  expect(await wait("req_1", new AbortController().signal, 100_000)).toEqual({
    kind: "expired",
  });
  expect(calls).toBe(8);
  expect(clock.slept).toEqual([250, 250, 250, 250]);
});

test("a status the API won't change its mind on fails the wait at once", async () => {
  let calls = 0;
  server.use(
    http.get(url, () => {
      calls++;
      return new HttpResponse(null, { status: 403 });
    }),
  );
  await expect(
    waitFor("req_1", new AbortController().signal, inAMinute()),
  ).rejects.toThrow("decision poll failed: HTTP 403");
  expect(calls).toBe(1);
});
