import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SloppyPotatoDesktopApi } from "../../../desktop/shared/contracts";
import DesktopRunnerControls from "./DesktopRunnerControls";

afterEach(() => {
  cleanup();
  delete window.sloppyPotatoDesktop;
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

  it("uses saved owner access without displaying the token", async () => {
    const api = desktopApi(false);
    window.sloppyPotatoDesktop = api;
    const savedOwnerToken = "s".repeat(48);
    render(<DesktopRunnerControls ownerToken={savedOwnerToken} />);

    expect(await screen.findByText(/saved Research Desk owner access is ready/i)).toBeInTheDocument();
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
});
