ALTER TABLE `research_jobs`
  ADD COLUMN `new_publisher_count` integer NOT NULL DEFAULT 0;

ALTER TABLE `ranking_snapshots`
  ADD COLUMN `research_job_id` text;

ALTER TABLE `ranking_snapshots`
  ADD COLUMN `source_url` text;

UPDATE `ranking_snapshots`
SET `source_url` = (
  SELECT `attribution_url`
  FROM `ranking_sources`
  WHERE `ranking_sources`.`id` = `ranking_snapshots`.`source_id`
)
WHERE `source_url` IS NULL;

ALTER TABLE `ranking_snapshots`
  ADD COLUMN `discover_new_sources` integer NOT NULL DEFAULT 0;

ALTER TABLE `ranking_snapshots`
  ADD COLUMN `is_new_discovery` integer NOT NULL DEFAULT 0;

ALTER TABLE `ranking_snapshots`
  ADD COLUMN `new_publisher_count` integer NOT NULL DEFAULT 0;

CREATE INDEX `ranking_snapshots_research_job_idx`
  ON `ranking_snapshots` (`research_job_id`, `external_run_id`);
