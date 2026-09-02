import { EventEmitter } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerApiClient } from "./api-client.js";
import { RunnerAuthenticationError } from "./api-client.js";
import type { RunnerConfig } from "./config.js";
import type { SpawnImplementation } from "./codex.js";
import { RunnerController, runOneJob, type RunnerControllerPhase } from "./runner.js";
import type { ResearchJob } from "./schemas.js";

// GitHub Actions may point the OS temp directory inside the checkout. The
// production runner correctly rejects that unsafe layout, so keep the test
// workspace explicitly beside (and never within) the repository.
const workspace = join(dirname(process.cwd()), `sloppy-potato-runner-test-${process.pid}`);
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
  input: { type: "player_research", subject: "Justin Jefferson", scoringFormat: "ppr", rankingType: "redraft", position: "WR", leagueSize: 12 },
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

function fakeSpawn(output: unknown): {
  implementation: SpawnImplementation;
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; shell: boolean | string | undefined; windowsHide: boolean | undefined }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; shell: boolean | string | undefined; windowsHide: boolean | undefined }> = [];
  const implementation: SpawnImplementation = (command, args, options) => {
    calls.push({ command, args, env: options.env ?? {}, shell: options.shell, windowsHide: options.windowsHide });
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

function fakeLock() {
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    acquire: vi.fn().mockResolvedValue({
      lockPath: join(workspace, "test.lock"),
      metadata: { pid: process.pid, runnerId: config.runnerId, startedAt: new Date().toISOString(), ownerId: "test-owner" },
      release,
    }),
    release,
  };
}

