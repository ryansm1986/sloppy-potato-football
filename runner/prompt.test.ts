import { describe, expect, it } from "vitest";
import { buildResearchPrompt } from "./prompt.js";
import type { ResearchJob } from "./schemas.js";

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
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(prompt).not.toContain(job.leaseToken);
  });

  it("removes control characters", () => {
    const prompt = buildResearchPrompt({ ...job, executionContext: "Research\u0000 safely\nnow" });
    expect(prompt).toContain("Research safely now");
    expect(prompt).not.toContain("\u0000");
  });
});
