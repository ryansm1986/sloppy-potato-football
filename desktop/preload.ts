import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopNavigationRequest,
  DesktopSettings,
  RunnerLogEntry,
  RunnerStatus,
  SloppyPotatoDesktopApi,
} from "./shared/contracts.js";
import { IPC_CHANNELS } from "./shared/contracts.js";

function noArgs<T>(channel: string): () => Promise<T> {
  return () => ipcRenderer.invoke(channel) as Promise<T>;
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const desktopApi: SloppyPotatoDesktopApi = Object.freeze({
  app: Object.freeze({
    info: noArgs<import("./shared/contracts.js").DesktopAppInfo>(IPC_CHANNELS.appInfo),
    show: noArgs<void>(IPC_CHANNELS.appShow),
    quit: noArgs<void>(IPC_CHANNELS.appQuit),
  }),
  runner: Object.freeze({
    status: noArgs<RunnerStatus>(IPC_CHANNELS.runnerStatus),
    start: noArgs<RunnerStatus>(IPC_CHANNELS.runnerStart),
    pauseAfterCurrent: noArgs<RunnerStatus>(IPC_CHANNELS.runnerPause),
    resume: noArgs<RunnerStatus>(IPC_CHANNELS.runnerResume),
    stop: noArgs<RunnerStatus>(IPC_CHANNELS.runnerStop),
    runNext: noArgs<RunnerStatus>(IPC_CHANNELS.runnerRunNext),
    logs: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.runnerLogs, limit) as Promise<RunnerLogEntry[]>,
    onStatus: (listener: (status: RunnerStatus) => void) =>
      subscribe(IPC_CHANNELS.eventRunnerStatus, listener),
    onLog: (listener: (entry: RunnerLogEntry) => void) =>
      subscribe(IPC_CHANNELS.eventRunnerLog, listener),
  }),
  settings: Object.freeze({
    get: noArgs<DesktopSettings>(IPC_CHANNELS.settingsGet),
    update: (patch: Partial<DesktopSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<DesktopSettings>,
  }),
  credentials: Object.freeze({
    hasRunnerToken: noArgs<boolean>(IPC_CHANNELS.credentialsHasRunnerToken),
    setRunnerToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.credentialsSetRunnerToken, token),
    clearRunnerToken: noArgs<void>(IPC_CHANNELS.credentialsClearRunnerToken),
    enrollRunner: (request: import("./shared/contracts.js").RunnerEnrollmentRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsEnrollRunner, request) as Promise<
        import("./shared/contracts.js").RunnerEnrollmentResult
      >,
  }),
  schedules: Object.freeze({
    open: noArgs<void>(IPC_CHANNELS.schedulesOpen),
  }),
  navigation: Object.freeze({
    onRequest: (listener: (request: DesktopNavigationRequest) => void) =>
      subscribe(IPC_CHANNELS.eventNavigate, listener),
  }),
});

contextBridge.exposeInMainWorld("sloppyPotatoDesktop", desktopApi);
