ALTER TABLE `ranking_snapshots`
  ADD COLUMN `league_size` integer NOT NULL DEFAULT 12;

CREATE INDEX `ranking_snapshots_league_exact_scope_latest_idx`
  ON `ranking_snapshots` (
    `ranking_type`, `scoring_format`, `league_size`, `season`, `week`,
    `position_scope`, `source_id`, `created_at`, `id`
  );
