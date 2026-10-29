import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { createDecisionWaiter } from "./requests.js";

const url = "https://api.test/internal/runs/run_1/requests/req_1";
const waitFor = createDecisionWaiter({
  apiBaseUrl: "https://api.test",
  agentToken: "agent-secret",
  runId: "run_1",
  retryDelayMs: 0,
});

test("rides out a dropped connection and a 5xx, then returns the decision", async () => {
  let calls = 0;
  server.use(
    http.get(url, () => {
      calls++;
      if (calls === 1) return HttpResponse.error();
      if (calls === 2) return new HttpResponse(null, { status: 502 });
      return HttpResponse.json({
        status: "decided",
        decision: { requestId: "req_1", decision: "approve" },
      });
    }),
  );
  expect(await waitFor("req_1", new AbortController().signal)).toEqual({
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
  expect(await waitFor("req_1", new AbortController().signal)).toEqual({
    kind: "lost",
  });
});

test("rejects with the signal's reason once it aborts", async () => {
  server.use(http.get(url, () => HttpResponse.json({ status: "pending" })));
  const controller = new AbortController();
  const waiting = waitFor("req_1", controller.signal);
  controller.abort(new Error("deadline"));
  await expect(waiting).rejects.toThrow("deadline");
});
