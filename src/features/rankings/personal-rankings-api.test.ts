import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCloudPersonalRankings, saveCloudPersonalRankings } from "./personal-rankings-api";

afterEach(() => vi.unstubAllGlobals());

describe("personal rankings cloud API", () => {
  it("loads the current PPR redraft board with owner authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ board: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudPersonalRankings("owner-secret", "2026")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/research/personal-rankings?season=2026&scoringFormat=ppr&rankingType=redraft",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-secret" }) }),
    );
  });

  it("saves only an ordered player-id payload with optimistic revision metadata", async () => {
    const result = {
      board: { id: "board-1", revision: 4, name: "My Rankings", season: "2026", updatedAt: new Date(0).toISOString(), entries: [] },
      savedCount: 2,
      ignoredPlayerIds: [],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveCloudPersonalRankings("owner-secret", ["player-1", "player-2"], {
      revision: 3,
      season: "2026",
      leagueSize: 12,
    })).resolves.toEqual(result);

    const [, request] = fetchMock.mock.calls[0];
    expect(request).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(String(request?.body))).toEqual({
      playerIds: ["player-1", "player-2"],
      expectedRevision: 3,
      season: "2026",
      scoringFormat: "ppr",
      rankingType: "redraft",
      leagueSize: 12,
    });
  });

  it("surfaces server conflicts without leaking the credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "revision_conflict", message: "This board changed on another device." },
      { status: 409 },
    )));

    await expect(saveCloudPersonalRankings("owner-secret", ["player-1"], { revision: 1 }))
      .rejects.toMatchObject({ name: "ResearchApiError", status: 409, message: "This board changed on another device." });
  });
});
