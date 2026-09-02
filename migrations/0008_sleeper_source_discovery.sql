ALTER TABLE `sleeper_reports`
  ADD COLUMN `discover_new_sources` integer NOT NULL DEFAULT 0;

ALTER TABLE `sleeper_reports`
  ADD COLUMN `new_publisher_count` integer NOT NULL DEFAULT 0;

ALTER TABLE `sleeper_candidate_sources`
  ADD COLUMN `is_new_discovery` integer NOT NULL DEFAULT 0;
