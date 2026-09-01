import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { SleeperClient } from "../providers/sleeper/client";
import type { SleeperDraftPick } from "../providers/sleeper/types";
import { ImportInProgressError, importSleeperLeague } from "./sleeper-import";

const externalLeagueId = "123456789012345678";

const fixtures: Record<string, unknown> = {
  [`/v1/league/${externalLeagueId}`]: {
    league_id: externalLeagueId,
    name: "Potato Bowl After Dark",
    sport: "nfl",
    season: "2026",
    season_type: "regular",
    status: "in_season",
    avatar: "league-avatar",
    draft_id: "draft-1",
    total_rosters: 2,
    roster_positions: ["QB", "RB", "WR", "FLEX", "DEF", "BN", "BN"],
    scoring_settings: { rec: 1, pass_td: 4 },
    settings: { playoff_week_start: 15, num_teams: 2 },
  },
  [`/v1/league/${externalLeagueId}/users`]: [
    {
      user_id: "user-1",
      username: "coach_ryan",
      display_name: "Ryan",
      avatar: "avatar-1",
      is_owner: true,
      metadata: { team_name: "Mash Potato Mafia" },
    },
    {
      user_id: "user-2",
      username: "coach_friend",
      display_name: "Friend",
      avatar: null,
      is_owner: false,
      metadata: { team_name: "Air Fryer Assassins" },
    },
  ],
  [`/v1/league/${externalLeagueId}/rosters`]: [
    {
      roster_id: 1,
      league_id: externalLeagueId,
      owner_id: "user-1",
      players: ["1001", "1002", "BUF"],
      starters: ["1001", "BUF"],
      reserve: ["1002"],
      taxi: [],
      settings: { wins: 1, losses: 0, fpts: 118 },
    },
    {
      roster_id: 2,
      league_id: externalLeagueId,
      owner_id: "user-2",
      players: ["1003"],
      starters: ["1003"],
      reserve: [],
      taxi: [],
      settings: { wins: 0, losses: 1, fpts: 104 },
    },
  ],
  [`/v1/league/${externalLeagueId}/drafts`]: [
    {
      draft_id: "draft-1",
      league_id: externalLeagueId,
      type: "snake",
      status: "complete",
      season: "2026",
      season_type: "regular",
      start_time: 1788120000000,
      settings: { teams: 2, rounds: 2 },
      metadata: { name: "Potato Bowl 2026", scoring_type: "ppr" },
      draft_order: { "user-1": 1, "user-2": 2 },
      slot_to_roster_id: { "1": 1, "2": 2 },
    },
  ],
  "/v1/draft/draft-1/picks": [
    {
      draft_id: "draft-1",
      player_id: "1001",
      picked_by: "user-1",
      roster_id: 1,
      round: 1,
      draft_slot: 1,
      pick_no: 1,
      metadata: { first_name: "Bijan", last_name: "Robinson", position: "RB" },
      is_keeper: false,
    },
    {
      draft_id: "draft-1",
      player_id: "1003",
      picked_by: "user-2",
      roster_id: "2",
      round: 1,
      draft_slot: 2,
      pick_no: 2,
      metadata: { first_name: "Ja'Marr", last_name: "Chase", position: "WR" },
      is_keeper: false,
    },
  ],
  "/v1/players/nfl?active=true": {
    "1001": {
      player_id: "1001",
      sport: "nfl",
      first_name: "Bijan",
      last_name: "Robinson",
      full_name: "Bijan Robinson",
      search_full_name: "bijanrobinson",
      position: "RB",
      fantasy_positions: ["RB"],
      team: "ATL",
      number: 7,
      status: "Active",
      injury_status: null,
      age: 24,
      height: "5'11\"",
      weight: "215",
      college: "Texas",
      years_exp: 3,
    },
    "1002": {
      player_id: "1002",
      sport: "nfl",
      first_name: "Christian",
      last_name: "McCaffrey",
      position: "RB",
      fantasy_positions: ["RB"],
      team: "SF",
      status: "Active",
      injury_status: "Questionable",
    },
    "1003": {
      player_id: "1003",
      sport: "nfl",
      first_name: "Ja'Marr",
      last_name: "Chase",
      position: "WR",
      fantasy_positions: ["WR"],
      team: "CIN",
      status: "Active",
    },
    BUF: {
      player_id: "BUF",
      sport: "nfl",
      first_name: null,
      last_name: null,
      position: "DEF",
      fantasy_positions: ["DEF"],
      team: "BUF",
      status: "Active",
    },
  },
};

