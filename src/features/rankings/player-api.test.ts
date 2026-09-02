import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFantasyPlayerCatalog } from "./player-api";

describe("fantasy player catalog API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads every page and de-duplicates canonical players", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("cursor=next-page")) return Response.json({
        players: [player("one", "Player One"), player("duplicate", "Player Duplicate")],
        nextCursor: "next-page",
      });
      return Response.json({
        players: [player("duplicate", "Player Duplicate"), player("two", "Player Two")],
        nextCursor: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFantasyPlayerCatalog()).resolves.toEqual([
      expect.objectContaining({ id: "one" }),
      expect.objectContaining({ id: "duplicate" }),
      expect.objectContaining({ id: "two" }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/players?fantasy=true&limit=500", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/players?fantasy=true&limit=500&cursor=next-page", expect.any(Object));
  });

  it("rejects failed, malformed, and cyclic responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(fetchFantasyPlayerCatalog()).rejects.toThrow("Player catalog returned 503");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ snapshots: [] })));
    await expect(fetchFantasyPlayerCatalog()).rejects.toThrow("invalid response");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ players: [], nextCursor: "same" })));
    await expect(fetchFantasyPlayerCatalog()).rejects.toThrow("repeated pagination cursor");
  });
});

function player(id: string, fullName: string) {
  return {
    id,
    sport: "nfl",
    fullName,
    searchName: fullName.toLowerCase().replaceAll(" ", ""),
    position: "WR",
    fantasyPositions: ["WR"],
    nflTeam: "CHI",
    status: "Active",
    injuryStatus: null,
    isTeamDefense: false,
  };
}
