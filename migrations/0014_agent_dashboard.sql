CREATE TABLE research_agent_settings (
  owner_identity TEXT PRIMARY KEY NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A deterministic event ID deduplicates each stage for one lease without
-- retaining lease credentials in the log. This index bounds global feed reads.
CREATE INDEX research_job_events_created_idx ON research_job_events (created_at DESC, id DESC);
