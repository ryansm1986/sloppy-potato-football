import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SloppyPotatoDesktopApi } from "../../../desktop/shared/contracts";
import DesktopRunnerControls from "./DesktopRunnerControls";

afterEach(() => {
  cleanup();
  delete window.sloppyPotatoDesktop;
  vi.restoreAllMocks();
});

function desktopApi(hasToken = true): SloppyPotatoDesktopApi {
  const status = { state: "idle" as const, queuedJobs: 0, lastHeartbeatAt: new Date().toISOString() };
  return {
    app: { info: vi.fn(), show: vi.fn(), quit: vi.fn() },
    runner: {
      status: vi.fn(async () => status),
      start: vi.fn(async () => status),
      pauseAfterCurrent: vi.fn(async () => ({ ...status, state: "paused" as const })),
      resume: vi.fn(async () => status),
      stop: vi.fn(async () => ({ ...status, state: "offline" as const })),
      runNext: vi.fn(async () => status),
      logs: vi.fn(async () => []),
      onStatus: vi.fn(() => () => undefined),
      onLog: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({ closeToTray: true, launchAtStartup: false, notificationsEnabled: true, apiBaseUrl: "https://example.test" })),
      update: vi.fn(async (patch) => ({ closeToTray: true, launchAtStartup: false, notificationsEnabled: true, apiBaseUrl: "https://example.test", ...patch })),
    },
    credentials: {
      hasRunnerToken: vi.fn(async () => hasToken),
      setRunnerToken: vi.fn(async () => undefined),
      clearRunnerToken: vi.fn(async () => undefined),
    },
    schedules: { open: vi.fn(async () => undefined) },
    navigation: { onRequest: vi.fn(() => () => undefined) },
  };
}

describe("DesktopRunnerControls", () => {
  it("does not render on the ordinary website", () => {
    const { container } = render(<DesktopRunnerControls />);
    expect(container).toBeEmptyDOMElement();
  });

  it("secures a scoped token and starts the embedded runner", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    expect(await screen.findByLabelText("Desktop runner token")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Desktop runner token"), { target: { value: "scoped-runner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /secure and start/i }));

    await waitFor(() => expect(api.credentials.setRunnerToken).toHaveBeenCalledWith("scoped-runner-secret"));
    expect(api.runner.start).toHaveBeenCalled();
    expect(screen.queryByLabelText("Desktop runner token")).not.toBeInTheDocument();
  });
});
