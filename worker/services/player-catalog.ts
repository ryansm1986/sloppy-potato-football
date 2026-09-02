import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { playerExternalIds, providerSyncs } from "../db/schema";
import * as schema from "../db/schema";
import { canonicalizeSleeperPlayer, sleeperExternalMetadata } from "../domain/canonical-player";
import { SleeperClient } from "../providers/sleeper/client";
import type { SleeperPlayer, SleeperPlayerMap } from "../providers/sleeper/types";

const PROVIDER = "sleeper";
const RESOURCE_TYPE = "player_catalog";
const RESOURCE_ID = "nfl";
const ROW_CHUNK_SIZE = 100;
const LOOKUP_CHUNK_SIZE = 400;
const STATEMENT_BATCH_SIZE = 20;
const OFFENSIVE_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K"]);

export const NFL_TEAMS = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LV: "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
} as const;

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

type CatalogEntry = {
  externalId: string;
  player: SleeperPlayer;
};

export type PlayerCatalogSyncResult = {
  syncId: string;
  provider: typeof PROVIDER;
  counts: {
    received: number;
    eligible: number;
    offensivePlayers: number;
    teamDefenses: number;
    insertedPlayers: number;
    updatedPlayers: number;
    externalIdsUpserted: number;
  };
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizedPosition(player: SleeperPlayer): string {
  return player.position?.trim().toUpperCase() ?? "";
}

function normalizedTeam(player: SleeperPlayer): string {
  return player.team?.trim().toUpperCase() ?? "";
}

function isEligibleOffensivePlayer(player: SleeperPlayer): boolean {
  return player.active === true
    && OFFENSIVE_POSITIONS.has(normalizedPosition(player))
    && normalizedTeam(player) in NFL_TEAMS;
}

function defensePlayer(catalog: SleeperPlayerMap, team: keyof typeof NFL_TEAMS): SleeperPlayer {
  const source = catalog[team]
    ?? Object.values(catalog).find((player) =>
      ["DEF", "DST"].includes(normalizedPosition(player)) && normalizedTeam(player) === team,
    );
  return {
    ...source,
    player_id: team,
    active: true,
    sport: "nfl",
    full_name: source?.full_name?.trim() || `${NFL_TEAMS[team]} D/ST`,
    search_full_name: source?.search_full_name?.trim() || `${NFL_TEAMS[team]} defense`,
    position: "DEF",
    fantasy_positions: ["DEF"],
    team,
    status: source?.status || "Active",
  };
}

export function fantasyCatalogEntries(catalog: SleeperPlayerMap): CatalogEntry[] {
  const offensive = Object.entries(catalog)
    .filter(([, player]) => isEligibleOffensivePlayer(player))
    .map(([externalId, player]) => ({ externalId, player }));
  const defenses = (Object.keys(NFL_TEAMS) as Array<keyof typeof NFL_TEAMS>)
    .map((team) => ({ externalId: team, player: defensePlayer(catalog, team) }));

  return [...offensive, ...defenses]
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
}

async function existingMappings(db: Database, externalIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const group of chunks(externalIds, LOOKUP_CHUNK_SIZE)) {
    const rows = await db.$client.prepare(
      `SELECT external_id AS externalId, player_id AS playerId
       FROM player_external_ids
       WHERE provider = ? AND external_id IN (SELECT value FROM json_each(?))`,
    ).bind(PROVIDER, JSON.stringify(group)).all<{ externalId: string; playerId: string }>();
    for (const row of rows.results) result.set(row.externalId, row.playerId);
  }
  return result;
}

function playerUpsertStatement(db: Database, rows: Array<Record<string, unknown>>) {
  return db.$client.prepare(
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
  ).bind(JSON.stringify(rows));
}

