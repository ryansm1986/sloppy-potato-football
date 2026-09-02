CREATE TABLE `research_schedules` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_identity` text NOT NULL,
  `name` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `timezone` text NOT NULL,
  `local_time` text NOT NULL,
  `days_of_week_json` text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL,
  `job_type` text NOT NULL,
  `task_input_json` text NOT NULL,
  `next_run_at` integer,
  `last_run_at` integer,
  `last_job_id` text REFERENCES `research_jobs`(`id`) ON DELETE SET NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  CHECK (`enabled` IN (0, 1)),
  CHECK (`local_time` GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (`job_type` IN ('rankings_research', 'sleepers_research', 'player_research', 'source_refresh'))
);

CREATE INDEX `research_schedules_due_idx`
  ON `research_schedules` (`enabled`, `next_run_at`, `id`);
CREATE INDEX `research_schedules_owner_idx`
  ON `research_schedules` (`owner_identity`, `created_at`, `id`);

CREATE TABLE `research_schedule_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `schedule_id` text NOT NULL REFERENCES `research_schedules`(`id`) ON DELETE CASCADE,
  `scheduled_for` integer NOT NULL,
  `run_type` text NOT NULL,
  `job_id` text NOT NULL REFERENCES `research_jobs`(`id`) ON DELETE CASCADE,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  CHECK (`run_type` IN ('scheduled', 'manual'))
);

CREATE UNIQUE INDEX `research_schedule_runs_job_unique`
  ON `research_schedule_runs` (`job_id`);
CREATE UNIQUE INDEX `research_schedule_runs_scheduled_occurrence_unique`
  ON `research_schedule_runs` (`schedule_id`, `scheduled_for`)
  WHERE `run_type` = 'scheduled';
