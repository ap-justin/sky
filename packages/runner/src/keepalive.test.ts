import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { holdSprite } from "./keepalive.js";

let dir: string;
let api: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-keepalive-"));
});
afterEach(async () => {
  if (api) {
    api.closeAllConnections();
    api.close();
    api = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Call = { method?: string; url?: string; host?: string; body: string };

/** A stand-in for the sprite's management socket that records every Tasks API call. */
async function spriteApi(status = 200) {
  const calls: Call[] = [];
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        body,
      });
      res.writeHead(status).end();
    });
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  return { calls, socketPath };
}

test("holds a task named for the run, refreshes it, and deletes it on release", async () => {
  const { calls, socketPath } = await spriteApi();
  const warnings: string[] = [];
  const hold = holdSprite({
    name: "run_1",
    socketPath,
    refreshMs: 20,
    warn: (m) => warnings.push(m),
  });
  await sleep(70);
  await hold.release();
  const settled = calls.length;
  await sleep(50);

  const put = {
    method: "PUT",
    url: "/v1/tasks/run_1",
    host: "sprite",
    body: JSON.stringify({ expire: "5m" }),
  };
  expect(calls.length).toBe(settled);
  expect(calls.at(-1)).toEqual({
    method: "DELETE",
    url: "/v1/tasks/run_1",
    host: "sprite",
    body: "",
  });
  const puts = calls.slice(0, -1);
  expect(puts.length).toBeGreaterThanOrEqual(2);
  for (const call of puts) expect(call).toEqual(put);
  expect(warnings).toEqual([]);
});

test("with no sprite socket it says so once on warn and carries on", async () => {
  const warnings: string[] = [];
  const hold = holdSprite({
    name: "run_1",
    socketPath: join(dir, "absent.sock"),
    refreshMs: 10,
    warn: (m) => warnings.push(m),
  });
  await sleep(50);
  await expect(hold.release()).resolves.toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/absent\.sock/);
});

test("a refused refresh is one warning per failure, and the hold keeps trying", async () => {
  const { calls, socketPath } = await spriteApi(500);
  const warnings: string[] = [];
  const hold = holdSprite({
    name: "run_1",
    socketPath,
    refreshMs: 20,
    warn: (m) => warnings.push(m),
  });
  await sleep(70);
  await hold.release();
  const puts = calls.filter((c) => c.method === "PUT").length;
  expect(puts).toBeGreaterThanOrEqual(2);
  expect(warnings.length).toBe(calls.length);
  expect(warnings[0]).toMatch(/HTTP 500/);
});
