import { describe, expect, it } from "vitest";
import { desktopRunnerId, mapCoreSnapshot } from "./existing-runner-adapter.js";

describe("existing runner desktop adapter", () => {
  it("gives separate installations distinct stable runner IDs even with the same host name", () => {
    expect(desktopRunnerId("same-pc-name", "install-a"))
      .not.toBe(desktopRunnerId("same-pc-name", "install-b"));
    expect(desktopRunnerId("same-pc-name", "install-a"))
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
});
