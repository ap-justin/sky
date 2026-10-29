CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`env_id` text NOT NULL,
	`session_id` text,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`env_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_status" CHECK("status" in ('idle', 'running', 'waiting')),
	CONSTRAINT "agents_branch" CHECK("branch" = 'claude/' || "id")
) STRICT;
--> statement-breakpoint
CREATE INDEX `agents_env_id` ON `agents` (`env_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo` text NOT NULL,
	`setup` text NOT NULL,
	`status` text NOT NULL,
	`sprite_name` text NOT NULL,
	`checkpoint_id` text,
	`concurrency` integer DEFAULT 3 NOT NULL,
	`approval_policy` text DEFAULT '[]' NOT NULL,
	CONSTRAINT "environments_status" CHECK("status" in ('provisioning', 'ready', 'failed')),
	CONSTRAINT "environments_concurrency" CHECK("concurrency" > 0),
	CONSTRAINT "environments_approval_policy" CHECK(json_type("approval_policy") = 'array')
) STRICT;
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type" CHECK("type" in ('run.started', 'run.progress', 'run.waiting', 'run.finished', 'run.failed', 'run.stopped')),
	CONSTRAINT "events_ts" CHECK("ts" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "events_payload" CHECK(json_type("payload") = 'object')
) STRICT;
--> statement-breakpoint
CREATE INDEX `events_run_id_id` ON `events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_status" CHECK("status" in ('starting', 'running', 'waiting', 'finished', 'failed', 'stopped')),
	CONSTRAINT "runs_usage" CHECK(("input_tokens" is null and "output_tokens" is null and "cost_usd" is null and "turns" is null and "duration_ms" is null)
        or ("input_tokens" >= 0 and "output_tokens" >= 0 and "cost_usd" >= 0 and "turns" >= 0 and "duration_ms" >= 0))
) STRICT;
--> statement-breakpoint
CREATE INDEX `runs_agent_id` ON `runs` (`agent_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`env_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`nonce` blob NOT NULL,
	`key_version` integer NOT NULL,
	PRIMARY KEY(`env_id`, `name`),
	FOREIGN KEY (`env_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "secrets_key_version" CHECK("key_version" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text NOT NULL,
	CONSTRAINT "webhooks_event_types" CHECK(json_type("event_types") = 'array' and json_array_length("event_types") > 0)
) STRICT;
