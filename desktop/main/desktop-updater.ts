import type { DesktopUpdateStatus } from "../shared/contracts.js";
import type { RunnerController } from "./runner-controller.js";

type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface AutoUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  on(event: UpdaterEvent, listener: (...args: any[]) => void): unknown;
  removeListener(event: UpdaterEvent, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdaterRuntime {
  currentVersion: string;
  packaged: boolean;
  installed: boolean;
}

export interface DesktopUpdaterController {
  getStatus(): DesktopUpdateStatus;
  check(): Promise<DesktopUpdateStatus>;
  download(): Promise<DesktopUpdateStatus>;
  restart(): Promise<DesktopUpdateStatus>;
  onStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  start(): void;
  dispose(): void;
}

export interface DesktopUpdaterOptions {
  updater: AutoUpdaterAdapter;
  runner: Pick<RunnerController, "resetCredential">;
  runtime: DesktopUpdaterRuntime;
  checkIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function versionOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && version.length <= 100 ? version : undefined;
}

function progressOf(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const percent = (value as { percent?: unknown }).percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Owns the electron-updater state machine. Renderer code receives only this
 * narrow status model; it never sees installer paths or release credentials.
 */
export class DesktopUpdater implements DesktopUpdaterController {
  private readonly listeners = new Set<(status: DesktopUpdateStatus) => void>();
  private readonly eventListeners: Array<{
    event: UpdaterEvent;
    listener: (...args: any[]) => void;
  }> = [];
  private readonly supported: boolean;
  private status: DesktopUpdateStatus;
  private timer?: ReturnType<typeof setInterval>;
  private checkPromise?: Promise<DesktopUpdateStatus>;
  private downloadPromise?: Promise<DesktopUpdateStatus>;
  private restartPromise?: Promise<DesktopUpdateStatus>;
  private backgroundCheck = false;
  private started = false;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.supported = options.runtime.packaged && options.runtime.installed;
    this.status = this.supported
      ? { phase: "idle", currentVersion: options.runtime.currentVersion }
      : {
          phase: "unsupported",
          currentVersion: options.runtime.currentVersion,
          message: options.runtime.packaged
            ? "Automatic updates require the installed version of the desktop app."
            : "Automatic updates are disabled in development builds.",
        };

    if (!this.supported) return;

    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    options.updater.autoRunAppAfterInstall = true;
    options.updater.allowPrerelease = false;

    this.listen("checking-for-update", () => {
      this.setStatus({ phase: "checking", currentVersion: this.options.runtime.currentVersion });
    });
    this.listen("update-available", (info: unknown) => {
      this.setStatus({
        phase: "available",
        currentVersion: this.options.runtime.currentVersion,
        availableVersion: versionOf(info),
      });
    });
    this.listen("update-not-available", () => {
      this.setStatus({ phase: "idle", currentVersion: this.options.runtime.currentVersion });
    });
    this.listen("download-progress", (progress: unknown) => {
      this.setStatus({
        phase: "downloading",
        currentVersion: this.options.runtime.currentVersion,
        availableVersion: this.status.availableVersion,
        downloadPercent: progressOf(progress),
      });
    });
    this.listen("update-downloaded", (info: unknown) => {
      this.setStatus({
        phase: "ready",
        currentVersion: this.options.runtime.currentVersion,
        availableVersion: versionOf(info) ?? this.status.availableVersion,
        downloadPercent: 100,
      });
    });
    this.listen("error", () => {
      if (this.status.phase === "checking" && this.backgroundCheck) {
        // Transient background connectivity failures should not create a
        // persistent warning in the app chrome.
        this.setStatus({ phase: "idle", currentVersion: this.options.runtime.currentVersion });
        return;
      }
      if (this.status.phase !== "checking" && this.status.phase !== "downloading") return;
      this.setStatus({
        phase: "error",
        currentVersion: this.options.runtime.currentVersion,
        availableVersion: this.status.availableVersion,
        message:
          this.status.phase === "downloading"
            ? "The update could not be downloaded. Click to try again."
            : "The app could not check for updates. Try again later.",
      });
    });
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.supported || this.started) return;
    this.started = true;
    void this.checkInBackground();
    const schedule = this.options.setIntervalFn ?? setInterval;
    this.timer = schedule(() => void this.checkInBackground(), this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  }

  async check(): Promise<DesktopUpdateStatus> {
    return this.runCheck(false);
  }

  async download(): Promise<DesktopUpdateStatus> {
    if (!this.supported) return this.getStatus();
    if (this.downloadPromise) return this.downloadPromise;
    if (this.status.phase !== "available" && !(this.status.phase === "error" && this.status.availableVersion)) {
      return this.getStatus();
    }

    this.setStatus({
      phase: "downloading",
      currentVersion: this.options.runtime.currentVersion,
      availableVersion: this.status.availableVersion,
      downloadPercent: 0,
    });
    this.downloadPromise = this.options.updater
      .downloadUpdate()
      .then(() => this.getStatus())
      .catch(() => {
        this.setStatus({
          phase: "error",
          currentVersion: this.options.runtime.currentVersion,
          availableVersion: this.status.availableVersion,
          message: "The update could not be downloaded. Click to try again.",
        });
        return this.getStatus();
      })
      .finally(() => {
        this.downloadPromise = undefined;
      });
    return this.downloadPromise;
  }

  async restart(): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.status.phase !== "ready") return this.getStatus();
    if (this.restartPromise) return this.restartPromise;

    this.status = { ...this.status, message: "Finishing any active research before restarting…" };
    this.emitStatus();
    this.restartPromise = this.options.runner
      .resetCredential()
      .then(() => {
        // Non-silent install shows the familiar Windows installer UI and starts
        // the app again when complete.
        this.options.updater.quitAndInstall(false, true);
        return this.getStatus();
      })
      .catch(() => {
        this.setStatus({
          phase: "ready",
          currentVersion: this.options.runtime.currentVersion,
          availableVersion: this.status.availableVersion,
          downloadPercent: 100,
          message: "The runner could not stop safely. Click to try restarting again.",
        });
        return this.getStatus();
      })
      .finally(() => {
        this.restartPromise = undefined;
      });
    return this.restartPromise;
  }

  onStatus(listener: (status: DesktopUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) {
      const clear = this.options.clearIntervalFn ?? clearInterval;
      clear(this.timer);
      this.timer = undefined;
    }
    for (const { event, listener } of this.eventListeners) {
      this.options.updater.removeListener(event, listener);
    }
    this.eventListeners.length = 0;
    this.listeners.clear();
  }

  private async checkInBackground(): Promise<DesktopUpdateStatus> {
    return this.runCheck(true);
  }

  private async runCheck(background: boolean): Promise<DesktopUpdateStatus> {
    if (!this.supported) return this.getStatus();
    if (this.checkPromise) return this.checkPromise;
    if (["available", "downloading", "ready"].includes(this.status.phase)) return this.getStatus();

    this.backgroundCheck = background;
    this.setStatus({ phase: "checking", currentVersion: this.options.runtime.currentVersion });
    this.checkPromise = this.options.updater
      .checkForUpdates()
      .then((result) => {
        // electron-updater normally emits update-(not-)available. A null result
        // means its updater is disabled, so do not leave the UI stuck checking.
        if (result === null && this.status.phase === "checking") {
          this.setStatus({ phase: "idle", currentVersion: this.options.runtime.currentVersion });
        }
        return this.getStatus();
      })
      .catch(() => {
        if (background) {
          this.setStatus({ phase: "idle", currentVersion: this.options.runtime.currentVersion });
        } else {
          this.setStatus({
            phase: "error",
            currentVersion: this.options.runtime.currentVersion,
            message: "The app could not check for updates. Try again later.",
          });
        }
        return this.getStatus();
      })
      .finally(() => {
        this.backgroundCheck = false;
        this.checkPromise = undefined;
      });
    return this.checkPromise;
  }

  private listen(event: UpdaterEvent, listener: (...args: any[]) => void): void {
    this.eventListeners.push({ event, listener });
    this.options.updater.on(event, listener);
  }

  private setStatus(status: DesktopUpdateStatus): void {
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }
}
