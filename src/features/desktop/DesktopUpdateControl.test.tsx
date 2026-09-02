import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateStatus, SloppyPotatoDesktopApi } from "../../../desktop/shared/contracts";
import DesktopUpdateControl from "./DesktopUpdateControl";

afterEach(() => {
  cleanup();
  delete window.sloppyPotatoDesktop;
  vi.restoreAllMocks();
});

function installDesktopBridge(initialStatus: DesktopUpdateStatus) {
  let listener: ((status: DesktopUpdateStatus) => void) | undefined;
  const updates: NonNullable<SloppyPotatoDesktopApi["updates"]> = {
    status: vi.fn(async () => initialStatus),
    check: vi.fn(async (): Promise<DesktopUpdateStatus> => ({ ...initialStatus, phase: "checking" })),
    download: vi.fn(async (): Promise<DesktopUpdateStatus> => ({ ...initialStatus, phase: "downloading", downloadPercent: 0 })),
    restart: vi.fn(async () => initialStatus),
    onStatus: vi.fn((nextListener) => {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    }),
  };

  window.sloppyPotatoDesktop = { updates } as unknown as SloppyPotatoDesktopApi;

  return {
    updates,
    emit(status: DesktopUpdateStatus) {
      act(() => listener?.(status));
    },
  };
}

describe("DesktopUpdateControl", () => {
  it("does not render on the website or while no update is actionable", async () => {
    const { rerender } = render(<DesktopUpdateControl />);
    expect(screen.queryByRole("button", { name: /update/i })).not.toBeInTheDocument();

    installDesktopBridge({ phase: "idle", currentVersion: "0.1.0" });
    rerender(<DesktopUpdateControl />);

    await waitFor(() => expect(screen.queryByRole("button", { name: /update/i })).not.toBeInTheDocument());
  });

  it("downloads on the first click, then restarts to install on the second click", async () => {
    const bridge = installDesktopBridge({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
    });
    render(<DesktopUpdateControl />);

    fireEvent.click(await screen.findByRole("button", { name: /update v0\.2\.0 available.*download the update/i }));
    await waitFor(() => expect(bridge.updates.download).toHaveBeenCalledOnce());

    bridge.emit({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      downloadPercent: 100,
    });

    fireEvent.click(screen.getByRole("button", { name: /restart to install v0\.2\.0/i }));
    await waitFor(() => expect(bridge.updates.restart).toHaveBeenCalledOnce());
  });

  it("shows download progress and prevents another download click", async () => {
    installDesktopBridge({
      phase: "downloading",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      downloadPercent: 42.4,
    });
    render(<DesktopUpdateControl />);

    const progress = await screen.findByRole("button", { name: /downloading update - 42%/i });
    expect(progress).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading update - 42%");
  });

  it("retries a failed update check", async () => {
    const bridge = installDesktopBridge({
      phase: "error",
      currentVersion: "0.1.0",
      message: "Could not contact the update server.",
    });
    render(<DesktopUpdateControl />);

    fireEvent.click(await screen.findByRole("button", { name: /update failed - retry.*check for the update again/i }));
    await waitFor(() => expect(bridge.updates.check).toHaveBeenCalledOnce());
  });
});
