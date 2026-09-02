import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const nowMs = sql`(unixepoch() * 1000)`;

export const leagues = sqliteTable(
  "leagues",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    sport: text("sport").notNull().default("nfl"),
    season: text("season").notNull(),
    seasonType: text("season_type").notNull(),
    status: text("status").notNull(),
    avatarUrl: text("avatar_url"),
    rosterPositionsJson: text("roster_positions_json").notNull().default("[]"),
    settingsJson: text("settings_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("leagues_provider_external_unique").on(table.provider, table.externalId),
    index("leagues_season_idx").on(table.season),
  ],
);

export const leagueMembers = sqliteTable(
  "league_members",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalUserId: text("external_user_id").notNull(),
    username: text("username"),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    teamName: text("team_name"),
    isCommissioner: integer("is_commissioner", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("league_members_provider_external_unique").on(
      table.leagueId,
      table.provider,
      table.externalUserId,
    ),
    index("league_members_league_idx").on(table.leagueId),
  ],
);

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => leagueMembers.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [index("teams_league_idx").on(table.leagueId)],
);

export const rosters = sqliteTable(
  "rosters",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalRosterId: integer("external_roster_id").notNull(),
    ownerExternalUserId: text("owner_external_user_id"),
    settingsJson: text("settings_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("rosters_provider_external_unique").on(
      table.leagueId,
      table.provider,
      table.externalRosterId,
    ),
    uniqueIndex("rosters_team_unique").on(table.teamId),
    index("rosters_league_idx").on(table.leagueId),
  ],
);

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    sport: text("sport").notNull().default("nfl"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name").notNull(),
    searchName: text("search_name").notNull(),
    position: text("position"),
    fantasyPositionsJson: text("fantasy_positions_json").notNull().default("[]"),
    nflTeam: text("nfl_team"),
    number: integer("number"),
    status: text("status"),
    injuryStatus: text("injury_status"),
    injuryBodyPart: text("injury_body_part"),
    injuryNotes: text("injury_notes"),
    age: integer("age"),
    height: text("height"),
    weight: text("weight"),
    college: text("college"),
    yearsExperience: integer("years_experience"),
    depthChartPosition: text("depth_chart_position"),
    depthChartOrder: integer("depth_chart_order"),
    isTeamDefense: integer("is_team_defense", { mode: "boolean" }).notNull().default(false),
    newsUpdatedAt: integer("news_updated_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    index("players_search_name_idx").on(table.searchName),
    index("players_position_team_idx").on(table.position, table.nflTeam),
  ],
);

export const playerExternalIds = sqliteTable(
  "player_external_ids",
  {
    id: text("id").primaryKey(),
    playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("player_external_ids_provider_external_unique").on(table.provider, table.externalId),
    index("player_external_ids_player_idx").on(table.playerId),
  ],
);

