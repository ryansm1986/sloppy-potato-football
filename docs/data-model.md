# Data model and Sleeper import

## Identity boundary

Sloppy Potato Fantasy Football owns its primary IDs. Provider IDs are stored separately and are never used as application primary keys.

- `players.id` is the canonical player ID.
- `player_external_ids` maps a provider and its external ID to one canonical player.
- `leagues.id`, `league_members.id`, `teams.id`, `rosters.id`, and `drafts.id` are also app-owned IDs.
- Provider/external-ID unique indexes make imports repeatable and prepare the model for future Yahoo or manual mappings.

Sleeper team defenses use IDs such as `BUF`. They are represented as canonical players with `is_team_defense = 1`, position `DEF`, and a normal external-ID mapping.

## Imported graph

```text
league
├── scoring_settings
├── league_members
├── teams
│   └── rosters
│       └── roster_players ── players ── player_external_ids
├── drafts
│   └── draft_picks ───────── players / rosters
└── provider_syncs
```

`roster_players.role` is one of `starter`, `bench`, `reserve`, or `taxi`. Starter order is preserved in `slot_index`; the league's ordered slot definitions are preserved in `leagues.roster_positions_json`.

## Import behavior

`POST /api/imports/sleeper` accepts:

```json
{ "leagueId": "123456789012345678" }
```

The importer:

1. Fetches the league, users, rosters, drafts, and draft picks from Sleeper.
2. Collects every referenced player ID.
3. Reuses existing external-ID mappings and avoids refreshing the active NFL catalog more than once per 24 hours when every referenced player is already known. An unmapped player triggers a refresh; draft metadata supplies names for historical players absent from the active catalog.
4. Upserts league, member, team, roster, player, and draft identities.
5. Replaces scoring keys, roster membership, and draft picks with the provider's current state.
6. Records a succeeded or failed diagnostic row in `provider_syncs`.
7. Serializes imports with a five-minute recoverable D1 lock. Related replacement statements use D1 batches so roster, scoring, and draft-pick sets change atomically.

The full import remains retryable rather than depending on one long transaction. Stable unique keys repair completed entity groups on the next run, while each replacement group is internally atomic.

## API routes

- `POST /api/imports/sleeper` — import by Sleeper league ID
- `POST /api/leagues/:leagueId/sync` — resync an existing canonical league
- `GET /api/leagues/:leagueId` — league, members, rosters, scoring, and latest sync
- `GET /api/players?query=&position=&limit=` — canonical player search
- `GET /api/players/:playerId` — canonical player with provider mappings

Import and sync are open on localhost. A deployed Worker must have `IMPORT_ADMIN_TOKEN` configured, and callers must send it as a Bearer token. This keeps writes private without adding an identity provider for a friends-only deployment.

## Local D1

Apply migrations:

```bash
pnpm db:migrate:local
```

Start the app:

```bash
pnpm dev
```

The local database persists under `.wrangler/`, which is ignored by Git.

## Remote D1

`wrangler.jsonc` targets the existing production D1 database. Apply pending migrations before deploying code that uses them:

```bash
pnpm wrangler d1 migrations apply sloppy-potato-football-db --remote
```

The checked deployment command and GitHub workflow run this remote migration step only after validation succeeds.

## Rankings and source registry

Ranking sources and ranking results are separate identities:

```text
ranking_sources (one canonical stream)
├── ranking_source_aliases (old slugs, names, URLs, external IDs)
└── ranking_snapshots (one immutable completed agent/import run)
    └── ranking_snapshot_entries (ordered player results)
```

`ranking_sources.canonical_key` is the permanent, unique identity used to deduplicate agent discoveries. The human label, provider, URL, and aliases may evolve without creating another source. Resolution is exact and deterministic; similar display names are not fuzzy-merged. `external_run_id`, unique within a source, makes runner retries idempotent.

Favorites in the current client store canonical source keys, so a new snapshot or source-label change does not break the favorite. Future authenticated favorites should reference the canonical source ID in D1.

Protected source and snapshot routes:

- `GET /api/rankings/sources?limit=&after=` — paginated source catalog, aliases, refresh/provenance metadata, and latest snapshot metadata
- `POST /api/rankings/sources/resolve` — resolve or create a canonical source from a stable key and aliases
- `GET /api/rankings/snapshots?limit=` — latest completed immutable snapshots with entries
- `POST /api/rankings/snapshots` — validate and ingest one completed agent/import run

`ranking_lists` and `ranking_list_entries` provide indexed owner-scoped storage for future cloud-saved personal rankings. They intentionally have no public write API yet. Once Cloudflare Access is configured, `owner_identity` must come from the verified issuer-qualified subject, never an email or owner value sent by the browser.

## Research runner bridge

The research bridge stores durable, auditable work separately from immutable ranking snapshots:

```text
research_runners
research_jobs
â””â”€â”€ research_job_events
      â””â”€â”€ optional ranking_snapshots result
```

Owner routes require `RESEARCH_OWNER_TOKEN`; runner routes require the separate `AGENT_RUNNER_TOKEN`. Only localhost bypasses missing bridge secrets. A browser can create only bounded `player_research`, `rankings_research`, or `source_refresh` jobsâ€”it cannot relay a freeform prompt or command. The Worker builds the execution context, leases work for 15 minutes, retries recoverable failures up to three times, and records every queue, claim, retry, failure, and completion event.

The runner sends heartbeats and polls over outbound HTTPS. It executes Codex in a dedicated temporary directory with a read-only sandbox, live web search, user configuration and project rules disabled, a time limit, and a strict output schema. Results are validated locally and again by the Worker. For ranking results, the Worker ignores runner-supplied canonical IDs, derives the canonical source from the protected job and registered provider, and forces `external_run_id` to the research job ID so completion retries are idempotent.

Bridge routes:

- `POST /api/research/jobs`, `GET /api/research/jobs`, `GET /api/research/jobs/:jobId`, and `POST /api/research/jobs/:jobId/retry`
- `GET /api/research/runner/status`
- `POST /api/runners/heartbeat`, `POST /api/runners/jobs/claim`, `POST /api/runners/jobs/:jobId/result`, and `POST /api/runners/jobs/:jobId/fail`
