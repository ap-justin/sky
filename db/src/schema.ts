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
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// bare column name: drizzle qualifies `${t.col}` with the table, which breaks the `__new_<table>` copy a rebuild creates
const c = (column: AnyColumn) => sql.identifier(column.name);

// UTC ISO-8601, the form `z.iso.datetime()` accepts
const isoUtc = (column: AnyColumn) =>
  sql`${c(column)} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`;

// the provisioning step that failed; the CHECK on `failure_step` spells the same list
export const environmentFailureSteps = [
  "create",
  "clone",
  "setup",
  "checkpoint",
] as const;

// stamped by the database, so no insert path can omit or misformat it
const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

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
    failureStep: text("failure_step", { enum: environmentFailureSteps }),
    // redacted and truncated by the API before it lands here
    failureStderr: text("failure_stderr"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("environments_name").on(t.name),
    check(
      "environments_status",
      sql`${c(t.status)} in ('provisioning', 'ready', 'failed')`,
    ),
    check("environments_concurrency", sql`${c(t.concurrency)} > 0`),
    check(
      "environments_approval_policy",
      sql`json_type(${c(t.approvalPolicy)}) = 'array'`,
    ),
    check(
      "environments_failure_step",
      sql`${c(t.failureStep)} in ('create', 'clone', 'setup', 'checkpoint')`,
    ),
    check(
      "environments_failure_stderr",
      sql`length(${c(t.failureStderr)}) <= 4000`,
    ),
    check("environments_created_at", isoUtc(t.createdAt)),
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
    createdAt: createdAt(),
    // no CHECK: adding one makes drizzle-kit rebuild the table; the API writes toISOString() only
    archivedAt: text("archived_at"),
  },
  (t) => [
    index("agents_env_id").on(t.envId),
    check(
      "agents_status",
      sql`${c(t.status)} in ('idle', 'running', 'waiting')`,
    ),
    check("agents_branch", sql`${c(t.branch)} = 'claude/' || ${c(t.id)}`),
    check("agents_created_at", isoUtc(t.createdAt)),
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
    createdAt: createdAt(),
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
    check("runs_created_at", isoUtc(t.createdAt)),
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
    check("events_ts", isoUtc(t.ts)),
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
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "webhooks_event_types",
      sql`json_type(${c(t.eventTypes)}) = 'array' and json_array_length(${c(t.eventTypes)}) > 0`,
    ),
    check("webhooks_created_at", isoUtc(t.createdAt)),
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
