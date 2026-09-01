import { EventEmitter } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerApiClient } from "./api-client.js";
import type { RunnerConfig } from "./config.js";
import type { SpawnImplementation } from "./codex.js";
import { runOneJob } from "./runner.js";
import type { ResearchJob } from "./schemas.js";

const workspace = join(tmpdir(), `sloppy-potato-runner-test-${process.pid}`);
const config: RunnerConfig = {
  apiUrl: "https://example.test",
  token: "runner-secret-that-must-not-reach-codex".padEnd(48, "x"),
  runnerId: "codex-test",
  runnerName: "Test runner",
  workspace,
  pollIntervalMs: 15_000,
  jobTimeoutMs: 30_000,
  httpTimeoutMs: 5_000,
};
const job: ResearchJob = {
  id: "job-123",
  type: "player_research",
  input: { type: "player_research", subject: "Justin Jefferson", scoringFormat: "ppr", rankingType: "redraft", position: "WR" },
  attempt: 1,
  maxAttempts: 3,
  leaseToken: "f1f2d93e-50c6-41a9-a108-6c9ed8d12845",
  leaseExpiresAt: "2026-09-01T22:00:00.000Z",
  executionContext: "Research the named player with citations.",
};
const validResult = {
  summary: "Current evidence supports a first-round PPR valuation.",
  generatedAt: "2026-09-01T21:00:00.000Z",
  citations: [],
  insights: [{ subject: "Justin Jefferson", finding: "Remains an elite target earner.", confidence: "high", citationUrls: [] }],
  rankingSnapshot: null,
};

function fakeSpawn(output: unknown): { implementation: SpawnImplementation; calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const implementation: SpawnImplementation = (_command, args, options) => {
    calls.push({ args, env: options.env ?? {} });
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    child.stdin.once("finish", () => {
      const outputIndex = args.indexOf("-o");
      void writeFile(args[outputIndex + 1]!, JSON.stringify(output), "utf8")
        .then(() => child.emit("close", 0));
    });
    return child as ChildProcessWithoutNullStreams;
  };
  return { implementation, calls };
}

function fakeApi() {
  return {
    heartbeat: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(job),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  delete process.env.AGENT_RUNNER_TOKEN;
});

describe("local runner", () => {
  it("spawns only bounded Codex exec arguments and completes a valid job", async () => {
    process.env.AGENT_RUNNER_TOKEN = "must-not-be-in-child-environment";
    const api = fakeApi();
    const spawned = fakeSpawn(validResult);
    await expect(runOneJob(config, {
      api: api as unknown as RunnerApiClient,
      spawn: spawned.implementation,
      log: vi.fn(),
    })).resolves.toBe(true);
    expect(spawned.calls[0]?.args).toEqual(expect.arrayContaining([
      "--search", "--ignore-user-config", "--ignore-rules", "exec", "--sandbox", "read-only",
      "--ephemeral", "--skip-git-repo-check", "--output-schema",
    ]));
    expect(spawned.calls[0]?.env.AGENT_RUNNER_TOKEN).toBeUndefined();
    expect(api.complete).toHaveBeenCalledWith(job.id, job.leaseToken, expect.objectContaining({ summary: validResult.summary }));
    expect(api.fail).not.toHaveBeenCalled();
  });

  it("reports schema-invalid Codex output as a retryable failure", async () => {
    const api = fakeApi();
    const spawned = fakeSpawn({ summary: "missing required fields" });
    await runOneJob(config, {
      api: api as unknown as RunnerApiClient,
      spawn: spawned.implementation,
      log: vi.fn(),
    });
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(job.id, job.leaseToken, expect.objectContaining({
      code: "INVALID_RESULT",
      retryable: true,
    }));
  });
});