function externalIdUpsertStatement(db: Database, rows: Array<Record<string, unknown>>) {
  return db.$client.prepare(
    `INSERT INTO player_external_ids (
       id, player_id, provider, external_id, metadata_json, first_seen_at, last_seen_at
     )
     SELECT
       json_extract(value, '$.id'), json_extract(value, '$.playerId'),
       json_extract(value, '$.provider'), json_extract(value, '$.externalId'),
       json_extract(value, '$.metadataJson'), json_extract(value, '$.firstSeenAt'),
       json_extract(value, '$.lastSeenAt')
     FROM json_each(?) WHERE true
     ON CONFLICT(provider, external_id) DO UPDATE SET
       metadata_json = excluded.metadata_json,
       last_seen_at = excluded.last_seen_at`,
  ).bind(JSON.stringify(rows));
}

async function runBoundedBatches(db: Database, statements: D1PreparedStatement[]) {
  for (const group of chunks(statements, STATEMENT_BATCH_SIZE)) {
    await db.$client.batch(group);
  }
}

export async function syncSleeperPlayerCatalog(
  db: Database,
  client: SleeperClient,
  now = new Date(),
): Promise<PlayerCatalogSyncResult> {
  const syncId = crypto.randomUUID();
  await db.insert(providerSyncs).values({
    id: syncId,
    provider: PROVIDER,
    resourceType: RESOURCE_TYPE,
    externalId: RESOURCE_ID,
    status: "running",
    startedAt: now,
  });

  let catalog: SleeperPlayerMap;
  try {
    catalog = await client.getActiveNflPlayers();
  } catch (error) {
    await db.update(providerSyncs).set({
      status: "failed",
      completedAt: new Date(),
      errorCode: error instanceof Error && "code" in error ? String(error.code) : "catalog_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown catalog failure",
    }).where(eq(providerSyncs.id, syncId));
    throw error;
  }

  const entries = fantasyCatalogEntries(catalog);
  const mapping = await existingMappings(db, entries.map((entry) => entry.externalId));
  const playerRows: Array<Record<string, unknown>> = [];
  const externalRows: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    const playerId = mapping.get(entry.externalId) ?? crypto.randomUUID();
    const canonical = canonicalizeSleeperPlayer(entry.externalId, entry.player);
    playerRows.push({
      id: playerId,
      ...canonical,
      isTeamDefense: canonical.isTeamDefense ? 1 : 0,
      newsUpdatedAt: canonical.newsUpdatedAt?.getTime() ?? null,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    });
    externalRows.push({
      id: crypto.randomUUID(),
      playerId,
      provider: PROVIDER,
      externalId: entry.externalId,
      metadataJson: sleeperExternalMetadata(entry.player),
      firstSeenAt: now.getTime(),
      lastSeenAt: now.getTime(),
    });
  }

  const statements: D1PreparedStatement[] = [];
  for (const group of chunks(playerRows, ROW_CHUNK_SIZE)) statements.push(playerUpsertStatement(db, group));
  for (const group of chunks(externalRows, ROW_CHUNK_SIZE)) statements.push(externalIdUpsertStatement(db, group));

  const counts = {
    received: Object.keys(catalog).length,
    eligible: entries.length,
    offensivePlayers: entries.length - Object.keys(NFL_TEAMS).length,
    teamDefenses: Object.keys(NFL_TEAMS).length,
    insertedPlayers: entries.length - mapping.size,
    updatedPlayers: mapping.size,
    externalIdsUpserted: entries.length,
  };

  try {
    await runBoundedBatches(db, statements);
    await db.update(providerSyncs).set({
      status: "succeeded",
      completedAt: new Date(),
      countsJson: JSON.stringify(counts),
    }).where(and(eq(providerSyncs.id, syncId), eq(providerSyncs.status, "running")));
  } catch (error) {
    await db.update(providerSyncs).set({
      status: "failed",
      completedAt: new Date(),
      errorCode: "catalog_persist_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Catalog persistence failed",
    }).where(eq(providerSyncs.id, syncId));
    throw error;
  }

  return { syncId, provider: PROVIDER, counts };
}
