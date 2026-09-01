import { describe, expect, it } from "vitest";
import {
  PERSONAL_RANKINGS_STORAGE_KEY,
  applyAgentOrder,
  loadPersonalRankings,
  moveRanking,
  reorderRankings,
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
});
