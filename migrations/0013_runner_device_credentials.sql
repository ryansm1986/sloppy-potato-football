CREATE TABLE `runner_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_identity` text NOT NULL,
  `device_id` text NOT NULL,
  `runner_id` text NOT NULL,
  `name` text NOT NULL,
  `token_hash` text NOT NULL,
  `token_hint` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `last_used_at` integer,
  `revoked_at` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);

CREATE UNIQUE INDEX `runner_credentials_owner_device_unique`
  ON `runner_credentials` (`owner_identity`, `device_id`);
CREATE UNIQUE INDEX `runner_credentials_owner_runner_unique`
  ON `runner_credentials` (`owner_identity`, `runner_id`);
CREATE UNIQUE INDEX `runner_credentials_token_hash_unique`
  ON `runner_credentials` (`token_hash`);
CREATE INDEX `runner_credentials_owner_created_idx`
  ON `runner_credentials` (`owner_identity`, `created_at`, `id`);
CREATE INDEX `runner_credentials_active_token_idx`
  ON `runner_credentials` (`token_hash`)
  WHERE `revoked_at` IS NULL;
