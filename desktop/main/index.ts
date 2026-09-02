import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  shell,
  type Event,
  type WebContents,
} from "electron";
import type { DesktopSettings } from "../shared/contracts.js";
import { installDesktopProtocol, registerDesktopScheme } from "./app-protocol.js";
import { SecureConfigStore } from "./config-store.js";
import { electronCredentialCipher, JsonFileAdapter } from "./electron-config-store.js";
import { ExistingRunnerAdapter } from "./existing-runner-adapter.js";
import { registerDesktopIpc, sendDesktopNavigation } from "./ipc.js";
import { RunnerNotifier } from "./notifier.js";
import type { RunnerController } from "./runner-controller.js";
import { isSafeExternalUrl, isTrustedRendererUrl } from "./security.js";
import { DesktopTray } from "./tray.js";

registerDesktopScheme();

export interface DesktopBootstrapOptions {
  createRunnerController?(config: SecureConfigStore): RunnerController | Promise<RunnerController>;
}

function developmentUrlFromEnvironment(): string | undefined {
  const value = process.env.SLOPPY_POTATO_DESKTOP_DEV_URL;
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
  ) {
    throw new Error("Desktop development URL must be an HTTP localhost URL.");
  }
  return url.toString();
}

function configureWebContents(contents: WebContents, developmentUrl?: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, developmentUrl)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

export async function launchDesktopApp(options: DesktopBootstrapOptions = {}): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.setAppUserModelId("com.sloppypotato.fantasyfootball");
  await app.whenReady();

  const config = new SecureConfigStore(
    new JsonFileAdapter(path.join(app.getPath("userData"), "desktop-config.json")),
    electronCredentialCipher,
  );
  await config.initialize();
  const runner = options.createRunnerController
    ? await options.createRunnerController(config)
    : new ExistingRunnerAdapter(config, app.getPath("userData"));
  const developmentUrl = developmentUrlFromEnvironment();
  const rendererRoot = path.join(app.getAppPath(), "dist", "client");
  installDesktopProtocol({ rendererRoot, getApiBaseUrl: () => config.getSettings().apiBaseUrl });

  const preload = path.join(app.getAppPath(), "dist-desktop", "preload.cjs");
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#10120f",
    title: "Sloppy Potato Fantasy Football",
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  configureWebContents(window.webContents, developmentUrl);
  Menu.setApplicationMenu(null);

  let isQuitting = false;
  const showWindow = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const quit = () => {
    isQuitting = true;
    app.quit();
  };
  const updateStartup = async (enabled: boolean): Promise<DesktopSettings> => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled ? ["--hidden"] : [],
    });
    return config.updateSettings({ launchAtStartup: enabled });
  };
  const notifier = new RunnerNotifier(() => config.getSettings());
  const safely = (operation: () => Promise<unknown>) => async () => {
    try {
      await operation();
    } catch (error) {
      notifier.showError(error instanceof Error ? error.message : "An unexpected runner error occurred.");
    }
  };

  let tray: DesktopTray;
  tray = new DesktopTray(config.getSettings(), {
    showWindow,
    openSchedules: () => {
      showWindow();
      sendDesktopNavigation(window, { path: "/research/schedules" });
    },
    startRunner: safely(() => runner.start()),
    pauseRunner: safely(() => runner.pauseAfterCurrent()),
    resumeRunner: safely(() => runner.resume()),
    runNext: safely(() => runner.runNext()),
    setLaunchAtStartup: async (enabled) => {
      try {
        const settings = await updateStartup(enabled);
        tray.updateSettings(settings);
      } catch (error) {
        notifier.showError(error instanceof Error ? error.message : "Startup preference could not be saved.");
      }
    },
    quit,
  });

  const unregisterIpc = registerDesktopIpc({
    window,
    runner,
    config,
    devServerUrl: developmentUrl,
    showWindow,
    quit,
    updateStartup,
    onSettingsChanged: (settings) => tray.updateSettings(settings),
  });
  const unsubscribeTrayStatus = runner.onStatus((status) => {
    tray.updateStatus(status);
    notifier.handleStatus(status);
  });
  tray.updateStatus(await runner.getStatus());
  if (config.hasRunnerToken()) void safely(() => runner.start())();

  window.on("close", (event: Event) => {
    if (!isQuitting && config.getSettings().closeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  if (!process.argv.includes("--hidden")) window.once("ready-to-show", showWindow);

  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.once("will-quit", () => {
    unregisterIpc();
    unsubscribeTrayStatus();
    tray.destroy();
    void runner.dispose();
  });

  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadURL("potato://app/");
}
