import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agents,
  type Db,
  environments,
  events,
  runs,
  webhookDeliveries,
  webhooks,
} from "@harness/db";
import type { AgentId, EnvironmentId, RunId } from "@harness/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { boot, shutdown } from "./boot.js";
import { testConfig } from "./testing/sprites.js";

let dir: string;
let db: Db | undefined;
let stops: (() => unknown)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-api-"));
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  if (db?.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () => testConfig({ dataDir: dir, runTimeoutMs: 60_000 });

const booted = (log: (line: string) => void = () => {}) => {
  const b = boot(config(), log);
  stops.push(b.stopSweeping, b.stopDelivering);
  return b;
};

test("booting on an empty data dir creates harness.db with the schema migrated", async () => {
  const b = booted();
  db = b.db;
  expect(existsSync(join(dir, "harness.db"))).toBe(true);
  const table = db.$client
    .prepare("select name from sqlite_schema where name = 'environments'")
    .get();
  expect(table).toEqual({ name: "environments" });
  expect((await b.app.request("/healthz")).status).toBe(200);
});

test("shutdown closes the server before the DB", async () => {
  db = booted().db;
  const order: string[] = [];
  const server = {
    close(done: (err?: Error) => void) {
      setTimeout(() => {
        order.push(`server closed, db open: ${db?.$client.open}`);
        done();
      }, 1);
    },
  };
  await shutdown(server, db);
  order.push(`db open: ${db.$client.open}`);
  expect(order).toEqual(["server closed, db open: true", "db open: false"]);
});

test("an env a previous process left provisioning boots as failed; others keep their status", async () => {
  const first = booted().db;
  const insert = first.$client.prepare(
    "insert into environments (id, name, repo, setup, status, sprite_name) values (?, ?, 'acme/kru', '', ?, ?)",
  );
  insert.run("env_stuck", "stuck", "provisioning", "harness-env_stuck");
  insert.run("env_ok", "ok", "ready", "harness-env_ok");
  first.$client.close();

  db = booted().db;
  const rows = db.$client
    .prepare("select id, status from environments order by id")
    .all();
  expect(rows).toEqual([
    { id: "env_ok", status: "ready" },
    { id: "env_stuck", status: "failed" },
  ]);
});

test("boot fails runs a previous process left silent past the timeout; fresh ones stay", async () => {
  const first = booted().db;
  first.$client.exec(`
    insert into environments (id, name, repo, setup, status, sprite_name) values ('env_a', 'a', 'acme/kru', '', 'ready', 'harness-env_a');
    insert into agents (id, env_id, branch, status) values ('agt_old', 'env_a', 'claude/agt_old', 'running'), ('agt_new', 'env_a', 'claude/agt_new', 'running');
    insert into runs (id, agent_id, status, created_at) values ('run_old', 'agt_old', 'running', '2026-01-01T00:00:00.000Z'), ('run_new', 'agt_new', 'starting', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  first.$client.close();

  db = booted().db;
  expect(
    db.$client.prepare("select id, status from runs order by id").all(),
  ).toEqual([
    { id: "run_new", status: "starting" },
    { id: "run_old", status: "failed" },
  ]);
  expect(db.$client.prepare("select type, payload from events").all()).toEqual([
    { type: "run.failed", payload: '{"error":"runner_timeout"}' },
  ]);
  expect(
    db.$client.prepare("select status from agents where id = 'agt_old'").get(),
  ).toEqual({ status: "idle" });
});

test("a webhook delivery a previous process left pending is sent after boot", async () => {
  const first = booted();
  const envId = "env_boot" as EnvironmentId;
  const agentId = "agt_boot" as AgentId;
  const runId = "run_boot" as RunId;
  await first.stopDelivering();
  first.db
    .insert(environments)
    .values({
      id: envId,
      name: "e",
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: "harness-env_boot",
    })
    .run();
  first.db
    .insert(agents)
    .values({ id: agentId, envId, branch: `claude/${agentId}`, status: "idle" })
    .run();
  first.db.insert(runs).values({ id: runId, agentId, status: "stopped" }).run();
  first.db
    .insert(webhooks)
    .values({
      id: "whk_boot",
      url: "https://hooks.example.com/boot",
      eventTypes: ["run.stopped"],
    })
    .run();
  const { id: eventId } = first.db
    .insert(events)
    .values({
      runId,
      ts: new Date().toISOString(),
      type: "run.stopped",
      payload: {},
    })
    .returning({ id: events.id })
    .get();
  first.db
    .insert(webhookDeliveries)
    .values({
      webhookId: "whk_boot",
      eventId,
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    })
    .run();
  first.db.$client.close();

  const received: string[] = [];
  server.use(
    http.post("https://hooks.example.com/boot", ({ request }) => {
      received.push(request.headers.get("harness-event-id") ?? "");
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const second = booted();
  db = second.db;
  await expect.poll(() => received).toEqual([`evt_${eventId}`]);
  await expect
    .poll(() => db?.select().from(webhookDeliveries).get()?.status)
    .toBe("delivered");
});
