ALTER TABLE `ranking_lists`
  ADD COLUMN `write_token` text;

ALTER TABLE `ranking_lists`
  ADD COLUMN `list_kind` text NOT NULL DEFAULT 'custom'
  CHECK (`list_kind` IN ('custom', 'personal'));

CREATE UNIQUE INDEX `ranking_lists_active_personal_scope_unique`
  ON `ranking_lists` (
    `owner_identity`,
    ifnull(`league_id`, ''),
    `ranking_type`,
    `scoring_format`,
    `season`,
    ifnull(`week`, -1)
  )
  WHERE `archived_at` IS NULL AND `list_kind` = 'personal';
