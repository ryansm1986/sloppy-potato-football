import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { SleeperClient } from "../providers/sleeper/client";
import { NFL_TEAMS, syncSleeperPlayerCatalog } from "./player-catalog";

function catalogClient(payload: unknown) {
  return new SleeperClient("https://catalog.test/v1", (async () => Response.json(payload)) as typeof fetch);
}

const catalog = {
  qb1: {
    player_id: "qb1",
    active: true,
    sport: "nfl",
    first_name: "Active",
    last_name: "Quarterback",
    full_name: "Active Quarterback",
    position: "QB",
    fantasy_positions: ["QB"],
    team: "ATL",
    status: "Active",
  },
  kicker1: {
    player_id: "kicker1",
    active: true,
    sport: "nfl",
    full_name: "Active Kicker",
    position: "K",
    fantasy_positions: ["K"],
    team: "DAL",
    status: "Active",
  },
  inactiveRb: {
    player_id: "inactiveRb",
    active: false,
    sport: "nfl",
    full_name: "Inactive Runner",
    position: "RB",
    fantasy_positions: ["RB"],
    team: "CHI",
  },
  freeAgent: {
    player_id: "freeAgent",
    active: true,
    sport: "nfl",
    full_name: "Unsigned Receiver",
    position: "WR",
    fantasy_positions: ["WR"],
    team: null,
  },
  fullback: {
    player_id: "fullback",
    active: true,
    sport: "nfl",
    full_name: "Rostered Fullback",
    position: "FB",
    fantasy_positions: ["RB"],
    team: "SF",
  },
  BUF: {
    player_id: "BUF",
    active: true,
    sport: "nfl",
    full_name: null,
    position: "DEF",
    fantasy_positions: ["DEF"],
    team: "BUF",
  },
};

describe("Sleeper fantasy player catalog sync", () => {
  it("filters offensive players, guarantees 32 defenses, and is idempotent", async () => {
    const db = drizzle(env.DB, { schema });
    const client = catalogClient(catalog);

    const first = await syncSleeperPlayerCatalog(db, client, new Date("2026-09-02T12:00:00Z"));
    const firstIds = await env.DB.prepare(
      `SELECT e.external_id AS externalId, e.player_id AS playerId
       FROM player_external_ids e WHERE e.provider = 'sleeper' ORDER BY e.external_id`,
    ).all<{ externalId: string; playerId: string }>();
    const second = await syncSleeperPlayerCatalog(db, client, new Date("2026-09-02T13:00:00Z"));
    const secondIds = await env.DB.prepare(
      `SELECT e.external_id AS externalId, e.player_id AS playerId
       FROM player_external_ids e WHERE e.provider = 'sleeper' ORDER BY e.external_id`,
    ).all<{ externalId: string; playerId: string }>();

    expect(first.counts).toMatchObject({
      received: 6,
      eligible: 34,
      offensivePlayers: 2,
      teamDefenses: 32,
      insertedPlayers: 34,
      updatedPlayers: 0,
      externalIdsUpserted: 34,
    });
    expect(second.counts).toMatchObject({ insertedPlayers: 0, updatedPlayers: 34 });
    expect(secondIds.results).toEqual(firstIds.results);

    const defenses = await env.DB.prepare(
      "SELECT nfl_team AS team, full_name AS fullName FROM players WHERE is_team_defense = 1 ORDER BY nfl_team",
    ).all<{ team: string; fullName: string }>();
    expect(defenses.results).toHaveLength(32);
    expect(defenses.results.map((row) => row.team)).toEqual(Object.keys(NFL_TEAMS).sort());
    expect(defenses.results.find((row) => row.team === "ARI")?.fullName).toBe("Arizona Cardinals D/ST");

    const excluded = await env.DB.prepare(
      `SELECT external_id AS externalId FROM player_external_ids
       WHERE provider = 'sleeper' AND external_id IN ('inactiveRb', 'freeAgent', 'fullback')`,
    ).all();
    expect(excluded.results).toEqual([]);

    const successfulSyncs = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM provider_syncs
       WHERE provider = 'sleeper' AND resource_type = 'player_catalog' AND status = 'succeeded'`,
    ).first<{ count: number }>();
    expect(successfulSyncs?.count).toBe(2);
  });

  it("records upstream failure without changing existing player data", async () => {
    const db = drizzle(env.DB, { schema });
    await syncSleeperPlayerCatalog(db, catalogClient(catalog));
    const beforePlayers = await env.DB.prepare(
      "SELECT id, full_name AS fullName, updated_at AS updatedAt FROM players ORDER BY id",
    ).all();
    const beforeExternalIds = await env.DB.prepare(
      "SELECT player_id AS playerId, external_id AS externalId FROM player_external_ids ORDER BY external_id",
    ).all();
    const invalidClient = new SleeperClient(
      "https://catalog.test/v1",
      (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    );

    await expect(syncSleeperPlayerCatalog(db, invalidClient)).rejects.toMatchObject({
      code: "invalid_response",
    });

    const afterPlayers = await env.DB.prepare(
      "SELECT id, full_name AS fullName, updated_at AS updatedAt FROM players ORDER BY id",
    ).all();
    const afterExternalIds = await env.DB.prepare(
      "SELECT player_id AS playerId, external_id AS externalId FROM player_external_ids ORDER BY external_id",
    ).all();
    expect(afterPlayers.results).toEqual(beforePlayers.results);
    expect(afterExternalIds.results).toEqual(beforeExternalIds.results);
    const failedSync = await env.DB.prepare(
      `SELECT status, error_code AS errorCode FROM provider_syncs
       WHERE provider = 'sleeper' AND resource_type = 'player_catalog' AND status = 'failed'
       LIMIT 1`,
    ).first<{ status: string; errorCode: string }>();
    expect(failedSync).toEqual({ status: "failed", errorCode: "invalid_response" });
  });
});
