import { describe, expect, it, vi } from "vitest";
import { RunnerApiClient } from "./api-client.js";
import type { RunnerConfig } from "./config.js";

const config: RunnerConfig = {
  apiUrl: "https://example.test",
  token: "r".repeat(48),
  runnerId: "codex-test",
  runnerName: "Test runner",
  workspace: "C:\\temp\\runner",
  pollIntervalMs: 15_000,
  jobTimeoutMs: 240_000,
  httpTimeoutMs: 5_000,
};

describe("RunnerApiClient", () => {
  it("sends a scoped bearer token and exact heartbeat capabilities", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new RunnerApiClient(config, fetchMock);
    await client.heartbeat("idle");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/api/runners/heartbeat");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      runnerId: "codex-test",
      provider: "codex",
      status: "idle",
      capabilities: ["source_refresh", "player_research", "rankings_research"],
    });
  });

  it("parses a claimed job and never contacts a real network", async () => {
    const response = {
      job: {
        id: "job-123",
        type: "rankings_research",
        input: { type: "rankings_research", scoringFormat: "ppr", rankingType: "redraft", position: "ALL" },
        attempt: 1,
        maxAttempts: 3,
        leaseToken: "f1f2d93e-50c6-41a9-a108-6c9ed8d12845",
        leaseExpiresAt: "2026-09-01T22:00:00.000Z",
        executionContext: "Research a current fantasy-football ranking board.",
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const job = await new RunnerApiClient(config, fetchMock).claim();
    expect(job?.type).toBe("rankings_research");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
