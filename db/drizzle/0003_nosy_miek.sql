CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_status` integer,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_deliveries_status" CHECK("status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts" CHECK("attempts" >= 0),
	CONSTRAINT "webhook_deliveries_next_attempt_at" CHECK("next_attempt_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "webhook_deliveries_last_status" CHECK("last_status" between 100 and 599),
	CONSTRAINT "webhook_deliveries_last_error" CHECK(length("last_error") <= 1000),
	CONSTRAINT "webhook_deliveries_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_webhook_id_event_id` ON `webhook_deliveries` (`webhook_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_next_attempt_at` ON `webhook_deliveries` (`status`,`next_attempt_at`);