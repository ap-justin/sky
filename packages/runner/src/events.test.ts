import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { createPoster } from "./events.js";

const url = "https://api.test/internal/events";
const options = {
  apiBaseUrl: "https://api.test",
  agentToken: "agent-secret",
  retryDelayMs: 0,
};

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
