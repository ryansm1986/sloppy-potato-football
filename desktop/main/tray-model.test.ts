import { describe, expect, it } from "vitest";
import { getTrayPresentation } from "./tray-model.js";

describe("tray presentation", () => {
  it("offers pause while a job is running", () => {
    const result = getTrayPresentation({
      state: "running",
      queuedJobs: 2,
      currentJob: { id: "job-1", label: "PPR rankings" },
    });
    expect(result.statusLabel).toContain("PPR rankings");
    expect(result.primaryAction).toBe("pause");
    expect(result.canRunNext).toBe(false);
  });

  it("offers a queued-job action while idle", () => {
    const result = getTrayPresentation({ state: "idle", queuedJobs: 3 });
    expect(result.canRunNext).toBe(true);
    expect(result.tooltip).toContain("Idle");
  });
});
