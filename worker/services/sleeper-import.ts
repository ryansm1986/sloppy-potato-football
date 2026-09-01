import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  draftPicks,
  drafts,
  leagueMembers,
  leagues,
  playerExternalIds,
  players,
  providerSyncs,
  rosterPlayers,
  rosters,
  scoringSettings,
  teams,
} from "../db/schema";
import * as schema from "../db/schema";
import { canonicalizeSleeperPlayer, sleeperExternalMetadata } from "../domain/canonical-player";
import { SleeperApiError, SleeperClient } from "../providers/sleeper/client";
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeagueMember,
  SleeperPlayerMap,
  SleeperPlayer,
  SleeperRoster,
} from "../providers/sleeper/types";

const PROVIDER = "sleeper";
const IMPORT_LOCK_KEY = "sleeper:league-imports";
const IMPORT_LOCK_TTL_MS = 5 * 60 * 1000;

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

export type SleeperImportResult = {
  syncId: string;
  leagueId: string;
  externalLeagueId: string;
  name: string;
  season: string;
  counts: {
    members: number;
    rosters: number;
    rosterPlayers: number;
    scoringSettings: number;
    drafts: number;
    draftPicks: number;
    canonicalPlayers: number;
  };
};

export class ImportInProgressError extends Error {
  readonly code = "import_in_progress";

  constructor() {
    super("Another Sleeper import is already running");
    this.name = "ImportInProgressError";
  }
}

async function acquireImportLock(db: Database): Promise<string> {
  const token = crypto.randomUUID();
  const lockedAt = Date.now();
  await db.$client
    .prepare(
      `INSERT INTO sync_locks (key, token, locked_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         token = excluded.token, locked_at = excluded.locked_at, expires_at = excluded.expires_at
       WHERE sync_locks.expires_at <= excluded.locked_at`,
    )
    .bind(IMPORT_LOCK_KEY, token, lockedAt, lockedAt + IMPORT_LOCK_TTL_MS)
    .run();
  const lock = await db.$client
    .prepare("SELECT token FROM sync_locks WHERE key = ?")
    .bind(IMPORT_LOCK_KEY)
    .first<{ token: string }>();
  if (lock?.token !== token) throw new ImportInProgressError();
  return token;
}

async function releaseImportLock(db: Database, token: string): Promise<void> {
  await db.$client
    .prepare("DELETE FROM sync_locks WHERE key = ? AND token = ?")
    .bind(IMPORT_LOCK_KEY, token)
    .run();
}

function avatarUrl(avatarId?: string | null): string | null {
  return avatarId ? `https://sleepercdn.com/avatars/${avatarId}` : null;
}

