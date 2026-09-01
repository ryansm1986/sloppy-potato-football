import { describe, expect, it } from "vitest";
import { researchResultSchema } from "./schemas.js";

function source(sourceName: string, sourceUrl: string) {
  return {
    sourceName,
    sourceUrl,
    title: `${sourceName} PPR rankings`,
    scoringFormat: "ppr" as const,
    rankingType: "redraft" as const,
    season: "2026",
    week: null,
    summary: null,
    methodology: null,
    entries: [
      { playerName: "Bijan Robinson", position: "RB", team: "ATL", rank: 1, previousRank: null, tier: 1, insight: null },
      { playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 2, previousRank: null, tier: 1, insight: null },
    ],
  };
}

const baseResult = {
  summary: "Three current published boards were collected.",
  generatedAt: "2026-09-01T22:00:00.000Z",
  citations: [],
  insights: [],
  rankingSnapshot: null,
};

describe("multi-source research result", () => {
  it("accepts three separately attributed ranking boards", () => {
    const result = researchResultSchema.parse({
      ...baseResult,
      rankingSnapshots: [
        source("FantasyPros", "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"),
        source("RotoWire", "https://www.rotowire.com/football/rankings.php"),
        source("CBS Sports", "https://www.cbssports.com/fantasy/football/rankings/"),
      ],
    });
    expect(result.rankingSnapshots).toHaveLength(3);
  });

  it("rejects fewer than three sources and duplicate publisher domains", () => {
    expect(researchResultSchema.safeParse({
      ...baseResult,
      rankingSnapshots: [
        source("FantasyPros", "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"),
        source("CBS Sports", "https://www.cbssports.com/fantasy/football/rankings/"),
      ],
    }).success).toBe(false);
    expect(researchResultSchema.safeParse({
      ...baseResult,
      rankingSnapshots: [
        source("FantasyPros", "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"),
        source("FantasyPros Staff", "https://fantasypros.com/nfl/rankings/consensus-cheatsheets.php"),
        source("CBS Sports", "https://www.cbssports.com/fantasy/football/rankings/"),
      ],
    }).success).toBe(false);
  });
});
