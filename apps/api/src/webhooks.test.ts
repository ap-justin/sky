import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@harness/db";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { testConfig } from "./testing/sprites.js";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient("unused"),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${testConfig().apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

const subscribe = (body: unknown) =>
  app.request("/v1/webhooks", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

const hook = {
  url: "https://hooks.example.com/harness",
  eventTypes: ["run.finished", "run.failed"],
};

test("POST creates a subscription: 201, its Location and the webhook", async () => {
  const res = await subscribe(hook);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body).toEqual({
    id: expect.stringMatching(/^whk_[0-9A-Za-z]{22}$/),
    ...hook,
    createdAt: expect.stringMatching(/Z$/),
  });
  expect(res.headers.get("location")).toBe(`/v1/webhooks/${body.id}`);
});

test("GET lists subscriptions in creation order and GET /:id reads one", async () => {
  const a = (await (await subscribe(hook)).json()) as { id: string };
  const b = (await (
    await subscribe({ ...hook, eventTypes: ["run.progress"] })
  ).json()) as { id: string };

  const list = await app.request("/v1/webhooks", { headers: auth });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ data: [a, b] });

  const one = await app.request(`/v1/webhooks/${b.id}`, { headers: auth });
  expect(one.status).toBe(200);
  expect(await one.json()).toEqual(b);
});

test("DELETE removes the subscription: 204, then 404", async () => {
  const { id } = (await (await subscribe(hook)).json()) as { id: string };
  const del = await app.request(`/v1/webhooks/${id}`, {
    method: "DELETE",
    headers: auth,
  });
  expect(del.status).toBe(204);
  expect(await del.text()).toBe("");
  const again = await app.request(`/v1/webhooks/${id}`, { headers: auth });
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({
    error: { code: "not_found", message: expect.any(String) },
  });
});

test.each([
  ["GET", "/v1/webhooks/whk_missing"],
  ["DELETE", "/v1/webhooks/whk_missing"],
  ["GET", "/v1/webhooks/not-an-id"],
])("%s %s for no such webhook is a 404 envelope", async (method, path) => {
  const res = await app.request(path, { method, headers: auth });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: expect.any(String) },
  });
});

test.each([
  ["a loopback host", "https://127.0.0.1/hook"],
  ["localhost", "http://localhost:3000/hook"],
  ["cloud metadata", "http://169.254.169.254/latest"],
  ["an IPv6 unique-local host", "https://[fd00::1]/hook"],
])(
  "a URL naming %s is 400 url_not_allowed and stores nothing",
  async (_, url) => {
    const res = await subscribe({ ...hook, url });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "url_not_allowed", message: expect.any(String) },
    });
    expect(db.$client.prepare("select count(*) n from webhooks").get()).toEqual(
      {
        n: 0,
      },
    );
  },
);

test.each([
  ["a non-http URL", { ...hook, url: "file:///etc/passwd" }],
  ["an unknown event type", { ...hook, eventTypes: ["run.exploded"] }],
  ["no event types", { ...hook, eventTypes: [] }],
  ["an unknown field", { ...hook, secret: "x" }],
  ["a missing url", { eventTypes: hook.eventTypes }],
  ["a public IP literal host", { ...hook, url: "https://8.8.8.8/hook" }],
])("%s is 400 invalid_body", async (_, body) => {
  const res = await subscribe(body);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_body", message: expect.any(String) },
  });
});

test("a body without a JSON content type is 415, not an empty subscription", async () => {
  const res = await app.request("/v1/webhooks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(hook),
  });
  expect(res.status).toBe(415);
});

test.each([
  ["POST", "/v1/webhooks"],
  ["GET", "/v1/webhooks"],
  ["GET", "/v1/webhooks/whk_x"],
  ["DELETE", "/v1/webhooks/whk_x"],
])("%s %s without the API key is 401", async (method, path) => {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(hook) : undefined,
  });
  expect(res.status).toBe(401);
});