function objectString(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function memberTeamName(member: SleeperLeagueMember | undefined, rosterId: number): string {
  const candidate = member?.metadata?.team_name;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : member?.display_name || `Team ${rosterId}`;
}

function collectExternalPlayerIds(
  sleeperRosters: SleeperRoster[],
  picksByDraft: Map<string, SleeperDraftPick[]>,
): string[] {
  const ids = new Set<string>();

  for (const roster of sleeperRosters) {
    for (const id of [
      ...(roster.players ?? []),
      ...(roster.starters ?? []),
      ...(roster.reserve ?? []),
      ...(roster.taxi ?? []),
    ]) {
      if (id) ids.add(id);
    }
  }

  for (const picks of picksByDraft.values()) {
    for (const pick of picks) {
      if (pick.player_id) ids.add(pick.player_id);
    }
  }

  return [...ids];
}

async function ensureCanonicalPlayers(
  db: Database,
  client: SleeperClient,
  externalIds: string[],
  now: Date,
  metadataFallbacks: Map<string, SleeperPlayer>,
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();

  const existingMappingResult = await db.$client
    .prepare(
      `SELECT external_id AS externalId, player_id AS playerId
       FROM player_external_ids
       WHERE provider = ?
         AND external_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(PROVIDER, JSON.stringify(externalIds))
    .all<{ externalId: string; playerId: string }>();
  const existingMappings = existingMappingResult.results;
  const mapping = new Map(existingMappings.map((row) => [row.externalId, row.playerId]));
  const missingIds = externalIds.filter((id) => !mapping.has(id));
  let catalog: SleeperPlayerMap = {};
  const freshCatalogSync = await db
    .select({ id: providerSyncs.id })
    .from(providerSyncs)
    .where(
      and(
        eq(providerSyncs.provider, PROVIDER),
        eq(providerSyncs.resourceType, "player_catalog"),
        eq(providerSyncs.externalId, "nfl"),
        eq(providerSyncs.status, "succeeded"),
        gte(providerSyncs.completedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(providerSyncs.completedAt))
    .limit(1);

  let catalogSyncId: string | null = null;
  if (missingIds.length > 0 || !freshCatalogSync[0]) {
    catalogSyncId = crypto.randomUUID();
    await db.insert(providerSyncs).values({
      id: catalogSyncId,
      provider: PROVIDER,
      resourceType: "player_catalog",
      externalId: "nfl",
      status: "running",
      startedAt: now,
    });
    try {
      catalog = await client.getActiveNflPlayers();
    } catch (error) {
      await db
        .update(providerSyncs)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorCode: error instanceof Error && "code" in error ? String(error.code) : "catalog_failed",
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown catalog failure",
        })
        .where(eq(providerSyncs.id, catalogSyncId));
      throw error;
    }
  }

  const playerRows: Array<Record<string, unknown>> = [];
  const externalRows: Array<Record<string, unknown>> = [];
  for (const externalId of externalIds) {
    const sleeperPlayer = catalog[externalId] ?? metadataFallbacks.get(externalId);
    const existingPlayerId = mapping.get(externalId);
    const playerId = existingPlayerId ?? crypto.randomUUID();
    if (!existingPlayerId || sleeperPlayer) {
      const canonical = canonicalizeSleeperPlayer(externalId, sleeperPlayer);
      playerRows.push({
        id: playerId,
        ...canonical,
        isTeamDefense: canonical.isTeamDefense ? 1 : 0,
        newsUpdatedAt: canonical.newsUpdatedAt?.getTime() ?? null,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      });
    }
    externalRows.push({
      id: existingPlayerId ? null : crypto.randomUUID(),
      playerId,
      provider: PROVIDER,
      externalId,
      metadataJson: sleeperExternalMetadata(sleeperPlayer),
      firstSeenAt: now.getTime(),
      lastSeenAt: now.getTime(),
    });
    mapping.set(externalId, playerId);
  }

  const statements: D1PreparedStatement[] = [];
  if (playerRows.length > 0) {
    statements.push(
      db.$client
        .prepare(
          `INSERT INTO players (
             id, sport, first_name, last_name, full_name, search_name, position,
             fantasy_positions_json, nfl_team, number, status, injury_status,
             injury_body_part, injury_notes, age, height, weight, college,
             years_experience, depth_chart_position, depth_chart_order,
             is_team_defense, news_updated_at, created_at, updated_at
           )
           SELECT
             json_extract(value, '$.id'), json_extract(value, '$.sport'),
             json_extract(value, '$.firstName'), json_extract(value, '$.lastName'),
             json_extract(value, '$.fullName'), json_extract(value, '$.searchName'),
             json_extract(value, '$.position'), json_extract(value, '$.fantasyPositionsJson'),
             json_extract(value, '$.nflTeam'), json_extract(value, '$.number'),
             json_extract(value, '$.status'), json_extract(value, '$.injuryStatus'),
             json_extract(value, '$.injuryBodyPart'), json_extract(value, '$.injuryNotes'),
             json_extract(value, '$.age'), json_extract(value, '$.height'),
             json_extract(value, '$.weight'), json_extract(value, '$.college'),
             json_extract(value, '$.yearsExperience'), json_extract(value, '$.depthChartPosition'),
             json_extract(value, '$.depthChartOrder'), json_extract(value, '$.isTeamDefense'),
             json_extract(value, '$.newsUpdatedAt'), json_extract(value, '$.createdAt'),
             json_extract(value, '$.updatedAt')
           FROM json_each(?) WHERE true
           ON CONFLICT(id) DO UPDATE SET
             sport = excluded.sport, first_name = excluded.first_name,
             last_name = excluded.last_name, full_name = excluded.full_name,
             search_name = excluded.search_name, position = excluded.position,
             fantasy_positions_json = excluded.fantasy_positions_json,
             nfl_team = excluded.nfl_team, number = excluded.number, status = excluded.status,
             injury_status = excluded.injury_status, injury_body_part = excluded.injury_body_part,
             injury_notes = excluded.injury_notes, age = excluded.age, height = excluded.height,
             weight = excluded.weight, college = excluded.college,
             years_experience = excluded.years_experience,
             depth_chart_position = excluded.depth_chart_position,
             depth_chart_order = excluded.depth_chart_order,
             is_team_defense = excluded.is_team_defense,
             news_updated_at = excluded.news_updated_at, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify(playerRows)),
    );
  }
  statements.push(
    db.$client
      .prepare(
        `INSERT INTO player_external_ids (
           id, player_id, provider, external_id, metadata_json, first_seen_at, last_seen_at
         )
         SELECT
           COALESCE(json_extract(value, '$.id'), lower(hex(randomblob(16)))),
           json_extract(value, '$.playerId'), json_extract(value, '$.provider'),
           json_extract(value, '$.externalId'), json_extract(value, '$.metadataJson'),
           json_extract(value, '$.firstSeenAt'), json_extract(value, '$.lastSeenAt')
         FROM json_each(?) WHERE true
         ON CONFLICT(provider, external_id) DO UPDATE SET
           player_id = excluded.player_id,
           metadata_json = CASE
             WHEN excluded.metadata_json = '{}' THEN player_external_ids.metadata_json
             ELSE excluded.metadata_json
           END,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(JSON.stringify(externalRows)),
  );
  if (catalogSyncId) {
    statements.push(
      db.$client
        .prepare(
          `UPDATE provider_syncs
           SET status = 'succeeded', completed_at = ?, counts_json = ?
           WHERE id = ?`,
        )
        .bind(
          Date.now(),
          JSON.stringify({ availablePlayers: Object.keys(catalog).length }),
          catalogSyncId,
        ),
    );
  }
  try {
    await db.$client.batch(statements);
  } catch (error) {
    if (catalogSyncId) {
      await db
        .update(providerSyncs)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorCode: "catalog_persist_failed",
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Catalog persistence failed",
        })
        .where(eq(providerSyncs.id, catalogSyncId));
    }
    throw error;
  }

  return mapping;
}

function draftMetadataPlayers(
  picksByDraft: Map<string, SleeperDraftPick[]>,
): Map<string, SleeperPlayer> {
  const result = new Map<string, SleeperPlayer>();
  for (const picks of picksByDraft.values()) {
    for (const pick of picks) {
      if (!pick.player_id) continue;
      const metadata = pick.metadata;
      result.set(pick.player_id, {
        player_id: pick.player_id,
        sport: "nfl",
        first_name: typeof metadata.first_name === "string" ? metadata.first_name : null,
        last_name: typeof metadata.last_name === "string" ? metadata.last_name : null,
        full_name: typeof metadata.full_name === "string" ? metadata.full_name : null,
        position: typeof metadata.position === "string" ? metadata.position : null,
        fantasy_positions:
          typeof metadata.position === "string" ? [metadata.position] : [],
        team: typeof metadata.team === "string" ? metadata.team : null,
        number:
          typeof metadata.number === "string" || typeof metadata.number === "number"
            ? metadata.number
            : null,
      });
    }
  }
  return result;
}

function validateLeagueGraph(
  requestedLeagueId: string,
  league: Awaited<ReturnType<SleeperClient["getLeague"]>>,
  rostersFromSleeper: SleeperRoster[],
  draftsFromSleeper: SleeperDraft[],
  picksByDraft: Map<string, SleeperDraftPick[]>,
): void {
  const invalidRoster = rostersFromSleeper.find((roster) => roster.league_id !== requestedLeagueId);
  const invalidDraft = draftsFromSleeper.find((draft) => draft.league_id !== requestedLeagueId);
  const invalidPick = [...picksByDraft].flatMap(([draftId, picks]) =>
    picks.filter((pick) => pick.draft_id !== draftId),
  )[0];
  if (league.league_id !== requestedLeagueId || invalidRoster || invalidDraft || invalidPick) {
    throw new SleeperApiError(
      "Sleeper returned records that do not belong to the requested league or draft",
      "invalid_response",
    );
  }
}

async function upsertLeague(
  db: Database,
  sleeperLeague: Awaited<ReturnType<SleeperClient["getLeague"]>>,
  now: Date,
) {
  const existing = await db
    .select()
    .from(leagues)
    .where(and(eq(leagues.provider, PROVIDER), eq(leagues.externalId, sleeperLeague.league_id)))
    .limit(1);
  const leagueId = existing[0]?.id ?? crypto.randomUUID();
  const values = {
    provider: PROVIDER,
    externalId: sleeperLeague.league_id,
    name: sleeperLeague.name,
    sport: sleeperLeague.sport,
    season: sleeperLeague.season,
    seasonType: sleeperLeague.season_type,
    status: sleeperLeague.status,
    avatarUrl: avatarUrl(sleeperLeague.avatar),
    rosterPositionsJson: JSON.stringify(sleeperLeague.roster_positions),
    settingsJson: objectString(sleeperLeague.settings),
    updatedAt: now,
  };

  if (existing[0]) {
    await db.update(leagues).set(values).where(eq(leagues.id, leagueId));
  } else {
    await db.insert(leagues).values({ id: leagueId, ...values, createdAt: now });
  }

  return leagueId;
}

async function replaceScoringSettings(
  db: Database,
  leagueId: string,
  settings: Record<string, number>,
  now: Date,
) {
  const rows = Object.entries(settings).map(([key, value]) => ({
    leagueId,
    key,
    value,
    updatedAt: now.getTime(),
  }));
  const statements = [
    db.$client.prepare("DELETE FROM scoring_settings WHERE league_id = ?").bind(leagueId),
  ];
  if (rows.length > 0) {
    statements.push(
      db.$client
        .prepare(
          `INSERT INTO scoring_settings (league_id, key, value, updated_at)
           SELECT
             json_extract(value, '$.leagueId'), json_extract(value, '$.key'),
             json_extract(value, '$.value'), json_extract(value, '$.updatedAt')
           FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows)),
    );
  }
  await db.$client.batch(statements);
}

