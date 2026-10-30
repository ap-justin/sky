PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`auto_approve` text DEFAULT '{"defaults":true,"commands":[]}' NOT NULL,
	`failure_step` text,
	`failure_stderr` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "environments_status" CHECK("status" in ('provisioning', 'ready', 'failed')),
	CONSTRAINT "environments_concurrency" CHECK("concurrency" > 0),
	CONSTRAINT "environments_approval_policy" CHECK(json_type("approval_policy") = 'array'),
	CONSTRAINT "environments_auto_approve" CHECK(json_type("auto_approve") = 'object'),
	CONSTRAINT "environments_failure_step" CHECK("failure_step" in ('create', 'clone', 'setup', 'checkpoint')),
	CONSTRAINT "environments_failure_stderr" CHECK(length("failure_stderr") <= 4000),
	CONSTRAINT "environments_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_environments`("id", "name", "repo", "setup", "status", "sprite_name", "checkpoint_id", "concurrency", "approval_policy", "failure_step", "failure_stderr", "created_at") SELECT "id", "name", "repo", "setup", "status", "sprite_name", "checkpoint_id", "concurrency", "approval_policy", "failure_step", "failure_stderr", "created_at" FROM `environments`;--> statement-breakpoint
DROP TABLE `environments`;--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `environments_name` ON `environments` (`name`);