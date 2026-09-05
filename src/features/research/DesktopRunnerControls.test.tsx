import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerLogEntry, RunnerStatus, SloppyPotatoDesktopApi } from "../../../desktop/shared/contracts";
import DesktopRunnerControls from "./DesktopRunnerControls";

afterEach(() => {
  cleanup();
  delete window.sloppyPotatoDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function desktopApi(hasToken = true, state: "idle" | "offline" | "error" = "idle"): SloppyPotatoDesktopApi {
  const status = { state, queuedJobs: 0, lastHeartbeatAt: new Date().toISOString(), ...(state === "error" ? { detail: "Runner credential was rejected. Replace or remove it to reconnect." } : {}) };
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
      enrollRunner: vi.fn(async ({ name }) => ({ device: { id: "device-1", name } })),
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

    expect(await screen.findByLabelText("Owner token")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Use an existing runner token instead"));
    fireEvent.change(screen.getByLabelText("Desktop runner token"), { target: { value: "scoped-runner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /secure and start/i }));

    await waitFor(() => expect(api.credentials.setRunnerToken).toHaveBeenCalledWith("scoped-runner-secret"));
    expect(api.runner.start).toHaveBeenCalled();
    expect(screen.queryByLabelText("Desktop runner token")).not.toBeInTheDocument();
  });

  it("explains why setup is disabled when owner access is missing", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    expect(await screen.findByText(/enter an owner token here or save one/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up this computer/i })).toBeDisabled();
  });

  it("loads the existing owner token from a selected .env.runner file", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);
    const ownerToken = `owner_${"x".repeat(48)}`;
    const file = new File([
      `AGENT_RUNNER_TOKEN=runner-secret\nRESEARCH_OWNER_TOKEN=${ownerToken}\n`,
    ], ".env.runner", { type: "text/plain" });

    fireEvent.change(await screen.findByLabelText("Choose .env.runner file"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByLabelText("Owner token")).toHaveValue(ownerToken));
    expect(screen.getByRole("button", { name: /set up this computer/i })).toBeEnabled();
  });

  it("uses saved owner access without displaying the token", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    const savedOwnerToken = "s".repeat(48);
    render(<DesktopRunnerControls ownerToken={savedOwnerToken} />);

    expect(await screen.findByText(/saved owner access from Settings is ready/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Owner token")).toHaveValue("");
    const setup = screen.getByRole("button", { name: /set up this computer/i });
    expect(setup).toBeEnabled();
    fireEvent.click(setup);

    await waitFor(() => expect(api.credentials.enrollRunner).toHaveBeenCalledWith({
      ownerToken: savedOwnerToken,
      name: "My fantasy football computer",
    }));
  });

  it("shows immediate progress while enrollment is pending", async () => {
    const api = desktopApi(false);
    api.credentials.enrollRunner = vi.fn(() => new Promise<never>(() => undefined));
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls ownerToken={"s".repeat(48)} />);

    fireEvent.click(await screen.findByRole("button", { name: /set up this computer/i }));

    expect(await screen.findByRole("button", { name: /setting up/i })).toBeDisabled();
    expect(screen.getByText(/creating and securing this computer's runner credential/i)).toBeInTheDocument();
  });

  it("places a rejected enrollment error directly after the setup button", async () => {
    const api = desktopApi(false);
    api.credentials.enrollRunner = vi.fn(async () => {
      throw new Error("A valid research owner token is required.");
    });
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls ownerToken={"x".repeat(48)} />);

    const setup = await screen.findByRole("button", { name: /set up this computer/i });
    fireEvent.click(setup);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/valid research owner token is required/i);
    expect(setup.nextElementSibling).toBe(alert);
  });

  it("enrolls a computer without receiving or displaying its device token", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    fireEvent.change(await screen.findByLabelText("Computer name"), { target: { value: "Ryan laptop" } });
    fireEvent.change(screen.getByLabelText("Owner token"), { target: { value: "o".repeat(48) } });
    fireEvent.click(screen.getByRole("button", { name: /set up this computer/i }));

    await waitFor(() => expect(api.credentials.enrollRunner).toHaveBeenCalledWith({
      ownerToken: "o".repeat(48),
      name: "Ryan laptop",
    }));
    expect(api.runner.start).toHaveBeenCalled();
    expect(screen.queryByLabelText("Owner token")).not.toBeInTheDocument();
    expect(await screen.findByText(/Ryan laptop is enrolled/i)).toBeInTheDocument();
  });

  it("can stop an offline bad-token runner and keeps replacement controls accessible", async () => {
    const api = desktopApi(true, "offline");
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    const stop = await screen.findByRole("button", { name: /stop polling/i });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(api.runner.stop).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Runner credential"));
    fireEvent.change(screen.getByLabelText("Replacement runner token"), { target: { value: "n".repeat(48) } });
    fireEvent.click(screen.getByRole("button", { name: /replace and restart/i }));
    await waitFor(() => expect(api.credentials.setRunnerToken).toHaveBeenCalledWith("n".repeat(48)));
    expect(api.runner.start).toHaveBeenCalled();
  });

  it("stops and removes a rejected credential", async () => {
    const api = desktopApi(true, "error");
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/credential was rejected/i);
    fireEvent.click(await screen.findByRole("button", { name: /remove from this computer/i }));
    expect(screen.getByText(/does not revoke the server credential/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove locally/i }));
    await waitFor(() => expect(api.credentials.clearRunnerToken).toHaveBeenCalled());
    expect(await screen.findByText(/credential removed/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Owner token")).toBeInTheDocument();
  });

  it("waits for the credential check before showing setup", async () => {
    const api = desktopApi(true);
    let resolveToken!: (value: boolean) => void;
    api.credentials.hasRunnerToken = vi.fn(() => new Promise<boolean>((resolve) => { resolveToken = resolve; }));
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    expect(screen.getByText(/loading this computer's runner/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up this computer/i })).not.toBeInTheDocument();
    await act(async () => resolveToken(true));
    expect(await screen.findByRole("button", { name: /run next/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Owner token")).not.toBeInTheDocument();
  });

  it("can refresh a failed credential check without suggesting the computer needs setup", async () => {
    const api = desktopApi(true);
    api.credentials.hasRunnerToken = vi.fn()
      .mockRejectedValueOnce(new Error("Could not read secure storage."))
      .mockResolvedValueOnce(true);
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read secure storage.");
    expect(screen.queryByLabelText("Owner token")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /refresh runner status/i }));
    expect(await screen.findByRole("button", { name: /run next/i })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps pause and stop usable throughout a run-next job and ignores its stale completion", async () => {
    const api = desktopApi(true);
    let statusListener!: (value: RunnerStatus) => void;
    let finishJob!: (value: RunnerStatus) => void;
    api.runner.onStatus = vi.fn((listener) => { statusListener = listener; return () => undefined; });
    api.runner.runNext = vi.fn(() => new Promise<RunnerStatus>((resolve) => { finishJob = resolve; }));
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    fireEvent.click(await screen.findByRole("button", { name: /run next/i }));
    act(() => statusListener({ state: "running", queuedJobs: 0, currentJob: { id: "job-1", label: "PPR rankings" } }));
    expect(screen.getByRole("button", { name: /running next/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /pause after job/i })).toBeEnabled();
    const stop = screen.getByRole("button", { name: /stop polling/i });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(api.runner.stop).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();

    await act(async () => finishJob({ state: "idle", queuedJobs: 0 }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("resumes a paused runner and lets a scheduled pause be cancelled", async () => {
    const api = desktopApi(true);
    let statusListener!: (value: RunnerStatus) => void;
    api.runner.status = vi.fn(async (): Promise<RunnerStatus> => ({ state: "paused", queuedJobs: 0 }));
    api.runner.onStatus = vi.fn((listener) => { statusListener = listener; return () => undefined; });
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);

    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.runner.resume).toHaveBeenCalledOnce());
    act(() => statusListener({ state: "pausing", queuedJobs: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    await waitFor(() => expect(api.runner.resume).toHaveBeenCalledTimes(2));
  });

  it("offers reconnect after an error without removing the saved credential", async () => {
    const api = desktopApi(true, "error");
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(api.runner.start).toHaveBeenCalledOnce());
    expect(api.credentials.clearRunnerToken).not.toHaveBeenCalled();
  });

  it("shows elapsed time from the actual job start and keeps it ticking", async () => {
    const api = desktopApi(true);
    const initialNow = Date.parse("2026-09-05T12:02:05Z");
    vi.spyOn(Date, "now").mockReturnValue(initialNow);
    api.runner.status = vi.fn(async (): Promise<RunnerStatus> => ({
      state: "running", queuedJobs: 0,
      currentJob: { id: "job-1", label: "PPR rankings", startedAt: "2026-09-05T12:00:00Z" },
    }));
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);
    expect(await screen.findByLabelText("Current job elapsed time")).toHaveTextContent("2m 05s");
    vi.mocked(Date.now).mockReturnValue(initialNow + 1_000);
    await waitFor(() => expect(screen.getByLabelText("Current job elapsed time")).toHaveTextContent("2m 06s"), { timeout: 2_000 });
  });

  it("searches and filters activity, expands older entries, and deduplicates live logs", async () => {
    const api = desktopApi(true);
    const entries: RunnerLogEntry[] = Array.from({ length: 12 }, (_, index) => ({
      id: `log-${index}`, at: `2026-09-05T12:00:${String(index).padStart(2, "0")}Z`,
      level: "info", message: `Polling queue ${index}`,
    }));
    entries.push({ id: "warning", at: "2026-09-05T12:01:00Z", level: "warn", message: "Rankings source unavailable" });
    entries.push({ id: "done", at: "2026-09-05T12:02:00Z", level: "success", message: "Sleeper research completed" });
    let logListener!: (value: RunnerLogEntry) => void;
    api.runner.logs = vi.fn(async () => entries);
    api.runner.onLog = vi.fn((listener) => { logListener = listener; return () => undefined; });
    window.sloppyPotatoDesktop = api;
    render(<DesktopRunnerControls />);
    fireEvent.click(await screen.findByText("Recent runner activity (14)"));

    expect(screen.getByText("Showing 8 of 14 recent entries")).toBeInTheDocument();
    expect(screen.queryByText("Polling queue 0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show more activity/i }));
    expect(screen.getByText("Polling queue 0")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter runner activity"), { target: { value: "problems" } });
    expect(screen.getByText("Rankings source unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Sleeper research completed")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search runner activity"), { target: { value: "sleeper" } });
    expect(screen.getByText("No activity matches these filters.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter runner activity"), { target: { value: "success" } });
    expect(screen.getByText("Sleeper research completed")).toBeInTheDocument();
    act(() => logListener(entries[13]!));
    expect(screen.getByText("Recent runner activity (14)")).toBeInTheDocument();
  });
});