describe("Sleeper league import", () => {
  it("rejects overlapping imports while the D1 lock is active", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sync_locks (key, token, locked_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind("sleeper:league-imports", "other-import", now, now + 60_000).run();
    const db = drizzle(env.DB, { schema });

    await expect(
      importSleeperLeague(db, new SleeperClient("https://unused.test/v1"), externalLeagueId),
    ).rejects.toBeInstanceOf(ImportInProgressError);
    await env.DB.prepare("DELETE FROM sync_locks WHERE key = ?")
      .bind("sleeper:league-imports")
      .run();
  });

  it("is idempotent and preserves canonical identity", async () => {
    let playerCatalogCalls = 0;
    const fixtureFetch = async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (`${url.pathname}${url.search}` === "/v1/players/nfl?active=true") {
        playerCatalogCalls += 1;
      }
      const fixture = fixtures[`${url.pathname}${url.search}`];
      return fixture === undefined
        ? new Response(JSON.stringify({ error: "fixture missing" }), { status: 404 })
        : Response.json(fixture);
    };
    const client = new SleeperClient("https://fixtures.test/v1", fixtureFetch as typeof fetch);
    const db = drizzle(env.DB, { schema });

    const first = await importSleeperLeague(db, client, externalLeagueId);
    const second = await importSleeperLeague(db, client, externalLeagueId);

    expect(second.leagueId).toBe(first.leagueId);
    expect(second.counts).toEqual(first.counts);
    expect(playerCatalogCalls).toBe(1);

    const tableCounts = await Promise.all(
      [
        "leagues",
        "league_members",
        "teams",
        "rosters",
        "players",
        "player_external_ids",
        "roster_players",
        "scoring_settings",
        "drafts",
        "draft_picks",
        "provider_syncs",
      ].map(async (table) => {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
        return [table, row?.count ?? -1] as const;
      }),
    );

    expect(Object.fromEntries(tableCounts)).toEqual({
      leagues: 1,
      league_members: 2,
      teams: 2,
      rosters: 2,
      players: 4,
      player_external_ids: 4,
      roster_players: 4,
      scoring_settings: 2,
      drafts: 1,
      draft_picks: 2,
      provider_syncs: 3,
    });

    const ppr = await env.DB.prepare(
      "SELECT value FROM scoring_settings WHERE league_id = ? AND key = 'rec'",
    )
      .bind(first.leagueId)
      .first<{ value: number }>();
    expect(ppr?.value).toBe(1);

    const failedSyncs = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_syncs WHERE status != 'succeeded'",
    ).first<{ count: number }>();
    expect(failedSyncs?.count).toBe(0);
  });

  it("imports a full-size league without exceeding D1 statement or parameter limits", async () => {
    const largeLeagueId = "987654321098765432";
    const users = Array.from({ length: 12 }, (_, index) => ({
      user_id: `large-user-${index + 1}`,
      username: `coach_${index + 1}`,
      display_name: `Coach ${index + 1}`,
      avatar: null,
      is_owner: index === 0,
      metadata: { team_name: `Potato Team ${index + 1}` },
    }));
    const activePlayers = Object.fromEntries(
      Array.from({ length: 240 }, (_, index) => {
        const playerId = `large-player-${index + 1}`;
        return [playerId, {
          player_id: playerId,
          sport: "nfl",
          first_name: `Player`,
          last_name: `${index + 1}`,
          full_name: `Player ${index + 1}`,
          position: index % 3 === 0 ? "RB" : index % 3 === 1 ? "WR" : "TE",
          fantasy_positions: [index % 3 === 0 ? "RB" : index % 3 === 1 ? "WR" : "TE"],
          team: "CHI",
          status: "Active",
        }];
      }),
    );
    const largeRosters = users.map((user, rosterIndex) => {
      const playerIds = Array.from(
        { length: 20 },
        (_, playerIndex) => `large-player-${rosterIndex * 20 + playerIndex + 1}`,
      );
      return {
        roster_id: rosterIndex + 1,
        league_id: largeLeagueId,
        owner_id: user.user_id,
        players: playerIds,
        starters: playerIds.slice(0, 10),
        reserve: playerIds.slice(10, 12),
        taxi: [],
        settings: { wins: 0, losses: 0 },
      };
    });
    const draftPicks: SleeperDraftPick[] = Array.from({ length: 180 }, (_, index) => ({
      draft_id: "large-draft",
      player_id: `large-player-${index + 1}`,
      picked_by: users[index % 12].user_id,
      roster_id: (index % 12) + 1,
      round: Math.floor(index / 12) + 1,
      draft_slot: (index % 12) + 1,
      pick_no: index + 1,
      metadata: { first_name: "Player", last_name: `${index + 1}` },
      is_keeper: false,
    }));
    draftPicks.push({
      draft_id: "large-draft",
      player_id: "retired-player",
      picked_by: users[0].user_id,
      roster_id: 1,
      round: 16,
      draft_slot: 1,
      pick_no: 181,
      metadata: { first_name: "Retired", last_name: "Legend", position: "RB", team: "CHI" },
      is_keeper: false,
    });
    const largeFixtures: Record<string, unknown> = {
      [`/v1/league/${largeLeagueId}`]: {
        league_id: largeLeagueId,
        name: "Large Potato League",
        sport: "nfl",
        season: "2026",
        season_type: "regular",
        status: "pre_draft",
        roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DEF", "BN"],
        scoring_settings: Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [`score_${index + 1}`, index / 2]),
        ),
        settings: { num_teams: 12 },
      },
      [`/v1/league/${largeLeagueId}/users`]: users,
      [`/v1/league/${largeLeagueId}/rosters`]: largeRosters,
      [`/v1/league/${largeLeagueId}/drafts`]: [{
        draft_id: "large-draft",
        league_id: largeLeagueId,
        type: "snake",
        status: "complete",
        season: "2026",
        season_type: "regular",
        start_time: 1788120000000,
        settings: { teams: 12, rounds: 16 },
        metadata: { name: "Large draft" },
      }],
      "/v1/draft/large-draft/picks": draftPicks,
      "/v1/players/nfl?active=true": activePlayers,
    };
    const fixtureFetch = async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const fixture = largeFixtures[`${url.pathname}${url.search}`];
      return fixture === undefined
        ? new Response(JSON.stringify({ error: "fixture missing" }), { status: 404 })
        : Response.json(fixture);
    };
    const db = drizzle(env.DB, { schema });
    const result = await importSleeperLeague(
      db,
      new SleeperClient("https://fixtures.test/v1", fixtureFetch as typeof fetch),
      largeLeagueId,
    );

    expect(result.counts).toMatchObject({
      members: 12,
      rosters: 12,
      rosterPlayers: 240,
      scoringSettings: 30,
      draftPicks: 181,
      canonicalPlayers: 241,
    });
    const retiredPlayer = await env.DB.prepare(
      `SELECT p.full_name AS fullName
       FROM players p
       JOIN player_external_ids e ON e.player_id = p.id
       WHERE e.provider = 'sleeper' AND e.external_id = 'retired-player'`,
    ).first<{ fullName: string }>();
    expect(retiredPlayer?.fullName).toBe("Retired Legend");
  });
});
