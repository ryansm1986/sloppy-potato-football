import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type {
  DesktopNavigationRequest,
  DesktopSettings,
  RunnerLogEntry,
  RunnerStatus,
} from "../shared/contracts.js";
import { IPC_CHANNELS } from "../shared/contracts.js";
import { sanitizeSettingsPatch, type SecureConfigStore } from "./config-store.js";
import type { RunnerController } from "./runner-controller.js";
import { isTrustedRendererUrl } from "./security.js";

export interface DesktopIpcOptions {
  window: BrowserWindow;
  runner: RunnerController;
  config: SecureConfigStore;
  devServerUrl?: string;
  showWindow(): void;
  quit(): void;
  updateStartup(enabled: boolean): Promise<DesktopSettings>;
  onSettingsChanged(settings: DesktopSettings): void;
}

function validateSender(event: IpcMainInvokeEvent, devServerUrl?: string): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl, devServerUrl)) {
    throw new Error("Blocked IPC call from an untrusted renderer.");
  }
}

function assertNoArguments(args: unknown[]): void {
  if (args.length) throw new Error("This desktop command does not accept arguments.");
}

export function sendDesktopNavigation(
  window: BrowserWindow,
  request: DesktopNavigationRequest,
): void {
  if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.eventNavigate, request);
}

export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const channels: string[] = [];
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      validateSender(event, options.devServerUrl);
      return listener(event, ...args);
    });
  };

  handle(IPC_CHANNELS.appInfo, (_event, ...args) => {
    assertNoArguments(args);
    return { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged };
  });
  handle(IPC_CHANNELS.appShow, (_event, ...args) => {
    assertNoArguments(args);
    options.showWindow();
  });
  handle(IPC_CHANNELS.appQuit, (_event, ...args) => {
    assertNoArguments(args);
    options.quit();
  });

  handle(IPC_CHANNELS.runnerStatus, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.getStatus();
  });
  handle(IPC_CHANNELS.runnerStart, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.start();
  });
  handle(IPC_CHANNELS.runnerPause, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.pauseAfterCurrent();
  });
  handle(IPC_CHANNELS.runnerResume, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.resume();
  });
  handle(IPC_CHANNELS.runnerStop, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.stop();
  });
  handle(IPC_CHANNELS.runnerRunNext, (_event, ...args) => {
    assertNoArguments(args);
    return options.runner.runNext();
  });
  handle(IPC_CHANNELS.runnerLogs, (_event, ...args) => {
    if (args.length > 1) throw new Error("Runner logs accepts at most one argument.");
    const rawLimit = args[0];
    if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit))) {
      throw new Error("Runner log limit must be a finite number.");
    }
    const limit = Math.min(Math.max(Math.trunc((rawLimit as number | undefined) ?? 200), 1), 1_000);
    return options.runner.getLogs(limit);
  });

  handle(IPC_CHANNELS.settingsGet, (_event, ...args) => {
    assertNoArguments(args);
    return options.config.getSettings();
  });
  handle(IPC_CHANNELS.settingsUpdate, async (_event, ...args) => {
    if (args.length !== 1) throw new Error("Settings update requires one argument.");
    const requested = sanitizeSettingsPatch(args[0]);
    const updated =
      "launchAtStartup" in requested
        ? await options.updateStartup(requested.launchAtStartup!)
        : await options.config.updateSettings(requested);

    const remainingPatch = { ...requested };
    delete remainingPatch.launchAtStartup;
    const finalSettings = Object.keys(remainingPatch).length
      ? await options.config.updateSettings(remainingPatch)
      : updated;
    options.onSettingsChanged(finalSettings);
    return finalSettings;
  });
  handle(IPC_CHANNELS.credentialsHasRunnerToken, (_event, ...args) => {
    assertNoArguments(args);
    return options.config.hasRunnerToken();
  });
  handle(IPC_CHANNELS.credentialsSetRunnerToken, async (_event, ...args) => {
    if (args.length !== 1 || typeof args[0] !== "string") {
      throw new Error("A runner token string is required.");
    }
    await options.config.setRunnerToken(args[0]);
  });
  handle(IPC_CHANNELS.credentialsClearRunnerToken, async (_event, ...args) => {
    assertNoArguments(args);
    await options.config.clearRunnerToken();
  });
  handle(IPC_CHANNELS.schedulesOpen, (_event, ...args) => {
    assertNoArguments(args);
    options.showWindow();
    sendDesktopNavigation(options.window, { path: "/research/schedules" });
  });

  const unsubscribeStatus = options.runner.onStatus((status: RunnerStatus) => {
    if (!options.window.isDestroyed()) {
      options.window.webContents.send(IPC_CHANNELS.eventRunnerStatus, status);
    }
  });
  const unsubscribeLogs = options.runner.onLog((entry: RunnerLogEntry) => {
    if (!options.window.isDestroyed()) {
      options.window.webContents.send(IPC_CHANNELS.eventRunnerLog, entry);
    }
  });

  return () => {
    unsubscribeStatus();
    unsubscribeLogs();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
