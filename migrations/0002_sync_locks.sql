CREATE TABLE `sync_locks` (
  `key` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL,
  `locked_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