async function waitForPhase(controller: RunnerController, phase: RunnerControllerPhase): Promise<void> {
  if (controller.getSnapshot().phase === phase) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${phase}; current phase is ${controller.getSnapshot().phase}`));
    }, 1_000);
    unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.phase !== phase) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
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
    const invocation = spawned.calls[0]!;
    const execIndex = invocation.args.indexOf("exec");
    expect(invocation.args.slice(execIndex, execIndex + 9)).toEqual([
      "exec", "--ignore-user-config", "--ignore-rules", "--model", "gpt-5.6-luna",
      "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    ]);
    expect(invocation.args.filter((argument) => argument === "--model")).toHaveLength(1);
    expect(invocation.args).not.toContain("gpt-5.6-sol");
    if (process.platform === "win32") expect(invocation.command.toLowerCase()).toMatch(/codex\.exe$/u);
    expect(invocation.shell).toBe(false);
    expect(invocation.windowsHide).toBe(true);
    expect(invocation.env.AGENT_RUNNER_TOKEN).toBeUndefined();
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

  it("stops automatic polling after a rejected credential and remains stoppable", async () => {
    const api = fakeApi();
    api.heartbeat.mockRejectedValue(new RunnerAuthenticationError(401));
    const lock = fakeLock();
    const controller = new RunnerController(config, {
      api: api as unknown as RunnerApiClient,
      acquireLock: lock.acquire,
    });

    await controller.start();
    await waitForPhase(controller, "error");
    expect(api.heartbeat).toHaveBeenCalledOnce();
    expect(api.claim).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.heartbeat).toHaveBeenCalledOnce();

    await expect(controller.stop()).resolves.toEqual({
      stopped: true,
      deferredUntilCurrentJobFinishes: false,
    });
    expect(controller.getSnapshot().phase).toBe("stopped");
  });

  it("supports pause, resume, bounded redacted observations, and safe idle stop", async () => {
    const token = config.token;
    const api = fakeApi();
    api.claim.mockResolvedValue(null);
    const lock = fakeLock();
    const controller = new RunnerController(config, {
      api: api as unknown as RunnerApiClient,
      acquireLock: lock.acquire,
      maximumLogs: 3,
    });
    const phases: RunnerControllerPhase[] = [];
    const unsubscribe = controller.subscribe((snapshot) => phases.push(snapshot.phase));

    await controller.start();
    await vi.waitFor(() => expect(api.claim).toHaveBeenCalledOnce());
    controller.pauseAfterCurrentJob();
    await waitForPhase(controller, "paused");
    expect(controller.getSnapshot().currentJob).toBeNull();

    await controller.resume();
    await vi.waitFor(() => expect(api.claim).toHaveBeenCalledTimes(2));
    controller.pauseAfterCurrentJob();
    await waitForPhase(controller, "paused");
    for (let index = 0; index < 5; index += 1) {
      controller.pauseAfterCurrentJob();
    }
    const snapshot = controller.getSnapshot();
    expect(snapshot.recentLogs).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(phases).toContain("idle");
    expect(phases).toContain("paused");

    await expect(controller.stop()).resolves.toEqual({ stopped: true, deferredUntilCurrentJobFinishes: false });
    expect(lock.release).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("stopped");
    unsubscribe();
  });

  it("does not terminate a claimed job and defers stop until its result is reported", async () => {
    const api = fakeApi();
    let finishCodex: (() => void) | undefined;
    const implementation: SpawnImplementation = (_command, args) => {
      const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      child.stdin.once("finish", () => {
        finishCodex = () => {
          const outputIndex = args.indexOf("-o");
          void writeFile(args[outputIndex + 1]!, JSON.stringify(validResult), "utf8")
            .then(() => child.emit("close", 0));
        };
      });
      return child as ChildProcessWithoutNullStreams;
    };
    const lock = fakeLock();
    const controller = new RunnerController(config, {
      api: api as unknown as RunnerApiClient,
      spawn: implementation,
      acquireLock: lock.acquire,
    });

    await controller.start();
    await waitForPhase(controller, "busy");
    expect(controller.getSnapshot().currentJob).toMatchObject({ id: job.id, type: "player_research" });
    await expect(controller.stop()).resolves.toEqual({ stopped: false, deferredUntilCurrentJobFinishes: true });
    expect(lock.release).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finishCodex).toBeTypeOf("function"));
    finishCodex?.();
    await controller.waitUntilStopped();

    expect(api.complete).toHaveBeenCalledOnce();
    expect(api.fail).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("stopped");
  });

  it("runs one queue check on demand and remains paused", async () => {
    const api = fakeApi();
    api.claim.mockResolvedValue(null);
    const lock = fakeLock();
    const controller = new RunnerController(config, {
      api: api as unknown as RunnerApiClient,
      acquireLock: lock.acquire,
    });

    await expect(controller.runNextOnce()).resolves.toBe(false);
    await waitForPhase(controller, "paused");
    expect(api.claim).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
    await controller.stop();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("stops safely while the single-instance lock is still being acquired", async () => {
    const api = fakeApi();
    api.claim.mockResolvedValue(null);
    const lock = fakeLock();
    let grantLock: ((value: Awaited<ReturnType<typeof lock.acquire>>) => void) | undefined;
    const pendingLock = new Promise<Awaited<ReturnType<typeof lock.acquire>>>((resolve) => {
      grantLock = resolve;
    });
    const controller = new RunnerController(config, {
      api: api as unknown as RunnerApiClient,
      acquireLock: () => pendingLock,
    });

    const starting = controller.start();
    await waitForPhase(controller, "starting");
    const stopping = controller.stop();
    grantLock?.(await lock.acquire());
    await starting;
    await expect(stopping).resolves.toEqual({ stopped: true, deferredUntilCurrentJobFinishes: false });
    expect(api.claim).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("automatically resumes polling after a network error", async () => {
    const api = fakeApi();
    api.claim.mockReset();
    api.claim.mockRejectedValueOnce(new Error(`network unavailable token=${config.token}`)).mockResolvedValue(null);
    const lock = fakeLock();
    const controller = new RunnerController({ ...config, pollIntervalMs: 5 }, {
      api: api as unknown as RunnerApiClient,
      acquireLock: lock.acquire,
    });

    await controller.start();
    await vi.waitFor(() => expect(api.claim.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(JSON.stringify(controller.getSnapshot().recentLogs)).not.toContain(config.token);
    controller.pauseAfterCurrentJob();
    await waitForPhase(controller, "paused");
    await controller.stop();
  });
});
