import { afterEach, describe, expect, it, vi } from "vitest";
import { SleeperClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SleeperClient", () => {
  it("normalizes malformed JSON into an invalid_response error", async () => {
    const invalidJsonFetch = (async () =>
      new Response("not-json", { status: 200 })) as typeof fetch;
    const client = new SleeperClient(
      "https://fixtures.test/v1",
      invalidJsonFetch,
    );

    await expect(client.getLeague("12345")).rejects.toMatchObject({
      name: "SleeperApiError",
      code: "invalid_response",
    });
  });

  it("calls the global fetch through a Cloudflare-safe wrapper by default", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      league_id: "12345",
      name: "Fixture League",
      sport: "nfl",
      season: "2026",
      season_type: "regular",
      status: "in_season",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SleeperClient("https://fixtures.test/v1");
    await client.getLeague("12345");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://fixtures.test/v1/league/12345",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});
