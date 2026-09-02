import { describe, expect, it } from "vitest";
import {
  PERSONAL_RANKINGS_STORAGE_KEY,
  applyAgentOrder,
  hydratePersonalRankings,
  loadPersonalRankings,
  loadSavedPersonalRankings,
  moveRanking,
  moveRankingTo,
  reorderRankings,
  resetPersonalRankings,
  savePersonalRankings,
  starterRankings,
} from "./ranking-store";

describe("personal ranking store", () => {
  it("reorders by stable player ID", () => {
    const next = reorderRankings(starterRankings, starterRankings[0].id, starterRankings[2].id);
    expect(next.slice(0, 3).map((player) => player.id)).toEqual([
      starterRankings[1].id,
      starterRankings[2].id,
      starterRankings[0].id,
    ]);
    expect(moveRanking(next, starterRankings[0].id, "up")[1].id).toBe(starterRankings[0].id);
    expect(moveRankingTo(starterRankings, starterRankings[11].id, 2).slice(0, 3).map((player) => player.id)).toEqual([
      starterRankings[0].id,
      starterRankings[11].id,
      starterRankings[1].id,
    ]);
    expect(moveRankingTo(starterRankings, starterRankings[0].id, 999).at(-1)?.id).toBe(starterRankings[0].id);
    expect(moveRankingTo(starterRankings, starterRankings[11].id, -10)[0].id).toBe(starterRankings[11].id);
  });

  it("distinguishes a first-time board from a saved board", () => {
    expect(loadSavedPersonalRankings({ getItem: () => null })).toBeNull();
    expect(loadPersonalRankings({ getItem: () => null })).toEqual(starterRankings);
  });

  it("saves and restores a personal order while appending new starter players", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const reversed = [...starterRankings].reverse();
    savePersonalRankings(storage, reversed);
    expect(values.has(PERSONAL_RANKINGS_STORAGE_KEY)).toBe(true);
    expect(loadPersonalRankings(storage).map((player) => player.id)).toEqual(reversed.map((player) => player.id));
  });

  it("keeps an agent-only player after a personal board is saved and reloaded", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const copied = applyAgentOrder(starterRankings, [
      { playerName: "New Receiver", position: "WR", team: "SEA", rank: 1 },
    ]);

    savePersonalRankings(storage, copied);

    expect(loadPersonalRankings(storage).map((player) => player.name)).toContain("New Receiver");
  });

  it("copies one agent position without changing the order of other positions", () => {
    const beforeNonReceivers = starterRankings.filter((player) => player.position !== "WR").map((player) => player.id);
    const next = applyAgentOrder(starterRankings, [
      { playerName: "Malik Nabers", position: "WR", team: "NYG", rank: 1 },
      { playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 2 },
      { playerName: "New Receiver", position: "WR", team: "SEA", rank: 3 },
    ], "WR");

    expect(next.filter((player) => player.position === "WR").slice(0, 3).map((player) => player.name)).toEqual([
      "Malik Nabers",
      "Ja'Marr Chase",
      "New Receiver",
    ]);
    expect(next.filter((player) => player.position !== "WR").map((player) => player.id)).toEqual(beforeNonReceivers);
  });

  it("reconciles saved demo and agent players to canonical IDs while keeping custom entries", () => {
    const catalog = [
      canonical("nfl-chase", "Ja'Marr Chase", "WR", "CIN"),
      canonical("nfl-bijan", "Bijan Robinson", "RB", "ATL"),
      canonical("nfl-new", "New Rookie", "WR", "SEA"),
    ];
    const saved = [
      { ...starterRankings[1], id: "jamar-chase" },
      { id: "agent:bijan-robinson", name: "Bijan Robinson", position: "RB", team: "ATL", consensusRank: 9, trend: 2 },
      { id: "custom-player", name: "My Deep Sleeper", position: "WR", team: "FA", consensusRank: 400, trend: 1 },
    ];
    const aggregate = [market("nfl-bijan", "Bijan Robinson", 1), market("nfl-chase", "Ja'Marr Chase", 2)];

    const hydrated = hydratePersonalRankings(saved, catalog, aggregate);

    expect(hydrated.map((player) => player.id)).toEqual([
      "nfl-chase",
      "nfl-bijan",
      "custom-player",
      "nfl-new",
    ]);
    expect(hydrated[0]).toMatchObject({ consensusRank: 2, team: "CIN" });
    expect(hydrated[2]).toMatchObject({ name: "My Deep Sleeper", consensusRank: null, trend: null });
    expect(hydrated[3]).toMatchObject({ consensusRank: null, trend: null });
  });

  it("seeds a first-time/reset board from aggregate order and then appends the catalog", () => {
    const catalog = [
      canonical("alpha", "Alpha Player", "RB", "ATL"),
      canonical("bravo", "Bravo Player", "WR", "BUF"),
      canonical("charlie", "Charlie Player", "QB", "CHI"),
    ];
    const aggregate = [market(null, "Bravo Player", 1), market("alpha", "Alpha Player", 2)];

    const hydrated = hydratePersonalRankings(null, catalog, aggregate);
    expect(hydrated.map((player) => player.id)).toEqual(["bravo", "alpha", "charlie"]);
    expect(hydrated.map((player) => player.consensusRank)).toEqual([1, 2, null]);
    expect(resetPersonalRankings(catalog, aggregate)).toEqual(hydrated);
  });

  it("normalizes team defenses to the DST position", () => {
    const defense = { ...canonical("den-defense", "Denver Broncos", "DEF", "DEN"), isTeamDefense: true };
    expect(hydratePersonalRankings(null, [defense])[0]).toMatchObject({ position: "DST", team: "DEN" });
  });
});

function canonical(id: string, fullName: string, position: string, nflTeam: string) {
  return {
    id,
    sport: "nfl",
    fullName,
    searchName: fullName.toLowerCase().replace(/[^a-z0-9]/g, ""),
    position,
    fantasyPositions: [position],
    nflTeam,
    status: "Active",
    injuryStatus: null,
    isTeamDefense: false,
  };
}

function market(playerId: string | null, playerName: string, rank: number) {
  return {
    id: `market-${rank}`,
    playerId,
    playerName,
    position: "WR",
    team: "NFL",
    rank,
    displayRank: rank,
    averageRank: rank,
    coverage: 2,
    sourceCount: 2,
    previousRank: null,
    tier: null,
    insight: null,
    sourceRanks: [],
  };
}
