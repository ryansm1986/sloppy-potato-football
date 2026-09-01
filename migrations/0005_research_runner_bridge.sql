CREATE TABLE `research_runners` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `provider` text NOT NULL,
  `version` text,
  `status` text DEFAULT 'online' NOT NULL,
  `capabilities_json` text DEFAULT '[]' NOT NULL,
  `current_job_id` text,
  `last_seen_at` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `research_runners_last_seen_idx`
  ON `research_runners` (`last_seen_at`, `status`);

CREATE TABLE `research_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_identity` text NOT NULL,
  `job_type` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `task_input_json` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 3 NOT NULL,
  `leased_by_runner_id` text REFERENCES `research_runners`(`id`) ON DELETE SET NULL,
  `lease_token` text,
  `lease_expires_at` integer,
  `completion_key` text,
  `result_json` text,
  `ranking_snapshot_id` text REFERENCES `ranking_snapshots`(`id`) ON DELETE SET NULL,
  `error_code` text,
  `error_message` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `started_at` integer,
  `completed_at` integer,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `research_jobs_owner_idempotency_unique`
  ON `research_jobs` (`owner_identity`, `idempotency_key`);
CREATE INDEX `research_jobs_queue_idx`
  ON `research_jobs` (`status`, `priority`, `created_at`);
CREATE INDEX `research_jobs_owner_created_idx`
  ON `research_jobs` (`owner_identity`, `created_at`);
CREATE INDEX `research_jobs_lease_idx`
  ON `research_jobs` (`status`, `lease_expires_at`);

CREATE TABLE `research_job_events` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL REFERENCES `research_jobs`(`id`) ON DELETE CASCADE,
  `event_type` text NOT NULL,
  `actor_type` text NOT NULL,
  `actor_id` text,
  `details_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `research_job_events_job_created_idx`
  ON `research_job_events` (`job_id`, `created_at`);
