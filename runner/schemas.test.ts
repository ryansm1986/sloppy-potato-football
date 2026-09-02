import { describe, expect, it } from "vitest";
import { researchJobSchema, researchResultSchema } from "./schemas.js";

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
    expect(researchResultSchema.safeParse({
      ...baseResult,
      rankingSnapshots: [
        source("FantasyPros", "https://rankings.fantasypros.com/nfl/ppr"),
        source("FantasyPros Staff", "https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php"),
        source("CBS Sports", "https://www.cbssports.com/fantasy/football/rankings/"),
      ],
    }).success).toBe(false);
    expect(researchResultSchema.safeParse({
      ...baseResult,
      rankingSnapshots: [
        source("FantasyPros", "ftp://fantasypros.com/rankings"),
        source("RotoWire", "https://www.rotowire.com/football/rankings.php"),
        source("CBS Sports", "https://www.cbssports.com/fantasy/football/rankings/"),
      ],
    }).success).toBe(false);
  });
});

describe("league-size validation", () => {
  const claimed = {
    id: "13cb54a1-85eb-4e7e-bfb5-cc25cf712b7e",
    type: "player_research",
    input: {
      type: "player_research",
      subject: "Bijan Robinson",
      scoringFormat: "ppr",
      rankingType: "redraft",
      position: "RB",
    },
    attempt: 1,
    maxAttempts: 3,
    leaseToken: "f1f2d93e-50c6-41a9-a108-6c9ed8d12845",
    leaseExpiresAt: "2026-09-01T22:00:00.000Z",
    executionContext: "Research the named player.",
  };

  it("defaults legacy claimed jobs to 12 teams and accepts supported sizes", () => {
    expect(researchJobSchema.parse(claimed).input.leagueSize).toBe(12);
    for (const leagueSize of [8, 10, 12, 14, 16]) {
      expect(researchJobSchema.parse({
        ...claimed,
        input: { ...claimed.input, leagueSize },
      }).input.leagueSize).toBe(leagueSize);
    }
  });

  it("rejects unsupported job and ranking-result league sizes", () => {
    expect(researchJobSchema.safeParse({
      ...claimed,
      input: { ...claimed.input, leagueSize: 11 },
    }).success).toBe(false);
    expect(researchResultSchema.safeParse({
      ...baseResult,
      rankingSnapshots: [
        { ...source("FantasyPros", "https://fantasypros.com/rankings"), leagueSize: 11 },
        source("RotoWire", "https://rotowire.com/football/rankings"),
        source("CBS Sports", "https://cbssports.com/fantasy/football/rankings"),
      ],
    }).success).toBe(false);
  });
});

describe("sleeper research result", () => {
  it("accepts only a bounded canonical-domain snapshot on claimed discovery jobs", () => {
    const claimed = {
      id: "13cb54a1-85eb-4e7e-bfb5-cc25cf712b7e",
      type: "sleepers_research",
      input: {
        type: "sleepers_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "ALL",
        discoverNewSources: true,
        knownSourceDomains: ["fantasypros.com", "espn.com"],
      },
      attempt: 1,
      maxAttempts: 3,
      leaseToken: "f1f2d93e-50c6-41a9-a108-6c9ed8d12845",
      leaseExpiresAt: "2026-09-01T22:00:00.000Z",
      executionContext: "Research current sleeper sources.",
    };

    expect(researchJobSchema.parse(claimed).input.knownSourceDomains).toEqual(["fantasypros.com", "espn.com"]);
    expect(researchJobSchema.safeParse({
      ...claimed,
      input: { ...claimed.input, knownSourceDomains: ["https://fantasypros.com/path"] },
    }).success).toBe(false);
  });

  it("accepts only HTTP(S) source hyperlinks", () => {
    const candidate = (position: "QB" | "RB" | "WR" | "TE", url: string) => ({
      playerName: `${position} Sleeper`,
      position,
      team: "BUF",
      recommendedPickStart: 100,
      recommendedPickEnd: 112,
      summary: "A current value case.",
      upside: null,
      risk: null,
      sources: [{
        publisher: "Publisher",
        title: "Current sleepers",
        url,
        publishedAt: null,
        recommendation: "Recommended as a sleeper.",
      }],
    });
    const sleeperResult = (url: string) => ({
      ...baseResult,
      rankingSnapshots: null,
      sleeperReport: {
        summary: "A current sleeper report.",
        positionSummaries: { QB: "QB values.", RB: "RB values.", WR: "WR values.", TE: "TE values." },
        candidates: (["QB", "RB", "WR", "TE"] as const).map((position) => candidate(position, url)),
      },
    });

    expect(researchResultSchema.safeParse(sleeperResult("https://example.com/sleepers")).success).toBe(true);
    expect(researchResultSchema.safeParse(sleeperResult("ftp://example.com/sleepers")).success).toBe(false);
  });
});
