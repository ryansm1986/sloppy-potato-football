CREATE TABLE publishers (
  id TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  rankings INTEGER NOT NULL DEFAULT 0,
  sleepers INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE publisher_preferences (
  publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
  owner_identity TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(publisher_id, owner_identity)
);
CREATE TABLE publisher_policy_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0);
INSERT INTO publisher_policy_version(id,version) VALUES(1,0);
CREATE INDEX publishers_seen_idx ON publishers(last_seen_at DESC);