async function upsertMembers(
  db: Database,
  leagueId: string,
  sleeperMembers: SleeperLeagueMember[],
  now: Date,
): Promise<Map<string, string>> {
  const existing = await db.select().from(leagueMembers).where(eq(leagueMembers.leagueId, leagueId));
  const existingByExternal = new Map(existing.map((member) => [member.externalUserId, member]));
  const result = new Map<string, string>();
  const rows = sleeperMembers.map((member) => {
    const prior = existingByExternal.get(member.user_id);
    const id = prior?.id ?? crypto.randomUUID();
    result.set(member.user_id, id);
    return {
      id,
      leagueId,
      provider: PROVIDER,
      externalUserId: member.user_id,
      username: member.username ?? null,
      displayName: member.display_name,
      avatarUrl: avatarUrl(member.avatar),
      teamName:
        typeof member.metadata?.team_name === "string" ? member.metadata.team_name : null,
      isCommissioner: member.is_owner ? 1 : 0,
      isActive: 1,
      metadataJson: objectString(member.metadata),
      createdAt: prior?.createdAt.getTime() ?? now.getTime(),
      updatedAt: now.getTime(),
    };
  });

  const statements = [
    db.$client
      .prepare("UPDATE league_members SET is_active = 0, updated_at = ? WHERE league_id = ?")
      .bind(now.getTime(), leagueId),
  ];
  if (rows.length > 0) {
    statements.push(
      db.$client
        .prepare(
          `INSERT INTO league_members (
             id, league_id, provider, external_user_id, username, display_name,
             avatar_url, team_name, is_commissioner, is_active, metadata_json,
             created_at, updated_at
           )
           SELECT
             json_extract(value, '$.id'), json_extract(value, '$.leagueId'),
             json_extract(value, '$.provider'), json_extract(value, '$.externalUserId'),
             json_extract(value, '$.username'), json_extract(value, '$.displayName'),
             json_extract(value, '$.avatarUrl'), json_extract(value, '$.teamName'),
             json_extract(value, '$.isCommissioner'), json_extract(value, '$.isActive'),
             json_extract(value, '$.metadataJson'), json_extract(value, '$.createdAt'),
             json_extract(value, '$.updatedAt')
           FROM json_each(?) WHERE true
           ON CONFLICT(league_id, provider, external_user_id) DO UPDATE SET
             username = excluded.username, display_name = excluded.display_name,
             avatar_url = excluded.avatar_url, team_name = excluded.team_name,
             is_commissioner = excluded.is_commissioner, is_active = excluded.is_active,
             metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify(rows)),
    );
  }
  await db.$client.batch(statements);

  return result;
}

async function upsertRosters(
  db: Database,
  leagueId: string,
  sleeperRosters: SleeperRoster[],
  sleeperMembers: SleeperLeagueMember[],
  memberIds: Map<string, string>,
  playerIds: Map<string, string>,
  now: Date,
): Promise<{ rosterIds: Map<number, string>; rosterPlayerCount: number }> {
  const existing = await db.select().from(rosters).where(eq(rosters.leagueId, leagueId));
  const existingByExternal = new Map(existing.map((roster) => [roster.externalRosterId, roster]));
  const memberByExternal = new Map(sleeperMembers.map((member) => [member.user_id, member]));
  const rosterIds = new Map<number, string>();
  const teamRows: Array<Record<string, unknown>> = [];
  const rosterRows: Array<Record<string, unknown>> = [];
  const rosterPlayerRows: Array<Record<string, unknown>> = [];

  for (const sleeperRoster of sleeperRosters) {
    const prior = existingByExternal.get(sleeperRoster.roster_id);
    const rosterId = prior?.id ?? crypto.randomUUID();
    const teamId = prior?.teamId ?? crypto.randomUUID();
    const member = sleeperRoster.owner_id
      ? memberByExternal.get(sleeperRoster.owner_id)
      : undefined;
    teamRows.push({
      id: teamId,
      leagueId,
      memberId: sleeperRoster.owner_id ? memberIds.get(sleeperRoster.owner_id) ?? null : null,
      name: memberTeamName(member, sleeperRoster.roster_id),
      avatarUrl: avatarUrl(member?.avatar),
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    });
    rosterRows.push({
      id: rosterId,
      leagueId,
      teamId,
      provider: PROVIDER,
      externalRosterId: sleeperRoster.roster_id,
      ownerExternalUserId: sleeperRoster.owner_id ?? null,
      settingsJson: objectString(sleeperRoster.settings),
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    });

    rosterIds.set(sleeperRoster.roster_id, rosterId);

    const starters = sleeperRoster.starters ?? [];
    const reserve = new Set(sleeperRoster.reserve ?? []);
    const taxi = new Set(sleeperRoster.taxi ?? []);
    const externalPlayerIds = new Set([
      ...(sleeperRoster.players ?? []),
      ...starters,
      ...reserve,
      ...taxi,
    ]);
    const rows = [...externalPlayerIds].flatMap((externalId) => {
      const playerId = playerIds.get(externalId);
      if (!playerId) return [];
      const starterIndex = starters.indexOf(externalId);
      const role = reserve.has(externalId)
        ? "reserve"
        : taxi.has(externalId)
          ? "taxi"
          : starterIndex >= 0
            ? "starter"
            : "bench";
      return [{
        rosterId,
        playerId,
        role,
        slotIndex: starterIndex >= 0 ? starterIndex : null,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      }];
    });
    rosterPlayerRows.push(...rows);
  }

  const currentRosterIds = [...rosterIds.values()];
  const currentRosterIdSet = new Set(currentRosterIds);
  const staleTeamIds = existing
    .filter((roster) => !currentRosterIdSet.has(roster.id))
    .map((roster) => roster.teamId);
  const statements: D1PreparedStatement[] = [];
  if (teamRows.length > 0) {
    statements.push(db.$client.prepare(
      `INSERT INTO teams (id, league_id, member_id, name, avatar_url, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.leagueId'),
         json_extract(value, '$.memberId'), json_extract(value, '$.name'),
         json_extract(value, '$.avatarUrl'), json_extract(value, '$.createdAt'),
         json_extract(value, '$.updatedAt')
       FROM json_each(?) WHERE true
       ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, name = excluded.name,
         avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(teamRows)));
    statements.push(db.$client.prepare(
      `INSERT INTO rosters (
         id, league_id, team_id, provider, external_roster_id, owner_external_user_id,
         settings_json, created_at, updated_at
       )
       SELECT json_extract(value, '$.id'), json_extract(value, '$.leagueId'),
         json_extract(value, '$.teamId'), json_extract(value, '$.provider'),
         json_extract(value, '$.externalRosterId'), json_extract(value, '$.ownerExternalUserId'),
         json_extract(value, '$.settingsJson'), json_extract(value, '$.createdAt'),
         json_extract(value, '$.updatedAt')
       FROM json_each(?) WHERE true
       ON CONFLICT(league_id, provider, external_roster_id) DO UPDATE SET
         team_id = excluded.team_id, owner_external_user_id = excluded.owner_external_user_id,
         settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(rosterRows)));
  }
  statements.push(db.$client.prepare(
    `DELETE FROM roster_players
     WHERE roster_id IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(currentRosterIds)));
  if (rosterPlayerRows.length > 0) {
    statements.push(db.$client.prepare(
      `INSERT INTO roster_players (roster_id, player_id, role, slot_index, created_at, updated_at)
       SELECT json_extract(value, '$.rosterId'), json_extract(value, '$.playerId'),
         json_extract(value, '$.role'), json_extract(value, '$.slotIndex'),
         json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
       FROM json_each(?)`,
    ).bind(JSON.stringify(rosterPlayerRows)));
  }
  statements.push(db.$client.prepare(
    `DELETE FROM rosters
     WHERE league_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  ).bind(leagueId, JSON.stringify(currentRosterIds)));
  if (staleTeamIds.length > 0) {
    statements.push(db.$client.prepare(
      `DELETE FROM teams WHERE league_id = ? AND id IN (SELECT value FROM json_each(?))`,
    ).bind(leagueId, JSON.stringify(staleTeamIds)));
  }
  await db.$client.batch(statements);

  return { rosterIds, rosterPlayerCount: rosterPlayerRows.length };
}

async function upsertDrafts(
  db: Database,
  leagueId: string,
  sleeperDrafts: SleeperDraft[],
  picksByDraft: Map<string, SleeperDraftPick[]>,
  playerIds: Map<string, string>,
  rosterIds: Map<number, string>,
  now: Date,
): Promise<number> {
  const existing = await db.select().from(drafts).where(eq(drafts.leagueId, leagueId));
  const existingByExternal = new Map(existing.map((draft) => [draft.externalId, draft]));
  const draftRows: Array<Record<string, unknown>> = [];
  const pickRows: Array<Record<string, unknown>> = [];
  const currentDraftIds: string[] = [];

  for (const sleeperDraft of sleeperDrafts) {
    const prior = existingByExternal.get(sleeperDraft.draft_id);
    const draftId = prior?.id ?? crypto.randomUUID();
    const draftName =
      typeof sleeperDraft.metadata.name === "string" ? sleeperDraft.metadata.name : null;
    draftRows.push({
      id: draftId,
      leagueId,
      provider: PROVIDER,
      externalId: sleeperDraft.draft_id,
      type: sleeperDraft.type,
      status: sleeperDraft.status,
      season: sleeperDraft.season,
      seasonType: sleeperDraft.season_type,
      name: draftName,
      settingsJson: objectString(sleeperDraft.settings),
      metadataJson: objectString(sleeperDraft.metadata),
      startTime: sleeperDraft.start_time ?? null,
      createdAt: prior?.createdAt.getTime() ?? now.getTime(),
      updatedAt: now.getTime(),
    });
    currentDraftIds.push(draftId);
    const picks = picksByDraft.get(sleeperDraft.draft_id) ?? [];
    pickRows.push(...picks.map((pick) => {
      const externalRosterId = pick.roster_id === null || pick.roster_id === undefined
        ? null
        : Number(pick.roster_id);
      return {
        id: crypto.randomUUID(),
        draftId,
        playerId: pick.player_id ? playerIds.get(pick.player_id) ?? null : null,
        rosterId:
          externalRosterId !== null && Number.isFinite(externalRosterId)
            ? rosterIds.get(externalRosterId) ?? null
            : null,
        provider: PROVIDER,
        externalPickNo: pick.pick_no,
        externalPlayerId: pick.player_id ?? null,
        pickedByExternalUserId: pick.picked_by ?? null,
        round: pick.round,
        draftSlot: pick.draft_slot,
        isKeeper: pick.is_keeper === null || pick.is_keeper === undefined ? null : pick.is_keeper ? 1 : 0,
        metadataJson: objectString(pick.metadata),
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      };
    }));
  }

  const statements: D1PreparedStatement[] = [];
  if (draftRows.length > 0) {
    statements.push(db.$client.prepare(
      `INSERT INTO drafts (
         id, league_id, provider, external_id, type, status, season, season_type,
         name, settings_json, metadata_json, start_time, created_at, updated_at
       )
       SELECT json_extract(value, '$.id'), json_extract(value, '$.leagueId'),
         json_extract(value, '$.provider'), json_extract(value, '$.externalId'),
         json_extract(value, '$.type'), json_extract(value, '$.status'),
         json_extract(value, '$.season'), json_extract(value, '$.seasonType'),
         json_extract(value, '$.name'), json_extract(value, '$.settingsJson'),
         json_extract(value, '$.metadataJson'), json_extract(value, '$.startTime'),
         json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
       FROM json_each(?) WHERE true
       ON CONFLICT(provider, external_id) DO UPDATE SET
         league_id = excluded.league_id, type = excluded.type, status = excluded.status,
         season = excluded.season, season_type = excluded.season_type, name = excluded.name,
         settings_json = excluded.settings_json, metadata_json = excluded.metadata_json,
         start_time = excluded.start_time, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(draftRows)));
  }
  statements.push(db.$client.prepare(
    `DELETE FROM draft_picks WHERE draft_id IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(currentDraftIds)));
  if (pickRows.length > 0) {
    statements.push(db.$client.prepare(
      `INSERT INTO draft_picks (
         id, draft_id, player_id, roster_id, provider, external_pick_no,
         external_player_id, picked_by_external_user_id, round, draft_slot,
         is_keeper, metadata_json, created_at, updated_at
       )
       SELECT json_extract(value, '$.id'), json_extract(value, '$.draftId'),
         json_extract(value, '$.playerId'), json_extract(value, '$.rosterId'),
         json_extract(value, '$.provider'), json_extract(value, '$.externalPickNo'),
         json_extract(value, '$.externalPlayerId'), json_extract(value, '$.pickedByExternalUserId'),
         json_extract(value, '$.round'), json_extract(value, '$.draftSlot'),
         json_extract(value, '$.isKeeper'), json_extract(value, '$.metadataJson'),
         json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
       FROM json_each(?)`,
    ).bind(JSON.stringify(pickRows)));
  }
  statements.push(db.$client.prepare(
    `DELETE FROM drafts WHERE league_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  ).bind(leagueId, JSON.stringify(currentDraftIds)));
  await db.$client.batch(statements);

  return pickRows.length;
}

export async function importSleeperLeague(
  db: Database,
  client: SleeperClient,
  externalLeagueId: string,
): Promise<SleeperImportResult> {
  const lockToken = await acquireImportLock(db);
  const syncId = crypto.randomUUID();
  const startedAt = new Date();
  try {
    await db.insert(providerSyncs).values({
      id: syncId,
      provider: PROVIDER,
      resourceType: "league",
      externalId: externalLeagueId,
      status: "running",
      startedAt,
    });
    const [sleeperLeague, sleeperRosters, sleeperMembers, sleeperDrafts] = await Promise.all([
      client.getLeague(externalLeagueId),
      client.getRosters(externalLeagueId),
      client.getLeagueMembers(externalLeagueId),
      client.getDrafts(externalLeagueId),
    ]);
    const picks = await Promise.all(
      sleeperDrafts.map(async (draft) => [draft.draft_id, await client.getDraftPicks(draft.draft_id)] as const),
    );
    const picksByDraft = new Map(picks);
    validateLeagueGraph(
      externalLeagueId,
      sleeperLeague,
      sleeperRosters,
      sleeperDrafts,
      picksByDraft,
    );
    const now = new Date();
    const externalPlayerIds = collectExternalPlayerIds(sleeperRosters, picksByDraft);
    const canonicalPlayerIds = await ensureCanonicalPlayers(
      db,
      client,
      externalPlayerIds,
      now,
      draftMetadataPlayers(picksByDraft),
    );
    const leagueId = await upsertLeague(db, sleeperLeague, now);
    await replaceScoringSettings(db, leagueId, sleeperLeague.scoring_settings, now);
    const memberIds = await upsertMembers(db, leagueId, sleeperMembers, now);
    const { rosterIds, rosterPlayerCount } = await upsertRosters(
      db,
      leagueId,
      sleeperRosters,
      sleeperMembers,
      memberIds,
      canonicalPlayerIds,
      now,
    );
    const draftPickCount = await upsertDrafts(
      db,
      leagueId,
      sleeperDrafts,
      picksByDraft,
      canonicalPlayerIds,
      rosterIds,
      now,
    );
    const counts = {
      members: sleeperMembers.length,
      rosters: sleeperRosters.length,
      rosterPlayers: rosterPlayerCount,
      scoringSettings: Object.keys(sleeperLeague.scoring_settings).length,
      drafts: sleeperDrafts.length,
      draftPicks: draftPickCount,
      canonicalPlayers: canonicalPlayerIds.size,
    };

    await db
      .update(providerSyncs)
      .set({
        leagueId,
        status: "succeeded",
        completedAt: now,
        countsJson: JSON.stringify(counts),
      })
      .where(eq(providerSyncs.id, syncId));

    return {
      syncId,
      leagueId,
      externalLeagueId,
      name: sleeperLeague.name,
      season: sleeperLeague.season,
      counts,
    };
  } catch (error) {
    await db
      .update(providerSyncs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCode: error instanceof Error && "code" in error ? String(error.code) : "import_failed",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown import failure",
      })
      .where(eq(providerSyncs.id, syncId));
    throw error;
  } finally {
    await releaseImportLock(db, lockToken);
  }
}
