import type {
  AgentId,
  AgentStatus,
  EnvironmentId,
  EnvironmentStatus,
  EventType,
  RunId,
  RunStatus,
  WebhookId,
} from "@harness/shared";
import { type AnyColumn, sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// bare column name: drizzle qualifies `${t.col}` with the table, which breaks the `__new_<table>` copy a rebuild creates
const c = (column: AnyColumn) => sql.identifier(column.name);

export const environments = sqliteTable(
  "environments",
  {
    id: text().$type<EnvironmentId>().primaryKey(),
    name: text().notNull(),
    repo: text().notNull(),
    setup: text().notNull(),
    status: text().$type<EnvironmentStatus>().notNull(),
    spriteName: text("sprite_name").notNull(),
    checkpointId: text("checkpoint_id"),
    concurrency: integer().notNull().default(3),
    approvalPolicy: text("approval_policy", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    check(
      "environments_status",
      sql`${c(t.status)} in ('provisioning', 'ready', 'failed')`,
    ),
    check("environments_concurrency", sql`${c(t.concurrency)} > 0`),
    check(
      "environments_approval_policy",
      sql`json_type(${c(t.approvalPolicy)}) = 'array'`,
    ),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text().$type<AgentId>().primaryKey(),
    envId: text("env_id")
      .$type<EnvironmentId>()
      .notNull()
      .references(() => environments.id),
    sessionId: text("session_id"),
    branch: text().$type<`claude/${AgentId}`>().notNull(),
    status: text().$type<AgentStatus>().notNull(),
  },
  (t) => [
    index("agents_env_id").on(t.envId),
    check(
      "agents_status",
      sql`${c(t.status)} in ('idle', 'running', 'waiting')`,
    ),
    check("agents_branch", sql`${c(t.branch)} = 'claude/' || ${c(t.id)}`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text().$type<RunId>().primaryKey(),
    agentId: text("agent_id")
      .$type<AgentId>()
      .notNull()
      .references(() => agents.id),
    status: text().$type<RunStatus>().notNull(),
    summary: text(),
    // shared `Usage`, null until the run reports it; all five or none
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: real("cost_usd"),
    turns: integer(),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("runs_agent_id").on(t.agentId),
    check(
      "runs_status",
      sql`${c(t.status)} in ('starting', 'running', 'waiting', 'finished', 'failed', 'stopped')`,
    ),
    check(
      "runs_usage",
      sql`(${c(t.inputTokens)} is null and ${c(t.outputTokens)} is null and ${c(t.costUsd)} is null and ${c(t.turns)} is null and ${c(t.durationMs)} is null)
        or (${c(t.inputTokens)} >= 0 and ${c(t.outputTokens)} >= 0 and ${c(t.costUsd)} >= 0 and ${c(t.turns)} >= 0 and ${c(t.durationMs)} >= 0)`,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    // AUTOINCREMENT: never reuses a deleted id, so it is safe as the SSE Last-Event-ID
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id),
    ts: text().notNull(),
    type: text().$type<EventType>().notNull(),
    payload: text({ mode: "json" }).notNull(),
  },
  (t) => [
    // a run's stream resumes with `run_id = ? and id > ?`
    index("events_run_id_id").on(t.runId, t.id),
    check(
      "events_type",
      sql`${c(t.type)} in ('run.started', 'run.progress', 'run.waiting', 'run.finished', 'run.failed', 'run.stopped')`,
    ),
    // UTC ISO-8601, the form `z.iso.datetime()` accepts
    check(
      "events_ts",
      sql`${c(t.ts)} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`,
    ),
    check("events_payload", sql`json_type(${c(t.payload)}) = 'object'`),
  ],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text().$type<WebhookId>().primaryKey(),
    url: text().notNull(),
    eventTypes: text("event_types", { mode: "json" })
      .$type<[EventType, ...EventType[]]>()
      .notNull(),
  },
  (t) => [
    check(
      "webhooks_event_types",
      sql`json_type(${c(t.eventTypes)}) = 'array' and json_array_length(${c(t.eventTypes)}) > 0`,
    ),
  ],
);

// values are encrypted by the API before they reach this table; there is no plaintext column
export const secrets = sqliteTable(
  "secrets",
  {
    envId: text("env_id")
      .$type<EnvironmentId>()
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text().notNull(),
    ciphertext: blob({ mode: "buffer" }).notNull(),
    nonce: blob({ mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.envId, t.name] }),
    check("secrets_key_version", sql`${c(t.keyVersion)} > 0`),
  ],
);
