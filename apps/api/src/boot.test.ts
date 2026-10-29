import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@harness/db";
import { afterEach, beforeEach, expect, test } from "vitest";
import { boot, shutdown } from "./boot.js";

let dir: string;
let db: Db | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-api-"));
});
afterEach(() => {
  if (db?.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () => ({
  apiKey: "k".repeat(40),
  spritesToken: "unused",
  dataDir: dir,
  port: 8080,
});

test("booting on an empty data dir creates harness.db with the schema migrated", async () => {
  const booted = boot(config(), () => {});
  db = booted.db;
  expect(existsSync(join(dir, "harness.db"))).toBe(true);
  const table = db.$client
    .prepare("select name from sqlite_schema where name = 'environments'")
    .get();
  expect(table).toEqual({ name: "environments" });
  expect((await booted.app.request("/healthz")).status).toBe(200);
});

test("shutdown closes the server before the DB", async () => {
  db = boot(config(), () => {}).db;
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
  const first = boot(config(), () => {}).db;
  const insert = first.$client.prepare(
    "insert into environments (id, name, repo, setup, status, sprite_name) values (?, ?, 'acme/kru', '', ?, ?)",
  );
  insert.run("env_stuck", "stuck", "provisioning", "harness-env_stuck");
  insert.run("env_ok", "ok", "ready", "harness-env_ok");
  first.$client.close();

  db = boot(config(), () => {}).db;
  const rows = db.$client
    .prepare("select id, status from environments order by id")
    .all();
  expect(rows).toEqual([
    { id: "env_ok", status: "ready" },
    { id: "env_stuck", status: "failed" },
  ]);
});
