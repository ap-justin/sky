import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { createPoster } from "./events.js";

const url = "https://api.test/internal/events";
const options = {
  apiBaseUrl: "https://api.test",
  agentToken: "agent-secret",
  sleep: async () => {},
};

/** A sleep that only advances a virtual clock, so a two-minute retry budget runs at once. */
function virtualClock() {
  const clock = {
    now: 0,
    sleep: async (ms: number) => {
      clock.now += ms;
    },
  };
  return clock;
}

test("posts the event with the agent bearer token", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      sent.push({
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({ ...options, warn: () => {} });
  await post({
    runId: "run_1",
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(sent).toEqual([
    {
      auth: "Bearer agent-secret",
      body: {
        runId: "run_1",
        type: "run.started",
        payload: { sessionId: "s" },
      },
    },
  ]);
});

test("retries a failed post", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      if (calls === 1) return HttpResponse.error();
      if (calls === 2) return new HttpResponse(null, { status: 503 });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post({
    runId: "run_1",
    type: "run.progress",
    payload: { message: "hi" },
  });
  expect(calls).toBe(3);
  expect(warnings).toEqual([]);
});

test("gives up after its attempts without throwing, and says so on the warn channel", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return new HttpResponse("nope", { status: 500 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await expect(
    post({ runId: "run_1", type: "run.progress", payload: { message: "hi" } }),
  ).resolves.toBeUndefined();
  expect(calls).toBe(3);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/run\.progress.*500/);
  expect(warnings[0]).not.toMatch(/agent-secret/);
});

test("refuses an event the shared schema rejects before sending it", async () => {
  const post = createPoster({ ...options, warn: () => {} });
  await expect(
    post({ runId: "run_1", type: "run.started", payload: {} } as never),
  ).rejects.toThrow();
});

test("a retried waiting post answered request_open landed the first time, so it stops without a warning", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      // the first post was stored, but its response never arrived
      if (calls === 1) return HttpResponse.error();
      return HttpResponse.json(
        { error: { code: "request_open", message: "open" } },
        { status: 409 },
      );
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post({
    runId: "run_1",
    type: "run.waiting",
    payload: {
      request: { kind: "question", requestId: "req_1", prompt: "which?" },
    },
  });
  expect(calls).toBe(2);
  expect(warnings).toEqual([]);
});

test.each(["run.waiting", "run.finished", "run.failed"] as const)(
  "%s outlasts a minute-long API outage",
  async (type) => {
    const clock = virtualClock();
    const landedAt: number[] = [];
    server.use(
      http.post(url, () => {
        if (clock.now < 60_000) return HttpResponse.error();
        landedAt.push(clock.now);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const warnings: string[] = [];
    const post = createPoster({
      ...options,
      sleep: clock.sleep,
      warn: (m) => warnings.push(m),
    });
    await post(endingEvent(type));
    expect(warnings).toEqual([]);
    expect(landedAt).toHaveLength(1);
  },
);

test("an ending event gives up after about two minutes of retries, with one warning", async () => {
  const clock = virtualClock();
  server.use(http.post(url, () => new HttpResponse(null, { status: 503 })));
  const warnings: string[] = [];
  const post = createPoster({
    ...options,
    sleep: clock.sleep,
    warn: (m) => warnings.push(m),
  });
  await post(endingEvent("run.finished"));
  expect(clock.now).toBeGreaterThanOrEqual(90_000);
  expect(clock.now).toBeLessThanOrEqual(150_000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/run\.finished.*503/);
});

test("progress keeps the short budget through an outage", async () => {
  const clock = virtualClock();
  server.use(http.post(url, () => HttpResponse.error()));
  const post = createPoster({ ...options, sleep: clock.sleep, warn: () => {} });
  await post({
    runId: "run_1",
    type: "run.progress",
    payload: { message: "hi" },
  });
  expect(clock.now).toBeLessThanOrEqual(2_000);
});

test("a refusal the API won't change its mind on ends the retries at once", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return HttpResponse.json(
        { error: { code: "run_ended", message: "the run has ended" } },
        { status: 401 },
      );
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post(endingEvent("run.failed"));
  expect(calls).toBe(1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/run\.failed.*401/);
});

function endingEvent(
  type: "run.waiting" | "run.finished" | "run.failed",
): Parameters<ReturnType<typeof createPoster>>[0] {
  const runId = "run_1";
  switch (type) {
    case "run.waiting":
      return {
        runId,
        type,
        payload: {
          request: { kind: "question", requestId: "req_1", prompt: "which?" },
        },
      };
    case "run.finished":
      return {
        runId,
        type,
        payload: {
          summary: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
            turns: 1,
            durationMs: 1,
          },
        },
      };
    case "run.failed":
      return { runId, type, payload: { error: "boom" } };
  }
}
