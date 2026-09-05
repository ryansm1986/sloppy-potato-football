CREATE TABLE auth_users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  google_sub TEXT UNIQUE,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','researcher','viewer')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX auth_single_owner ON auth_users(role) WHERE role = 'owner';
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser','desktop')),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE auth_oauth_flows (
  state_hash TEXT PRIMARY KEY NOT NULL,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  desktop_request_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_desktop_requests (
  id TEXT PRIMARY KEY NOT NULL,
  secret_hash TEXT NOT NULL,
  browser_session_hash TEXT,
  user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
  approved_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_audit_created_idx ON auth_audit_events(created_at DESC);
CREATE TABLE auth_start_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_start_limits_expiry_idx ON auth_start_limits(expires_at);
