import { expect, test } from "vitest";
import { Webhook } from "./webhook.js";

const hook = {
  id: "whk_1",
  url: "https://grok.example/hooks/harness",
  eventTypes: ["run.waiting", "run.finished"],
};

test("accepts a webhook subscribed to known event types", () => {
  expect(Webhook.parse(hook)).toEqual(hook);
});

test("rejects a non-http url, an unknown event type and an empty subscription", () => {
  expect(
    Webhook.safeParse({ ...hook, url: "file:///etc/passwd" }).success,
  ).toBe(false);
  expect(
    Webhook.safeParse({ ...hook, eventTypes: ["run.exploded"] }).success,
  ).toBe(false);
  expect(Webhook.safeParse({ ...hook, eventTypes: [] }).success).toBe(false);
});
