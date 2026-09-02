import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopUpdater,
  type AutoUpdaterAdapter,
  type DesktopUpdaterOptions,
} from "./desktop-updater.js";

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => null);
  downloadUpdate = vi.fn<() => Promise<string[]>>(async () => []);
  quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<DesktopUpdaterOptions> = {}) {
  const updater = new FakeAutoUpdater();
  const runner = { resetCredential: vi.fn(async () => undefined) };
  const controller = new DesktopUpdater({
    updater,
    runner,
    runtime: { currentVersion: "1.2.3", packaged: true, installed: true },
    ...overrides,
  });
  return { controller, updater, runner };
}

describe("DesktopUpdater", () => {
  it("disables updates outside a packaged installed build", async () => {
    const updater = new FakeAutoUpdater();
    const controller = new DesktopUpdater({
      updater,
      runner: { resetCredential: vi.fn() },
      runtime: { currentVersion: "1.2.3", packaged: false, installed: true },
    });

    controller.start();

    expect(controller.getStatus()).toMatchObject({ phase: "unsupported", currentVersion: "1.2.3" });
    expect((await controller.check()).phase).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.listenerCount("update-available")).toBe(0);
  });

  it("disables updates for a packaged portable executable", () => {
    const updater = new FakeAutoUpdater();
    const controller = new DesktopUpdater({
      updater,
      runner: { resetCredential: vi.fn() },
      runtime: { currentVersion: "1.2.3", packaged: true, installed: false },
    });

    expect(controller.getStatus()).toMatchObject({
      phase: "unsupported",
      message: expect.stringContaining("installed version"),
    });
    expect(updater.autoDownload).toBe(true);
  });

  it("configures explicit download/install and checks at startup and on schedule", async () => {
    const updater = new FakeAutoUpdater();
    let scheduled: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const controller = new DesktopUpdater({
      updater,
      runner: { resetCredential: vi.fn() },
      runtime: { currentVersion: "1.2.3", packaged: true, installed: true },
      checkIntervalMs: 1234,
      setIntervalFn: ((callback: () => void, delay: number) => {
        expect(delay).toBe(1234);
        scheduled = callback;
        return 42 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    controller.start();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(controller.getStatus().phase).toBe("idle"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduled?.();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(2));

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.autoRunAppAfterInstall).toBe(true);
    expect(updater.allowPrerelease).toBe(false);

    controller.dispose();
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
    expect(updater.listenerCount("update-available")).toBe(0);
  });

  it("does not surface transient background check failures", async () => {
    const { controller, updater } = setup({
      setIntervalFn: (() => 1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
    });
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));

    controller.start();

    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.getStatus().phase).toBe("idle"));
  });

  it("reports a manual check failure without exposing raw network details", async () => {
    const { controller, updater } = setup();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("token=secret https://private.example"));

    const status = await controller.check();

    expect(status).toEqual({
      phase: "error",
      currentVersion: "1.2.3",
      message: "The app could not check for updates. Try again later.",
    });
  });

  it("publishes available, progress, and downloaded states", async () => {
    const { controller, updater } = setup();
    const observed: string[] = [];
    const unsubscribe = controller.onStatus((status) => observed.push(status.phase));
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.3.0" });
      return { updateInfo: { version: "1.3.0" } };
    });

    expect(await controller.check()).toMatchObject({ phase: "available", availableVersion: "1.3.0" });

    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit("download-progress", { percent: 43.6 });
      updater.emit("update-downloaded", { version: "1.3.0" });
      return ["private-installer-path.exe"];
    });
    expect(await controller.download()).toEqual({
      phase: "ready",
      currentVersion: "1.2.3",
      availableVersion: "1.3.0",
      downloadPercent: 100,
    });
    expect(observed).toContain("downloading");
    expect(observed).toContain("ready");

    unsubscribe();
    updater.emit("update-not-available", { version: "1.2.3" });
    expect(observed.at(-1)).toBe("ready");
  });

  it("allows a failed download to be retried", async () => {
    const { controller, updater } = setup();
    updater.emit("update-available", { version: "1.3.0" });
    updater.downloadUpdate.mockRejectedValueOnce(new Error("network error"));

    expect(await controller.download()).toMatchObject({
      phase: "error",
      availableVersion: "1.3.0",
      message: expect.stringContaining("downloaded"),
    });

    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit("update-downloaded", { version: "1.3.0" });
      return [];
    });
    expect((await controller.download()).phase).toBe("ready");
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it("waits for an active runner to finish before installing", async () => {
    const stop = deferred<void>();
    const updater = new FakeAutoUpdater();
    const runner = { resetCredential: vi.fn(() => stop.promise) };
    const controller = new DesktopUpdater({
      updater,
      runner,
      runtime: { currentVersion: "1.2.3", packaged: true, installed: true },
    });
    updater.emit("update-downloaded", { version: "1.3.0" });

    const restarting = controller.restart();
    expect(controller.getStatus().message).toContain("active research");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    stop.resolve();
    await restarting;
    expect(runner.resetCredential).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("does not install when the runner cannot stop safely", async () => {
    const { controller, updater, runner } = setup();
    runner.resetCredential.mockRejectedValueOnce(new Error("still running"));
    updater.emit("update-downloaded", { version: "1.3.0" });

    const status = await controller.restart();

    expect(status).toMatchObject({ phase: "ready", message: expect.stringContaining("try restarting") });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
