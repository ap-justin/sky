CREATE TABLE `run_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`request` text NOT NULL,
	`decision` text,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_requests_kind" CHECK("kind" in ('question', 'approval')),
	CONSTRAINT "run_requests_request" CHECK(json_valid("request") and json_type("request") = 'object'
        and json_extract("request", '$.kind') = "kind"
        and json_extract("request", '$.requestId') = "id"),
	CONSTRAINT "run_requests_decision" CHECK(json_valid("decision") and json_type("decision") = 'object'
        and json_extract("decision", '$.requestId') = "id"),
	CONSTRAINT "run_requests_decided" CHECK(("decision" is null) = ("decided_at" is null)),
	CONSTRAINT "run_requests_decided_at" CHECK("decided_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "run_requests_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
CREATE INDEX `run_requests_run_id_decided_at` ON `run_requests` (`run_id`,`decided_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_requests_run_id_open` ON `run_requests` (`run_id`) WHERE "decided_at" is null;