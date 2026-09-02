CREATE TABLE `sleeper_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL REFERENCES `research_jobs`(`id`) ON DELETE CASCADE,
  `season` text NOT NULL,
  `scoring_format` text NOT NULL,
  `ranking_type` text NOT NULL,
  `league_size` integer NOT NULL,
  `summary` text NOT NULL,
  `generated_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `published_at` integer
);

CREATE UNIQUE INDEX `sleeper_reports_job_unique`
  ON `sleeper_reports` (`job_id`);
CREATE INDEX `sleeper_reports_latest_idx`
  ON `sleeper_reports` (`published_at`, `id`);

CREATE TABLE `sleeper_position_summaries` (
  `report_id` text NOT NULL REFERENCES `sleeper_reports`(`id`) ON DELETE CASCADE,
  `position` text NOT NULL,
  `summary` text NOT NULL,
  PRIMARY KEY (`report_id`, `position`)
);

CREATE TABLE `sleeper_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `report_id` text NOT NULL REFERENCES `sleeper_reports`(`id`) ON DELETE CASCADE,
  `position` text NOT NULL,
  `position_rank` integer NOT NULL,
  `player_name` text NOT NULL,
  `team` text,
  `source_count` integer NOT NULL,
  `recommended_pick_start` integer NOT NULL,
  `recommended_pick_end` integer NOT NULL,
  `summary` text NOT NULL,
  `upside` text,
  `risk` text,
  `created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `sleeper_candidates_report_player_unique`
  ON `sleeper_candidates` (`report_id`, `position`, `player_name`);
CREATE INDEX `sleeper_candidates_report_position_rank_idx`
  ON `sleeper_candidates` (`report_id`, `position`, `position_rank`, `id`);

CREATE TABLE `sleeper_candidate_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `candidate_id` text NOT NULL REFERENCES `sleeper_candidates`(`id`) ON DELETE CASCADE,
  `publisher` text NOT NULL,
  `title` text NOT NULL,
  `url` text NOT NULL,
  `source_domain` text NOT NULL,
  `published_at` integer,
  `recommendation` text,
  `created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `sleeper_candidate_sources_domain_unique`
  ON `sleeper_candidate_sources` (`candidate_id`, `source_domain`);
CREATE INDEX `sleeper_candidate_sources_candidate_idx`
  ON `sleeper_candidate_sources` (`candidate_id`, `publisher`, `id`);
