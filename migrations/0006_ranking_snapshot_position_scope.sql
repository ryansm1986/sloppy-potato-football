ALTER TABLE `ranking_snapshots`
  ADD COLUMN `position_scope` text NOT NULL DEFAULT 'ALL';

UPDATE `ranking_snapshots`
SET `position_scope` = COALESCE(
  (
    SELECT CASE
      WHEN COUNT(*) = COUNT(NULLIF(TRIM(`entry`.`position`), ''))
        AND COUNT(DISTINCT UPPER(TRIM(`entry`.`position`))) = 1
      THEN MAX(UPPER(TRIM(`entry`.`position`)))
      ELSE 'ALL'
    END
    FROM `ranking_snapshot_entries` AS `entry`
    WHERE `entry`.`snapshot_id` = `ranking_snapshots`.`id`
  ),
  'ALL'
);

CREATE INDEX `ranking_snapshots_exact_scope_latest_idx`
  ON `ranking_snapshots` (
    `ranking_type`, `scoring_format`, `season`, `week`, `position_scope`,
    `source_id`, `generated_at`, `id`
  );
