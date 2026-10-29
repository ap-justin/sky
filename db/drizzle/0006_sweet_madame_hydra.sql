CREATE TABLE `run_env_vars` (
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`nonce` blob NOT NULL,
	`key_version` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`run_id`, `name`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_env_vars_name" CHECK("name" glob '[A-Za-z_]*' and "name" not glob '*[^A-Za-z0-9_]*'),
	CONSTRAINT "run_env_vars_key_version" CHECK("key_version" > 0),
	CONSTRAINT "run_env_vars_expires_at" CHECK("expires_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "run_env_vars_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
CREATE INDEX `run_env_vars_expires_at` ON `run_env_vars` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_secrets` (
	`env_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`connector` text,
	`ciphertext` blob,
	`nonce` blob,
	`key_version` integer,
	PRIMARY KEY(`env_id`, `name`),
	FOREIGN KEY (`env_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "secrets_name" CHECK("name" glob '[A-Za-z_]*' and "name" not glob '*[^A-Za-z0-9_]*'),
	CONSTRAINT "secrets_kind" CHECK("kind" in ('value', 'connector')),
	CONSTRAINT "secrets_shape" CHECK(("kind" = 'value' and "connector" is null
          and "ciphertext" is not null and "nonce" is not null and "key_version" is not null)
        or ("kind" = 'connector' and "connector" is not null and "connector" <> ''
          and "ciphertext" is null and "nonce" is null and "key_version" is null)),
	CONSTRAINT "secrets_key_version" CHECK("key_version" > 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_secrets`("env_id", "name", "kind", "connector", "ciphertext", "nonce", "key_version") SELECT "env_id", "name", 'value', NULL, "ciphertext", "nonce", "key_version" FROM `secrets`;--> statement-breakpoint
DROP TABLE `secrets`;--> statement-breakpoint
ALTER TABLE `__new_secrets` RENAME TO `secrets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `runs` ADD `secret_names` text;