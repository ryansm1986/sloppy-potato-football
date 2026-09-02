import { describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../../runner/config.js";
import type { SecureConfigStore } from "./config-store.js";
import { desktopRunnerId, mapCoreSnapshot } from "./existing-runner-adapter.js";

describe("existing runner desktop adapter", () => {
  it("gives separate installations distinct stable runner IDs even with the same host name", () => {
    expect(desktopRunnerId("same-pc-name", "install-a"))
      .not.toBe(desktopRunnerId("same-pc-name", "install-b"));
    expect(desktopRunnerId("same-pc-name", "install-a"))
      .toBe(desktopRunnerId("same-pc-name", "install-a"));
    expect(desktopRunnerId("renamed-pc", "install-a"))
      .toBe(desktopRunnerId("same-pc-name", "install-a"));
  });

  it("maps an active core job to desktop runner status", () => {
    const status = mapCoreSnapshot({
      phase: "busy",
      currentJob: {
        id: "job-1",
        type: "rankings_research",
        attempt: 1,
        maxAttempts: 3,
        startedAt: "2026-09-02T12:00:00.000Z",
      },
      recentLogs: [],
      startedAt: "2026-09-02T11:59:00.000Z",
      updatedAt: "2026-09-02T12:00:01.000Z",
    });

    expect(status.state).toBe("running");
    expect(status.currentJob).toMatchObject({ id: "job-1", label: "rankings research" });
  });

  it("represents a requested pause without aborting the current job", () => {
    const status = mapCoreSnapshot(
      {
        phase: "busy",
        currentJob: null,
        recentLogs: [],
        startedAt: null,
        updatedAt: "2026-09-02T12:00:01.000Z",
      },
      true,
    );
    expect(status.state).toBe("pausing");
  });

  it("stops and discards the controller that captured an old credential", async () => {
    let token = "a".repeat(48);
    const config = {
      hasRunnerToken: () => Boolean(token),
      getRunnerToken: () => token,
      getInstallationId: () => "installation-a",
      getSettings: () => ({ apiBaseUrl: "https://example.test" }),
    } as SecureConfigStore;
    const cores = ["old", "new"].map(() => ({
      getSnapshot: () => ({
        phase: "offline" as const,
        currentJob: null,
        recentLogs: [],
        startedAt: "2026-09-02T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:01.000Z",
      }),
      start: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      pauseAfterCurrentJob: vi.fn(),
      runNextOnce: vi.fn(async () => false),
      stop: vi.fn(async () => ({ stopped: true, deferredUntilCurrentJobFinishes: false })),
      waitUntilStopped: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    }));
    const createCore = vi.fn((_runnerConfig: RunnerConfig) => cores.shift()!);
    const adapter = new (await import("./existing-runner-adapter.js")).ExistingRunnerAdapter(
      config,
      "C:\\desktop-data",
      createCore,
    );

    await adapter.start();
    const oldCore = createCore.mock.results[0]!.value;
    await adapter.resetCredential();
    token = "b".repeat(48);
    await adapter.start();

    expect(oldCore.stop).toHaveBeenCalledOnce();
    expect(createCore).toHaveBeenCalledTimes(2);
    expect(createCore.mock.calls[0]![0].token).toBe("a".repeat(48));
    expect(createCore.mock.calls[1]![0].token).toBe("b".repeat(48));
  });

  it("maps terminal authentication rejection to an actionable desktop error", () => {
    expect(mapCoreSnapshot({
      phase: "error",
      currentJob: null,
      recentLogs: [],
      startedAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:01.000Z",
    })).toMatchObject({
      state: "error",
      detail: "Runner credential was rejected. Replace or remove it to reconnect.",
    });
  });
});
