import { expect, test } from "vitest";
import {
  Decision,
  Event,
  EventType,
  PendingRequest,
  RunnerEventPost,
} from "./event.js";

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  turns: 1,
  durationMs: 900,
};
const meta = { id: "evt_1", runId: "run_1", ts: "2026-10-29T12:00:00.000Z" };

test("event types cover the run lifecycle and progress", () => {
  expect(EventType.options).toEqual(
    expect.arrayContaining([
      "run.started",
      "run.progress",
      "run.waiting",
      "run.finished",
      "run.failed",
    ]),
  );
});

test("accepts run.finished carrying summary and usage", () => {
  const event = {
    ...meta,
    type: "run.finished",
    payload: { summary: "done", usage },
  };
  expect(Event.parse(event)).toEqual(event);
});

test("rejects run.finished without usage", () => {
  expect(
    Event.safeParse({
      ...meta,
      type: "run.finished",
      payload: { summary: "done" },
    }).success,
  ).toBe(false);
});

test("accepts a tool progress event and a waiting event", () => {
  expect(
    Event.parse({
      ...meta,
      type: "run.progress",
      payload: { message: "editing", tool: "Edit" },
    }).type,
  ).toBe("run.progress");
  const request = {
    kind: "question",
    requestId: "req_1",
    prompt: "Which branch?",
  };
  expect(
    Event.parse({ ...meta, type: "run.waiting", payload: { request } }).payload,
  ).toEqual({ request });
});

test("rejects an unknown type and a non-ISO timestamp", () => {
  expect(
    Event.safeParse({ ...meta, type: "run.exploded", payload: {} }).success,
  ).toBe(false);
  expect(
    Event.safeParse({
      ...meta,
      ts: "yesterday",
      type: "run.started",
      payload: {},
    }).success,
  ).toBe(false);
});

test("pending request is a question with a prompt or an approval with a tool summary", () => {
  expect(
    PendingRequest.parse({
      kind: "question",
      requestId: "req_1",
      prompt: "Which db?",
    }).kind,
  ).toBe("question");
  const approval = {
    kind: "approval",
    requestId: "req_2",
    toolName: "Bash",
    toolSummary: "rm -rf dist",
  };
  expect(PendingRequest.parse(approval)).toEqual(approval);
  expect(
    PendingRequest.safeParse({
      kind: "approval",
      requestId: "req_2",
      prompt: "ok?",
    }).success,
  ).toBe(false);
});

test("decision approves, denies or answers a request", () => {
  expect(
    Decision.parse({ requestId: "req_1", decision: "approve" }).decision,
  ).toBe("approve");
  expect(
    Decision.parse({ requestId: "req_1", decision: "deny", reason: "no" })
      .decision,
  ).toBe("deny");
  expect(
    Decision.parse({
      requestId: "req_1",
      decision: "answer",
      answer: "postgres",
    }).decision,
  ).toBe("answer");
  expect(
    Decision.safeParse({ requestId: "req_1", decision: "answer" }).success,
  ).toBe(false);
  expect(
    Decision.safeParse({ requestId: "req_1", decision: "maybe" }).success,
  ).toBe(false);
});

test("runner posts an event without id or timestamp; the API assigns those", () => {
  const post = {
    runId: "run_1",
    type: "run.failed",
    payload: { error: "exit 1" },
  };
  expect(RunnerEventPost.parse(post)).toEqual(post);
  expect(RunnerEventPost.safeParse({ ...post, id: "evt_9" }).success).toBe(
    false,
  );
  expect(
    RunnerEventPost.safeParse({
      runId: "run_1",
      type: "run.failed",
      payload: {},
    }).success,
  ).toBe(false);
});
