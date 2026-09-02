export type RunnerState =
  | "offline"
  | "starting"
  | "idle"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "error";

export interface RunnerStatus {
  state: RunnerState;
  detail?: string;
  currentJob?: {
    id: string;
    label: string;
    startedAt?: string;
  };
  queuedJobs: number;
  lastHeartbeatAt?: string;
}

export interface RunnerLogEntry {
  id: string;
  at: string;
  level: "debug" | "info" | "warn" | "error" | "success";
  message: string;
  jobId?: string;
}

export interface DesktopSettings {
  closeToTray: boolean;
  launchAtStartup: boolean;
  notificationsEnabled: boolean;
  apiBaseUrl: string;
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
  packaged: boolean;
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "unsupported";

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadPercent?: number;
  message?: string;
}

export interface DesktopNavigationRequest {
  path: "/research" | "/research/schedules";
}

export interface RunnerDeviceSummary {
  id: string;
  name: string;
}

export interface RunnerEnrollmentRequest {
  ownerToken: string;
  name: string;
}

export interface RunnerEnrollmentResult {
  device: RunnerDeviceSummary;
}

export const IPC_CHANNELS = {
  appInfo: "desktop:app-info",
  appShow: "desktop:app-show",
  appQuit: "desktop:app-quit",
  runnerStatus: "desktop:runner-status",
  runnerStart: "desktop:runner-start",
  runnerPause: "desktop:runner-pause",
  runnerResume: "desktop:runner-resume",
  runnerStop: "desktop:runner-stop",
  runnerRunNext: "desktop:runner-run-next",
  runnerLogs: "desktop:runner-logs",
  settingsGet: "desktop:settings-get",
  settingsUpdate: "desktop:settings-update",
  credentialsHasRunnerToken: "desktop:credentials-has-runner-token",
  credentialsSetRunnerToken: "desktop:credentials-set-runner-token",
  credentialsClearRunnerToken: "desktop:credentials-clear-runner-token",
  credentialsEnrollRunner: "desktop:credentials-enroll-runner",
  schedulesOpen: "desktop:schedules-open",
  updatesStatus: "desktop:updates-status",
  updatesCheck: "desktop:updates-check",
  updatesDownload: "desktop:updates-download",
  updatesRestart: "desktop:updates-restart",
  eventRunnerStatus: "desktop:event-runner-status",
  eventRunnerLog: "desktop:event-runner-log",
  eventNavigate: "desktop:event-navigate",
  eventUpdateStatus: "desktop:event-update-status",
} as const;

export interface SloppyPotatoDesktopApi {
  app: {
    info(): Promise<DesktopAppInfo>;
    show(): Promise<void>;
    quit(): Promise<void>;
  };
  runner: {
    status(): Promise<RunnerStatus>;
    start(): Promise<RunnerStatus>;
    pauseAfterCurrent(): Promise<RunnerStatus>;
    resume(): Promise<RunnerStatus>;
    stop(): Promise<RunnerStatus>;
    runNext(): Promise<RunnerStatus>;
    logs(limit?: number): Promise<RunnerLogEntry[]>;
    onStatus(listener: (status: RunnerStatus) => void): () => void;
    onLog(listener: (entry: RunnerLogEntry) => void): () => void;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    update(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  credentials: {
    hasRunnerToken(): Promise<boolean>;
    setRunnerToken(token: string): Promise<void>;
    clearRunnerToken(): Promise<void>;
    enrollRunner(request: RunnerEnrollmentRequest): Promise<RunnerEnrollmentResult>;
  };
  schedules: {
    open(): Promise<void>;
  };
  /** Present in desktop builds that support in-app updates. */
  updates?: {
    status(): Promise<DesktopUpdateStatus>;
    check(): Promise<DesktopUpdateStatus>;
    download(): Promise<DesktopUpdateStatus>;
    restart(): Promise<DesktopUpdateStatus>;
    onStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  };
  navigation: {
    onRequest(listener: (request: DesktopNavigationRequest) => void): () => void;
  };
}
