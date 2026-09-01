CREATE TABLE `ranking_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `provider` text,
  `attribution_url` text,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `ranking_sources_slug_unique` ON `ranking_sources` (`slug`);

CREATE TABLE `ranking_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL REFERENCES `ranking_sources`(`id`) ON DELETE CASCADE,
  `external_run_id` text,
  `title` text NOT NULL,
  `scoring_format` text NOT NULL,
  `ranking_type` text NOT NULL,
  `season` text NOT NULL,
  `week` integer,
  `status` text DEFAULT 'completed' NOT NULL,
  `generated_at` integer NOT NULL,
  `summary` text,
  `methodology` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `ranking_snapshots_source_run_unique` ON `ranking_snapshots` (`source_id`, `external_run_id`);
CREATE INDEX `ranking_snapshots_latest_idx` ON `ranking_snapshots` (`ranking_type`, `scoring_format`, `season`, `generated_at`);

CREATE TABLE `ranking_snapshot_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `snapshot_id` text NOT NULL REFERENCES `ranking_snapshots`(`id`) ON DELETE CASCADE,
  `player_id` text REFERENCES `players`(`id`) ON DELETE SET NULL,
  `external_player_id` text,
  `player_name` text NOT NULL,
  `position` text,
  `nfl_team` text,
  `rank` integer NOT NULL,
  `previous_rank` integer,
  `tier` integer,
  `insight` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `ranking_snapshot_entries_rank_unique` ON `ranking_snapshot_entries` (`snapshot_id`, `rank`);
CREATE INDEX `ranking_snapshot_entries_player_idx` ON `ranking_snapshot_entries` (`player_id`, `snapshot_id`);
