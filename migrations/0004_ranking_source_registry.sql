ALTER TABLE `ranking_sources`
  ADD COLUMN `canonical_key` text NOT NULL DEFAULT '';
UPDATE `ranking_sources`
SET `canonical_key` = `slug`
WHERE `canonical_key` = '';
CREATE UNIQUE INDEX `ranking_sources_canonical_key_unique`
  ON `ranking_sources` (`canonical_key`);

ALTER TABLE `ranking_sources`
  ADD COLUMN `refresh_mode` text NOT NULL DEFAULT 'manual';
ALTER TABLE `ranking_sources`
  ADD COLUMN `refresh_interval_minutes` integer;
ALTER TABLE `ranking_sources`
  ADD COLUMN `last_refresh_requested_at` integer;
ALTER TABLE `ranking_sources`
  ADD COLUMN `last_refresh_completed_at` integer;
ALTER TABLE `ranking_sources`
  ADD COLUMN `last_refresh_status` text;
ALTER TABLE `ranking_sources`
  ADD COLUMN `last_refresh_error` text;
ALTER TABLE `ranking_sources`
  ADD COLUMN `provenance_json` text NOT NULL DEFAULT '{}';

CREATE TABLE `ranking_source_aliases` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL REFERENCES `ranking_sources`(`id`) ON DELETE CASCADE,
  `alias_type` text NOT NULL,
  `normalized_value` text NOT NULL,
  `display_value` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `ranking_source_aliases_type_value_unique`
  ON `ranking_source_aliases` (`alias_type`, `normalized_value`);
CREATE INDEX `ranking_source_aliases_source_idx`
  ON `ranking_source_aliases` (`source_id`);

INSERT INTO `ranking_source_aliases` (
  `id`, `source_id`, `alias_type`, `normalized_value`, `display_value`
)
SELECT
  'source-alias:' || lower(`slug`),
  `id`,
  'slug',
  lower(`slug`),
  `slug`
FROM `ranking_sources`;

CREATE INDEX `ranking_snapshots_source_scope_latest_idx`
  ON `ranking_snapshots` (
    `source_id`, `ranking_type`, `scoring_format`, `season`, `week`, `generated_at`
  );

CREATE TABLE `ranking_lists` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_identity` text NOT NULL,
  `league_id` text REFERENCES `leagues`(`id`) ON DELETE SET NULL,
  `name` text NOT NULL,
  `ranking_type` text NOT NULL,
  `scoring_format` text NOT NULL,
  `season` text NOT NULL,
  `week` integer,
  `seed_snapshot_id` text REFERENCES `ranking_snapshots`(`id`) ON DELETE SET NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  `settings_json` text DEFAULT '{}' NOT NULL,
  `archived_at` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `ranking_lists_owner_scope_idx`
  ON `ranking_lists` (
    `owner_identity`, `league_id`, `ranking_type`, `scoring_format`,
    `season`, `week`, `archived_at`
  );

CREATE TABLE `ranking_list_entries` (
  `list_id` text NOT NULL REFERENCES `ranking_lists`(`id`) ON DELETE CASCADE,
  `player_id` text NOT NULL REFERENCES `players`(`id`) ON DELETE CASCADE,
  `sort_key` integer NOT NULL,
  `tier` integer,
  `note` text,
  `source_snapshot_id` text REFERENCES `ranking_snapshots`(`id`) ON DELETE SET NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`list_id`, `player_id`)
);
CREATE INDEX `ranking_list_entries_order_idx`
  ON `ranking_list_entries` (`list_id`, `sort_key`, `player_id`);
CREATE INDEX `ranking_list_entries_player_idx`
  ON `ranking_list_entries` (`player_id`, `list_id`);
