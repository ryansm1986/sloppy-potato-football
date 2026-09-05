import { describe, expect, it } from "vitest";
import { buildResearchPrompt } from "./prompt.js";
import { researchJobSchema, type ResearchJob } from "./schemas.js";

const job: ResearchJob = {
  id: "13cb54a1-85eb-4e7e-bfb5-cc25cf712b7e",
  type: "player_research",
  input: {
    type: "player_research",
    subject: "Justin Jefferson",
    scoringFormat: "ppr",
    rankingType: "redraft",
    position: "WR",
    season: "2026",
    leagueSize: 12,
  },
  attempt: 1,
  maxAttempts: 3,
  leaseToken: "f1f2d93e-50c6-41a9-a108-6c9ed8d12845",
  leaseExpiresAt: "2026-09-01T22:00:00.000Z",
  executionContext: "Research the named player for current role, risk, and ranking implications.",
};

describe("buildResearchPrompt", () => {
  it("uses only bounded server-validated assignment fields", () => {
    const prompt = buildResearchPrompt(job);
    expect(prompt).toContain("BEGIN SERVER-VALIDATED ASSIGNMENT DATA");
    expect(prompt).toContain("Justin Jefferson");
    expect(prompt).toContain("Do not run repository code");
    expect(prompt).toContain("League size: 12-team league");
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(prompt).not.toContain(job.leaseToken);
  });

  it("removes control characters", () => {
    const prompt = buildResearchPrompt({ ...job, executionContext: "Research\u0000 safely\nnow" });
    expect(prompt).toContain("Research safely now");
    expect(prompt).not.toContain("\u0000");
  });

  it("preserves essential Top 500 assignment fields at maximum valid input lengths", () => {
    const target = " Source target: aim for 10 independent publisher domains.";
    const executionContext = "t".repeat(2_000 - target.length) + target;
    const knownSourceDomains = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}${"a".repeat(57)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.com`);
    const prompt = buildResearchPrompt(researchJobSchema.parse({
      ...job,
      type: "rankings_research",
      input: {
        type: "rankings_research", subject: "s".repeat(200), sourceName: "n".repeat(200),
        scoringFormat: "half_ppr", rankingType: "rest_of_season", position: "ALL", season: "2026", week: 25,
        rankingLimit: 500, leagueSize: 16, discoverNewSources: true, knownSourceDomains,
      },
      executionContext,
    }));

    expect(prompt).toContain(`Task: ${executionContext}`);
    expect(prompt).toContain(`Subject: ${"s".repeat(200)}`);
    expect(prompt).toContain(`Source: ${"n".repeat(200)}`);
    expect(prompt).toContain("Scope: half_ppr; rest_of_season; ALL; season 2026; week 25");
    expect(prompt).toContain("League size: 16-team league");
    expect(prompt).toContain("Ranking source discovery: enabled");
    expect(prompt).toContain("requested Top 500");
    expect(prompt).toContain("exactly 500 contiguous entries");
    expect(prompt).toContain("Partial snapshot");
    expect(prompt).toContain("compact JSON and concise optional insights");
    expect(prompt).toContain("Never omit required properties or fabricate entries to fit");
    expect(prompt).toContain("Do not run repository code");
    expect(prompt.endsWith("END SERVER-VALIDATED ASSIGNMENT DATA")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  it("includes the validated requested ranking count", () => {
    const prompt = buildResearchPrompt({
      ...job,
      type: "rankings_research",
      input: {
        type: "rankings_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "ALL",
        season: "2026",
        rankingLimit: 200,
        leagueSize: 14,
      },
      executionContext: "Return the requested Top 200 fantasy-football rankings.",
    });

    expect(prompt).toContain("requested Top 200");
    expect(prompt).toContain("exactly 200 contiguous entries");
    expect(prompt).toContain("3 to 10 separately attributed published boards");
    expect(prompt).toContain("distinct reputable publishers with distinct domains");
    expect(prompt).toContain("ALL never means a quarterback-only list");
    expect(prompt).toContain("app computes the aggregate");
    expect(prompt).toContain("League size: 14-team league");
    expect(prompt).toContain("never adjust its ranks for league size");
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  it("directs an enabled rankings run to scout outside the server domain snapshot", () => {
    const prompt = buildResearchPrompt({
      ...job,
      type: "rankings_research",
      input: {
        type: "rankings_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "ALL",
        season: "2026",
        rankingLimit: 100,
        leagueSize: 10,
        discoverNewSources: true,
        knownSourceDomains: ["fantasypros.com", "espn.com"],
      },
      executionContext: "Scout ranking publishers beyond the known source set.",
    });

    expect(prompt).toContain("Ranking source discovery: enabled");
    expect(prompt).toContain("fantasypros.com, espn.com");
    expect(prompt).toContain("at least two credible current-season ranking publisher domains");
    expect(prompt).toContain("strongest established sources instead");
  });

  it.each(["rankings_research", "sleepers_research"] as const)("uses the server source target for %s without requiring a new input field", (type) => {
    const prompt = buildResearchPrompt({
      ...job,
      type,
      input: { ...job.input, type, position: "ALL" },
      executionContext: "Research current evidence. Source target: aim for 10 independent publisher domains.",
    });

    expect(prompt).toContain("Task: Research current evidence. Source target: aim for 10 independent publisher domains.");
    expect(prompt).toContain("aim for the server-validated source target in Task (default 3)");
    expect(prompt).toContain("across the whole report, not per player or position");
    expect(prompt).toContain("return fewer if unavailable, explain the shortfall");
    expect(prompt).toContain("If fewer than 3 qualifying published sources can be verified, return no ranking boards");
    expect(prompt).toContain("Do not bypass paywalls");
    expect(prompt).toContain("Do not run repository code");
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  it("bounds sleeper research and leaves ranking and round derivation to the server", () => {
    const prompt = buildResearchPrompt({
      ...job,
      type: "sleepers_research",
      input: {
        type: "sleepers_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "ALL",
        season: "2026",
        leagueSize: 12,
        sleepersPerPosition: 8,
      },
      executionContext: "Research PPR redraft sleepers across QB, RB, WR, and TE.",
    });

    expect(prompt).toContain("up to 8 candidates per position");
    expect(prompt).toContain("at least three independent reputable publisher domains");
    expect(prompt).toContain("OVERALL draft pick");
    expect(prompt).toContain("server derives them");
  });

  it("directs an enabled sleeper run to scout outside the server domain snapshot", () => {
    const prompt = buildResearchPrompt({
      ...job,
      type: "sleepers_research",
      input: {
        type: "sleepers_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "ALL",
        season: "2026",
        leagueSize: 12,
        sleepersPerPosition: 8,
        discoverNewSources: true,
        knownSourceDomains: ["fantasypros.com", "espn.com"],
      },
      executionContext: "Scout for sleeper recommendations beyond the known publisher set.",
    });

    expect(prompt).toContain("Sleeper source discovery: enabled");
    expect(prompt).toContain("fantasypros.com, espn.com");
    expect(prompt).toContain("at least two credible current-season publisher domains");
    expect(prompt).toContain("strongest established sources instead");
  });
});
