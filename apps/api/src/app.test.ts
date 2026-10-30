import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@sky/db";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { testConfig } from "./testing/sprites.js";

const apiKey = "k".repeat(40);
let db: Db;
let logs: string[];
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  logs = [];
  app = createApp({
    db,
    config: testConfig({ apiKey }),
    sprites: new SpritesClient("unused"),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const unauthorized = {
  error: { code: "unauthorized", message: expect.any(String) },
};

test.each(["/v1", "/v1/anything"])(
  "%s without a bearer gets 401 and the error envelope",
  async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  },
);

test.each([
  ["a wrong key", `Bearer ${"x".repeat(40)}`],
  ["a non-bearer scheme", `Basic ${apiKey}`],
  ["a malformed token", "Bearer not a token"],
])(
  "a /v1 request with %s gets 401 and the error envelope",
  async (_, header) => {
    const res = await app.request("/v1/anything", {
      headers: { Authorization: header },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized);
  },
);

test("the right key passes the guard to an enveloped 404", async () => {
  const res = await app.request("/v1/anything", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: expect.any(String) },
  });
});

test("an unhandled throw in a route is a 500 envelope that hides the cause", async () => {
  app.get("/v1/boom", () => {
    throw new Error("sqlite path /data/sky.db");
  });
  const res = await app.request("/v1/boom", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(res.status).toBe(500);
  const body = await res.text();
  expect(JSON.parse(body)).toEqual({
    error: { code: "internal", message: expect.any(String) },
  });
  expect(body).not.toContain("sqlite");
});

test("/healthz answers 200 without auth and reports the DB reachable", async () => {
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", db: "ok" });
});

test("/healthz answers 503 once the DB is unreachable", async () => {
  db.$client.close();
  const res = await app.request("/healthz");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    error: { code: "db_unreachable", message: expect.any(String) },
  });
});

test("the request log names the request but never the Authorization header or key", async () => {
  await app.request("/v1/anything?x=1", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const log = logs.join("\n");
  expect(log).toContain("GET /v1/anything");
  expect(log).not.toContain(apiKey);
  expect(log.toLowerCase()).not.toContain("authorization");
  expect(log).not.toContain("Bearer");
});