export const rosterPlayers = sqliteTable(
  "roster_players",
  {
    rosterId: text("roster_id").notNull().references(() => rosters.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    slotIndex: integer("slot_index"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    primaryKey({ columns: [table.rosterId, table.playerId] }),
    index("roster_players_player_idx").on(table.playerId),
  ],
);

export const scoringSettings = sqliteTable(
  "scoring_settings",
  {
    leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: real("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [primaryKey({ columns: [table.leagueId, table.key] })],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    season: text("season").notNull(),
    seasonType: text("season_type").notNull(),
    name: text("name"),
    settingsJson: text("settings_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    startTime: integer("start_time", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("drafts_provider_external_unique").on(table.provider, table.externalId),
    index("drafts_league_idx").on(table.leagueId),
  ],
);

export const draftPicks = sqliteTable(
  "draft_picks",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull().references(() => drafts.id, { onDelete: "cascade" }),
    playerId: text("player_id").references(() => players.id, { onDelete: "set null" }),
    rosterId: text("roster_id").references(() => rosters.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalPickNo: integer("external_pick_no").notNull(),
    externalPlayerId: text("external_player_id"),
    pickedByExternalUserId: text("picked_by_external_user_id"),
    round: integer("round").notNull(),
    draftSlot: integer("draft_slot").notNull(),
    isKeeper: integer("is_keeper", { mode: "boolean" }),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("draft_picks_draft_pick_unique").on(table.draftId, table.externalPickNo),
    index("draft_picks_player_idx").on(table.playerId),
  ],
);

export const providerSyncs = sqliteTable(
  "provider_syncs",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    leagueId: text("league_id").references(() => leagues.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    countsJson: text("counts_json").notNull().default("{}"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("provider_syncs_resource_idx").on(
      table.provider,
      table.resourceType,
      table.externalId,
      table.startedAt,
    ),
    index("provider_syncs_league_idx").on(table.leagueId),
  ],
);

export const syncLocks = sqliteTable("sync_locks", {
  key: text("key").primaryKey(),
  token: text("token").notNull(),
  lockedAt: integer("locked_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const rankingSources = sqliteTable(
  "ranking_sources",
  {
    id: text("id").primaryKey(),
    canonicalKey: text("canonical_key").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider"),
    attributionUrl: text("attribution_url"),
    refreshMode: text("refresh_mode").notNull().default("manual"),
    refreshIntervalMinutes: integer("refresh_interval_minutes"),
    lastRefreshRequestedAt: integer("last_refresh_requested_at", { mode: "timestamp_ms" }),
    lastRefreshCompletedAt: integer("last_refresh_completed_at", { mode: "timestamp_ms" }),
    lastRefreshStatus: text("last_refresh_status"),
    lastRefreshError: text("last_refresh_error"),
    provenanceJson: text("provenance_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("ranking_sources_canonical_key_unique").on(table.canonicalKey),
    uniqueIndex("ranking_sources_slug_unique").on(table.slug),
  ],
);

export const rankingSourceAliases = sqliteTable(
  "ranking_source_aliases",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => rankingSources.id, { onDelete: "cascade" }),
    aliasType: text("alias_type").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    displayValue: text("display_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("ranking_source_aliases_type_value_unique").on(
      table.aliasType,
      table.normalizedValue,
    ),
    index("ranking_source_aliases_source_idx").on(table.sourceId),
  ],
);

export const rankingSnapshots = sqliteTable(
  "ranking_snapshots",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => rankingSources.id, { onDelete: "cascade" }),
    externalRunId: text("external_run_id"),
    title: text("title").notNull(),
    scoringFormat: text("scoring_format").notNull(),
    rankingType: text("ranking_type").notNull(),
    season: text("season").notNull(),
    week: integer("week"),
    positionScope: text("position_scope").notNull().default("ALL"),
    leagueSize: integer("league_size").notNull().default(12),
    status: text("status").notNull().default("completed"),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    summary: text("summary"),
    methodology: text("methodology"),
    researchJobId: text("research_job_id"),
    sourceUrl: text("source_url"),
    discoverNewSources: integer("discover_new_sources", { mode: "boolean" }).notNull().default(false),
    isNewDiscovery: integer("is_new_discovery", { mode: "boolean" }).notNull().default(false),
    newPublisherCount: integer("new_publisher_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("ranking_snapshots_source_run_unique").on(table.sourceId, table.externalRunId),
    index("ranking_snapshots_latest_idx").on(
      table.rankingType,
      table.scoringFormat,
      table.season,
      table.generatedAt,
    ),
    index("ranking_snapshots_source_scope_latest_idx").on(
      table.sourceId,
      table.rankingType,
      table.scoringFormat,
      table.season,
      table.week,
      table.generatedAt,
    ),
    index("ranking_snapshots_exact_scope_latest_idx").on(
      table.rankingType,
      table.scoringFormat,
      table.season,
      table.week,
      table.positionScope,
      table.sourceId,
      table.generatedAt,
      table.id,
    ),
    index("ranking_snapshots_league_exact_scope_latest_idx").on(
      table.rankingType,
      table.scoringFormat,
      table.leagueSize,
      table.season,
      table.week,
      table.positionScope,
      table.sourceId,
      table.createdAt,
      table.id,
    ),
    index("ranking_snapshots_research_job_idx").on(table.researchJobId, table.externalRunId),
  ],
);

export const rankingSnapshotEntries = sqliteTable(
  "ranking_snapshot_entries",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id").notNull().references(() => rankingSnapshots.id, { onDelete: "cascade" }),
    playerId: text("player_id").references(() => players.id, { onDelete: "set null" }),
    externalPlayerId: text("external_player_id"),
    playerName: text("player_name").notNull(),
    position: text("position"),
    nflTeam: text("nfl_team"),
    rank: integer("rank").notNull(),
    previousRank: integer("previous_rank"),
    tier: integer("tier"),
    insight: text("insight"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("ranking_snapshot_entries_rank_unique").on(table.snapshotId, table.rank),
    index("ranking_snapshot_entries_player_idx").on(table.playerId, table.snapshotId),
  ],
);

// Personal ranking writes intentionally have no routes until a verified Access
// identity can supply ownerIdentity. The owner value should be an issuer-qualified
// subject, not an email address or a client-provided identifier.
export const rankingLists = sqliteTable(
  "ranking_lists",
  {
    id: text("id").primaryKey(),
    ownerIdentity: text("owner_identity").notNull(),
    leagueId: text("league_id").references(() => leagues.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    rankingType: text("ranking_type").notNull(),
    scoringFormat: text("scoring_format").notNull(),
    season: text("season").notNull(),
    week: integer("week"),
    seedSnapshotId: text("seed_snapshot_id").references(() => rankingSnapshots.id, { onDelete: "set null" }),
    revision: integer("revision").notNull().default(0),
    settingsJson: text("settings_json").notNull().default("{}"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    index("ranking_lists_owner_scope_idx").on(
      table.ownerIdentity,
      table.leagueId,
      table.rankingType,
      table.scoringFormat,
      table.season,
      table.week,
      table.archivedAt,
    ),
  ],
);

export const rankingListEntries = sqliteTable(
  "ranking_list_entries",
  {
    listId: text("list_id").notNull().references(() => rankingLists.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
    sortKey: integer("sort_key").notNull(),
    tier: integer("tier"),
    note: text("note"),
    sourceSnapshotId: text("source_snapshot_id").references(() => rankingSnapshots.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.playerId] }),
    index("ranking_list_entries_order_idx").on(table.listId, table.sortKey, table.playerId),
    index("ranking_list_entries_player_idx").on(table.playerId, table.listId),
  ],
);

export const researchRunners = sqliteTable(
  "research_runners",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    version: text("version"),
    status: text("status").notNull().default("online"),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    currentJobId: text("current_job_id"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [index("research_runners_last_seen_idx").on(table.lastSeenAt, table.status)],
);

export const researchJobs = sqliteTable(
  "research_jobs",
  {
    id: text("id").primaryKey(),
    ownerIdentity: text("owner_identity").notNull(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    taskInputJson: text("task_input_json").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leasedByRunnerId: text("leased_by_runner_id").references(() => researchRunners.id, { onDelete: "set null" }),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    completionKey: text("completion_key"),
    resultJson: text("result_json"),
    rankingSnapshotId: text("ranking_snapshot_id").references(() => rankingSnapshots.id, { onDelete: "set null" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    newPublisherCount: integer("new_publisher_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("research_jobs_owner_idempotency_unique").on(table.ownerIdentity, table.idempotencyKey),
    index("research_jobs_queue_idx").on(table.status, table.priority, table.createdAt),
    index("research_jobs_owner_created_idx").on(table.ownerIdentity, table.createdAt),
    index("research_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
  ],
);

export const researchJobEvents = sqliteTable(
  "research_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => researchJobs.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [index("research_job_events_job_created_idx").on(table.jobId, table.createdAt)],
);

export const sleeperReports = sqliteTable(
  "sleeper_reports",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => researchJobs.id, { onDelete: "cascade" }),
    season: text("season").notNull(),
    scoringFormat: text("scoring_format").notNull(),
    rankingType: text("ranking_type").notNull(),
    leagueSize: integer("league_size").notNull(),
    summary: text("summary").notNull(),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    discoverNewSources: integer("discover_new_sources", { mode: "boolean" }).notNull().default(false),
    newPublisherCount: integer("new_publisher_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("sleeper_reports_job_unique").on(table.jobId),
    index("sleeper_reports_latest_idx").on(table.publishedAt, table.id),
  ],
);

export const sleeperPositionSummaries = sqliteTable(
  "sleeper_position_summaries",
  {
    reportId: text("report_id").notNull().references(() => sleeperReports.id, { onDelete: "cascade" }),
    position: text("position").notNull(),
    summary: text("summary").notNull(),
  },
  (table) => [primaryKey({ columns: [table.reportId, table.position] })],
);

export const sleeperCandidates = sqliteTable(
  "sleeper_candidates",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => sleeperReports.id, { onDelete: "cascade" }),
    position: text("position").notNull(),
    positionRank: integer("position_rank").notNull(),
    playerName: text("player_name").notNull(),
    team: text("team"),
    sourceCount: integer("source_count").notNull(),
    recommendedPickStart: integer("recommended_pick_start").notNull(),
    recommendedPickEnd: integer("recommended_pick_end").notNull(),
    summary: text("summary").notNull(),
    upside: text("upside"),
    risk: text("risk"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("sleeper_candidates_report_player_unique").on(table.reportId, table.position, table.playerName),
    index("sleeper_candidates_report_position_rank_idx").on(table.reportId, table.position, table.positionRank, table.id),
  ],
);

export const sleeperCandidateSources = sqliteTable(
  "sleeper_candidate_sources",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull().references(() => sleeperCandidates.id, { onDelete: "cascade" }),
    publisher: text("publisher").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    sourceDomain: text("source_domain").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    recommendation: text("recommendation"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    isNewDiscovery: integer("is_new_discovery", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("sleeper_candidate_sources_domain_unique").on(table.candidateId, table.sourceDomain),
    index("sleeper_candidate_sources_candidate_idx").on(table.candidateId, table.publisher, table.id),
  ],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type League = typeof leagues.$inferSelect;
