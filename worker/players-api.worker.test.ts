import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "./index";

describe("player catalog API", () => {
  it("protects catalog synchronization with the research-owner credential", async () => {
    const unconfigured = await app.request(
      "https://potato.example/api/players/sync",
      { method: "POST" },
      { DB: env.DB },
    );
    expect(unconfigured.status).toBe(503);

    const unauthorized = await app.request(
      "https://potato.example/api/players/sync",
      { method: "POST", headers: { "X-Research-Owner-Token": "wrong" } },
      { DB: env.DB, RESEARCH_OWNER_TOKEN: "owner-secret" },
    );
    expect(unauthorized.status).toBe(401);
  });

  it("returns fantasy-only players with stable cursor pagination and a safe large limit", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const rows = [
      { id: `a-${suffix}`, name: `PageTest ${suffix} Alpha`, search: `pagetest${suffix}alpha`, position: "QB", team: "ATL", defense: 0, sport: "nfl" },
      { id: `b-${suffix}`, name: `PageTest ${suffix} Bravo`, search: `pagetest${suffix}bravo`, position: "RB", team: "BUF", defense: 0, sport: "nfl" },
      { id: `c-${suffix}`, name: `PageTest ${suffix} Duplicate`, search: `pagetest${suffix}duplicate`, position: "WR", team: "CHI", defense: 0, sport: "nfl" },
      { id: `d-${suffix}`, name: `PageTest ${suffix} Duplicate`, search: `pagetest${suffix}duplicate`, position: "TE", team: "DAL", defense: 0, sport: "nfl" },
      { id: `e-${suffix}`, name: `PageTest ${suffix} Defense`, search: `pagetest${suffix}defense`, position: "DEF", team: "DEN", defense: 1, sport: "nfl" },
      { id: `f-${suffix}`, name: `PageTest ${suffix} Free agent`, search: `pagetest${suffix}freeagent`, position: "WR", team: null, defense: 0, sport: "nfl" },
      { id: `g-${suffix}`, name: `PageTest ${suffix} Lineman`, search: `pagetest${suffix}lineman`, position: "OL", team: "GB", defense: 0, sport: "nfl" },
      { id: `h-${suffix}`, name: `PageTest ${suffix} Baseball`, search: `pagetest${suffix}baseball`, position: "K", team: "TB", defense: 0, sport: "mlb" },
    ];
    await env.DB.prepare(
      `INSERT INTO players
       (id, sport, full_name, search_name, position, fantasy_positions_json, nfl_team, is_team_defense)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.sport'),
              json_extract(value, '$.name'), json_extract(value, '$.search'),
              json_extract(value, '$.position'), '[]', json_extract(value, '$.team'),
              json_extract(value, '$.defense')
       FROM json_each(?)`,
    ).bind(JSON.stringify(rows)).run();

    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL("https://potato.example/api/players");
      url.searchParams.set("query", `PageTest ${suffix}`);
      url.searchParams.set("fantasy", "true");
      url.searchParams.set("limit", "2");
      if (cursor) url.searchParams.set("after", cursor);
      const response = await app.request(url.toString(), undefined, { DB: env.DB });
      expect(response.status).toBe(200);
      const body = await response.json<{
        players: Array<{ id: string }>;
        nextCursor: string | null;
        pagination: { hasMore: boolean; limit: number };
      }>();
      found.push(...body.players.map((player) => player.id));
      cursor = body.nextCursor;
    } while (cursor);

    expect(found).toEqual([
      `a-${suffix}`,
      `b-${suffix}`,
      `e-${suffix}`,
      `c-${suffix}`,
      `d-${suffix}`,
    ]);
    expect(new Set(found).size).toBe(found.length);

    const capped = await app.request(
      `https://potato.example/api/players?query=PageTest%20${suffix}&limit=5000`,
      undefined,
      { DB: env.DB },
    );
    const cappedBody = await capped.json<{ pagination: { limit: number } }>();
    expect(cappedBody.pagination.limit).toBe(500);

    const invalid = await app.request(
      "https://potato.example/api/players?cursor=not-a-cursor",
      undefined,
      { DB: env.DB },
    );
    expect(invalid.status).toBe(400);
  });
});
