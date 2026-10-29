PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`env_id` text NOT NULL,
	`session_id` text,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`env_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_status" CHECK("status" in ('idle', 'running', 'waiting')),
	CONSTRAINT "agents_branch" CHECK("branch" = 'claude/' || "id"),
	CONSTRAINT "agents_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "env_id", "session_id", "branch", "status") SELECT "id", "env_id", "session_id", "branch", "status" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agents_env_id` ON `agents` (`env_id`);--> statement-breakpoint
CREATE TABLE `__new_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo` text NOT NULL,
	`setup` text NOT NULL,
	`status` text NOT NULL,
	`sprite_name` text NOT NULL,
	`checkpoint_id` text,
	`concurrency` integer DEFAULT 3 NOT NULL,
	`approval_policy` text DEFAULT '[]' NOT NULL,
	`failure_step` text,
	`failure_stderr` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "environments_status" CHECK("status" in ('provisioning', 'ready', 'failed')),
	CONSTRAINT "environments_concurrency" CHECK("concurrency" > 0),
	CONSTRAINT "environments_approval_policy" CHECK(json_type("approval_policy") = 'array'),
	CONSTRAINT "environments_failure_step" CHECK("failure_step" in ('create', 'clone', 'setup', 'checkpoint')),
	CONSTRAINT "environments_failure_stderr" CHECK(length("failure_stderr") <= 4000),
	CONSTRAINT "environments_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_environments`("id", "name", "repo", "setup", "status", "sprite_name", "checkpoint_id", "concurrency", "approval_policy") SELECT "id", "name", "repo", "setup", "status", "sprite_name", "checkpoint_id", "concurrency", "approval_policy" FROM `environments`;--> statement-breakpoint
DROP TABLE `environments`;--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;--> statement-breakpoint
CREATE UNIQUE INDEX `environments_name` ON `environments` (`name`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_status" CHECK("status" in ('starting', 'running', 'waiting', 'finished', 'failed', 'stopped')),
	CONSTRAINT "runs_usage" CHECK(("input_tokens" is null and "output_tokens" is null and "cost_usd" is null and "turns" is null and "duration_ms" is null)
        or ("input_tokens" >= 0 and "output_tokens" >= 0 and "cost_usd" >= 0 and "turns" >= 0 and "duration_ms" >= 0)),
	CONSTRAINT "runs_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "agent_id", "status", "summary", "input_tokens", "output_tokens", "cost_usd", "turns", "duration_ms") SELECT "id", "agent_id", "status", "summary", "input_tokens", "output_tokens", "cost_usd", "turns", "duration_ms" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_agent_id` ON `runs` (`agent_id`);--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "webhooks_event_types" CHECK(json_type("event_types") = 'array' and json_array_length("event_types") > 0),
	CONSTRAINT "webhooks_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_webhooks`("id", "url", "event_types") SELECT "id", "url", "event_types" FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;