import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentStatus,
  EnvironmentStatus,
  EventType,
  RunStatus,
  type WebhookId,
} from "@harness/shared";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, migrate, openDb, webhooks } from "./index.js";

let dir: string;
let path: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-db-"));
  path = join(dir, "harness.db");
  db = openDb(path);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (stmt: string, ...params: unknown[]) =>
  db.$client.prepare(stmt).run(...params);

const seedRun = () => {
  run(
    "insert into environments (id, name, repo, setup, status, sprite_name) values ('env_1', 'e', 'o/r', '', 'ready', 's')",
  );
  run(
    "insert into agents (id, env_id, branch, status) values ('agt_1', 'env_1', 'claude/agt_1', 'idle')",
  );
  run(
    "insert into runs (id, agent_id, status) values ('run_1', 'agt_1', 'running')",
  );
};

const insertEvent = (type = "run.started") =>
  Number(
    run(
      "insert into events (run_id, ts, type, payload) values ('run_1', '2026-10-29T12:00:00.000Z', ?, '{}')",
      type,
    ).lastInsertRowid,
  );

test("openDb sets WAL, foreign keys and a busy timeout on the connection", () => {
  const pragma = (name: string) => db.$client.pragma(name, { simple: true });
  expect(pragma("journal_mode")).toBe("wal");
  expect(pragma("foreign_keys")).toBe(1);
  expect(pragma("busy_timeout")).toBe(5000);
});

const TABLES = [
  "agents",
  "environments",
  "events",
  "runs",
  "secrets",
  "webhooks",
];

const userTables = () =>
  db.$client
    .prepare(
      "select name, strict from pragma_table_list where schema = 'main' and type = 'table' and name not like 'sqlite_%' and name not like '__drizzle_%' order by name",
    )
    .all() as { name: string; strict: number }[];

test("migrate creates every table on a fresh file, and a second migrate is a no-op", () => {
  migrate(db);
  expect(userTables().map((t) => t.name)).toEqual(TABLES);

  const changesBefore = db.$client.prepare("select total_changes() n").get();
  migrate(db);
  expect(db.$client.prepare("select total_changes() n").get()).toEqual(
    changesBefore,
  );
});

test("every table is STRICT, so a wrong-typed value is rejected", () => {
  migrate(db);
  expect(userTables().filter((t) => t.strict !== 1)).toEqual([]);

  seedRun();
  expect(() =>
    run("update environments set concurrency = 'three' where id = 'env_1'"),
  ).toThrow(/cannot store TEXT value in INTEGER column/);
});

test("event ids are monotonic and never reused after a delete", () => {
  migrate(db);
  seedRun();
  const first = insertEvent();
  const second = insertEvent();
  run("delete from events where id = ?", second);
  expect(insertEvent()).toBeGreaterThan(second);
  expect(second).toBeGreaterThan(first);
});

test("status and type columns accept exactly the shared enums", () => {
  migrate(db);
  seedRun();
  const accepts = (stmt: string, values: readonly string[]) => {
    for (const v of values) expect(() => run(stmt, v)).not.toThrow();
    expect(() => run(stmt, "bogus")).toThrow(/CHECK constraint failed/);
  };
  accepts("update environments set status = ?", EnvironmentStatus.options);
  accepts("update agents set status = ?", AgentStatus.options);
  accepts("update runs set status = ?", RunStatus.options);
  accepts(
    "insert into events (run_id, ts, type, payload) values ('run_1', '2026-10-29T12:00:00Z', ?, '{}')",
    EventType.options,
  );
});

test("foreign keys are enforced after migrate", () => {
  migrate(db);
  expect(() =>
    run(
      "insert into agents (id, env_id, branch, status) values ('agt_2', 'env_missing', 'claude/agt_2', 'idle')",
    ),
  ).toThrow(/FOREIGN KEY constraint failed/);
});

test("secrets hold ciphertext, nonce and key version, with no plaintext column", () => {
  migrate(db);
  const columns = db.$client
    .prepare("select name from pragma_table_info('secrets') order by cid")
    .all()
    .map((c) => (c as { name: string }).name);
  expect(columns).toEqual([
    "env_id",
    "name",
    "ciphertext",
    "nonce",
    "key_version",
  ]);
});

test("migrate refuses a file migrated by newer code", () => {
  migrate(db);
  run(
    "insert into __drizzle_migrations (hash, created_at) values ('from-a-newer-build', ?)",
    Date.now() + 86_400_000,
  );
  expect(() => migrate(db)).toThrow(/newer/);
});

// a copy of the migrations folder whose journal stops after `tag`, to build a file as an older release left it
const migrateThrough = (tag: string) => {
  const folder = join(dir, "drizzle");
  cpSync(new URL("../drizzle", import.meta.url), folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const end = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  drizzleMigrate(db, { migrationsFolder: folder });
};

const count = (table: string) =>
  (db.$client.prepare(`select count(*) n from ${table}`).get() as { n: number })
    .n;

test("migrating a populated 0000 file keeps every row, cascade children included", () => {
  migrateThrough("0000_init");
  seedRun();
  insertEvent();
  run(
    "insert into secrets (env_id, name, ciphertext, nonce, key_version) values ('env_1', 'K', x'00', x'00', 1)",
  );
  run(
    "insert into webhooks (id, url, event_types) values ('wh_1', 'https://x', '[\"run.started\"]')",
  );

  migrate(db);

  for (const table of TABLES) expect([table, count(table)]).toEqual([table, 1]);
  const createdAt = db.$client
    .prepare("select created_at from environments")
    .pluck()
    .get();
  expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("environment failure columns accept the provisioning steps and stderr up to 4000 chars", () => {
  migrate(db);
  seedRun();
  const fail = (step: string, stderr: string) =>
    run(
      "update environments set failure_step = ?, failure_stderr = ?",
      step,
      stderr,
    );
  for (const step of ["create", "clone", "setup", "checkpoint"])
    expect(() => fail(step, "x".repeat(4000))).not.toThrow();
  expect(() => fail("deploy", "")).toThrow(/CHECK constraint failed/);
  expect(() => fail("setup", "x".repeat(4001))).toThrow(
    /CHECK constraint failed/,
  );
});

test("environment names are unique", () => {
  migrate(db);
  seedRun();
  expect(() =>
    run(
      "insert into environments (id, name, repo, setup, status, sprite_name) values ('env_2', 'e', 'o/r', '', 'ready', 's')",
    ),
  ).toThrow(/UNIQUE constraint failed: environments.name/);
});

test("created_at is stamped as UTC ISO-8601 and rejects any other form", () => {
  migrate(db);
  seedRun();
  for (const table of ["environments", "agents", "runs"]) {
    const at = db.$client
      .prepare(`select created_at from ${table}`)
      .pluck()
      .get();
    expect(new Date(at as string).toISOString()).toBe(at);
    expect(() =>
      run(`update ${table} set created_at = '2026-10-29 12:00:00'`),
    ).toThrow(/CHECK constraint failed/);
  }
  expect(() =>
    run(
      "insert into webhooks (id, url, event_types, created_at) values ('wh_1', 'https://x', '[\"run.started\"]', 'yesterday')",
    ),
  ).toThrow(/CHECK constraint failed/);
});

test("drizzle inserts stamp created_at without the caller passing it", () => {
  migrate(db);
  db.insert(webhooks)
    .values({
      id: "wh_1" as WebhookId,
      url: "https://x",
      eventTypes: ["run.started"],
    })
    .run();
  const [row] = db.select().from(webhooks).all();
  expect(row?.createdAt).toMatch(/Z$/);
});
