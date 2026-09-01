PRAGMA foreign_keys = ON;

CREATE TABLE `leagues` (
  `id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `external_id` text NOT NULL,
  `name` text NOT NULL,
  `sport` text DEFAULT 'nfl' NOT NULL,
  `season` text NOT NULL,
  `season_type` text NOT NULL,
  `status` text NOT NULL,
  `avatar_url` text,
  `roster_positions_json` text DEFAULT '[]' NOT NULL,
  `settings_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `leagues_provider_external_unique` ON `leagues` (`provider`, `external_id`);
CREATE INDEX `leagues_season_idx` ON `leagues` (`season`);

CREATE TABLE `league_members` (
  `id` text PRIMARY KEY NOT NULL,
  `league_id` text NOT NULL REFERENCES `leagues`(`id`) ON DELETE CASCADE,
  `provider` text NOT NULL,
  `external_user_id` text NOT NULL,
  `username` text,
  `display_name` text NOT NULL,
  `avatar_url` text,
  `team_name` text,
  `is_commissioner` integer DEFAULT 0 NOT NULL,
  `is_active` integer DEFAULT 1 NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `league_members_provider_external_unique` ON `league_members` (`league_id`, `provider`, `external_user_id`);
CREATE INDEX `league_members_league_idx` ON `league_members` (`league_id`);

CREATE TABLE `teams` (
  `id` text PRIMARY KEY NOT NULL,
  `league_id` text NOT NULL REFERENCES `leagues`(`id`) ON DELETE CASCADE,
  `member_id` text REFERENCES `league_members`(`id`) ON DELETE SET NULL,
  `name` text NOT NULL,
  `avatar_url` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `teams_league_idx` ON `teams` (`league_id`);

CREATE TABLE `rosters` (
  `id` text PRIMARY KEY NOT NULL,
  `league_id` text NOT NULL REFERENCES `leagues`(`id`) ON DELETE CASCADE,
  `team_id` text NOT NULL REFERENCES `teams`(`id`) ON DELETE CASCADE,
  `provider` text NOT NULL,
  `external_roster_id` integer NOT NULL,
  `owner_external_user_id` text,
  `settings_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `rosters_provider_external_unique` ON `rosters` (`league_id`, `provider`, `external_roster_id`);
CREATE UNIQUE INDEX `rosters_team_unique` ON `rosters` (`team_id`);
CREATE INDEX `rosters_league_idx` ON `rosters` (`league_id`);

CREATE TABLE `players` (
  `id` text PRIMARY KEY NOT NULL,
  `sport` text DEFAULT 'nfl' NOT NULL,
  `first_name` text,
  `last_name` text,
  `full_name` text NOT NULL,
  `search_name` text NOT NULL,
  `position` text,
  `fantasy_positions_json` text DEFAULT '[]' NOT NULL,
  `nfl_team` text,
  `number` integer,
  `status` text,
  `injury_status` text,
  `injury_body_part` text,
  `injury_notes` text,
  `age` integer,
  `height` text,
  `weight` text,
  `college` text,
  `years_experience` integer,
  `depth_chart_position` text,
  `depth_chart_order` integer,
  `is_team_defense` integer DEFAULT 0 NOT NULL,
  `news_updated_at` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE INDEX `players_search_name_idx` ON `players` (`search_name`);
CREATE INDEX `players_position_team_idx` ON `players` (`position`, `nfl_team`);

CREATE TABLE `player_external_ids` (
  `id` text PRIMARY KEY NOT NULL,
  `player_id` text NOT NULL REFERENCES `players`(`id`) ON DELETE CASCADE,
  `provider` text NOT NULL,
  `external_id` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `player_external_ids_provider_external_unique` ON `player_external_ids` (`provider`, `external_id`);
CREATE INDEX `player_external_ids_player_idx` ON `player_external_ids` (`player_id`);

CREATE TABLE `roster_players` (
  `roster_id` text NOT NULL REFERENCES `rosters`(`id`) ON DELETE CASCADE,
  `player_id` text NOT NULL REFERENCES `players`(`id`) ON DELETE CASCADE,
  `role` text NOT NULL,
  `slot_index` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`roster_id`, `player_id`)
);
CREATE INDEX `roster_players_player_idx` ON `roster_players` (`player_id`);

CREATE TABLE `scoring_settings` (
  `league_id` text NOT NULL REFERENCES `leagues`(`id`) ON DELETE CASCADE,
  `key` text NOT NULL,
  `value` real NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`league_id`, `key`)
);

CREATE TABLE `drafts` (
  `id` text PRIMARY KEY NOT NULL,
  `league_id` text NOT NULL REFERENCES `leagues`(`id`) ON DELETE CASCADE,
  `provider` text NOT NULL,
  `external_id` text NOT NULL,
  `type` text NOT NULL,
  `status` text NOT NULL,
  `season` text NOT NULL,
  `season_type` text NOT NULL,
  `name` text,
  `settings_json` text DEFAULT '{}' NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `start_time` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `drafts_provider_external_unique` ON `drafts` (`provider`, `external_id`);
CREATE INDEX `drafts_league_idx` ON `drafts` (`league_id`);

CREATE TABLE `draft_picks` (
  `id` text PRIMARY KEY NOT NULL,
  `draft_id` text NOT NULL REFERENCES `drafts`(`id`) ON DELETE CASCADE,
  `player_id` text REFERENCES `players`(`id`) ON DELETE SET NULL,
  `roster_id` text REFERENCES `rosters`(`id`) ON DELETE SET NULL,
  `provider` text NOT NULL,
  `external_pick_no` integer NOT NULL,
  `external_player_id` text,
  `picked_by_external_user_id` text,
  `round` integer NOT NULL,
  `draft_slot` integer NOT NULL,
  `is_keeper` integer,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
CREATE UNIQUE INDEX `draft_picks_draft_pick_unique` ON `draft_picks` (`draft_id`, `external_pick_no`);
CREATE INDEX `draft_picks_player_idx` ON `draft_picks` (`player_id`);

CREATE TABLE `provider_syncs` (
  `id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `resource_type` text NOT NULL,
  `external_id` text NOT NULL,
  `league_id` text REFERENCES `leagues`(`id`) ON DELETE SET NULL,
  `status` text NOT NULL,
  `started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `completed_at` integer,
  `counts_json` text DEFAULT '{}' NOT NULL,
  `error_code` text,
  `error_message` text
);
CREATE INDEX `provider_syncs_resource_idx` ON `provider_syncs` (`provider`, `resource_type`, `external_id`, `started_at`);
CREATE INDEX `provider_syncs_league_idx` ON `provider_syncs` (`league_id`);
