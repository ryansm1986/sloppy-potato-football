import { describe, expect, it } from "vitest";
import { derivePositionRanks } from "./ranking-position";

describe("derivePositionRanks", () => {
  const board = [
    { id: "rb-1", position: "RB" },
    { id: "wr-1", position: "WR" },
    { id: "qb-1", position: "QB" },
    { id: "wr-2", position: "WR" },
    { id: "qb-2", position: "qb" },
    { id: "unknown", position: null },
  ];

  it("derives each position rank from the complete board order", () => {
    const ranks = derivePositionRanks(board, (entry) => entry.id, (entry) => entry.position);

    expect(ranks.get("wr-2")).toEqual({ position: "WR", rank: 2 });
    expect(ranks.get("qb-2")).toEqual({ position: "QB", rank: 2 });
    expect(ranks.has("unknown")).toBe(false);
  });

  it("keeps ranks stable when consumers filter or limit the board afterward", () => {
    const ranks = derivePositionRanks(board, (entry) => entry.id, (entry) => entry.position);
    const filteredAndLimited = board.filter((entry) => entry.position?.toUpperCase() === "QB").slice(1, 2);

    expect(filteredAndLimited[0]?.id).toBe("qb-2");
    expect(ranks.get(filteredAndLimited[0]!.id)?.rank).toBe(2);
  });
});
