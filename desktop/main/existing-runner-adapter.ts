import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type { RunnerConfig } from "../../runner/config.js";
import {
  RunnerController as CoreRunnerController,
  type RunnerControllerSnapshot,
} from "../../runner/runner.js";
import type { RunnerLogEntry, RunnerStatus } from "../shared/contracts.js";
import type { SecureConfigStore } from "./config-store.js";
import type { RunnerController } from "./runner-controller.js";

export function mapCoreSnapshot(snapshot: RunnerControllerSnapshot, pauseRequested = false): RunnerStatus {
  const state: RunnerStatus["state"] = {
    stopped: "offline",
    starting: "starting",
    idle: "idle",
    busy: pauseRequested ? "pausing" : "running",
    offline: "offline",
    paused: "paused",
    stopping: "stopping",
  }[snapshot.phase] as RunnerStatus["state"];

  return {
    state,
    detail:
      snapshot.phase === "stopped"
        ? "Runner is stopped."
        : snapshot.phase === "offline"
          ? "The runner cannot currently reach the research service."
          : undefined,
    currentJob: snapshot.currentJob
      ? {
          id: snapshot.currentJob.id,
          label: snapshot.currentJob.type.replaceAll("_", " "),
          startedAt: snapshot.currentJob.startedAt,
        }
      : undefined,
    queuedJobs: 0,
    lastHeartbeatAt: snapshot.updatedAt,
  };
}

export function desktopRunnerId(machineName: string, installationId: string): string {
  const machine = machineName.replace(/[^a-zA-Z0-9._-]/g, "-") || "windows";
  const installation = createHash("sha256").update(installationId).digest("hex").slice(0, 16);
  return `desktop-${machine}-${installation}`.slice(0, 100);
}

function mapLog(
  log: RunnerControllerSnapshot["recentLogs"][number],
  sequence: number,
): RunnerLogEntry {
  return {
    id: `${log.timestamp}-${sequence}-${randomUUID()}`,
    at: log.timestamp,
    level: log.level === "warning" ? "warn" : /completed/i.test(log.message) ? "success" : "info",
    message: log.message,
  };
}

/** Adapts the existing in-process runner without granting the renderer process access to it. */
export class ExistingRunnerAdapter implements RunnerController {
  private core: CoreRunnerController | null = null;
  private unsubscribeCore: (() => void) | null = null;
  private readonly statusListeners = new Set<(status: RunnerStatus) => void>();
  private readonly logListeners = new Set<(entry: RunnerLogEntry) => void>();
  private readonly logEntries: RunnerLogEntry[] = [];
  private readonly seenCoreLogs = new Set<string>();
  private pauseRequested = false;

  constructor(
    private readonly config: SecureConfigStore,
    private readonly userDataDirectory: string,
  ) {}

  async getStatus(): Promise<RunnerStatus> {
    if (!this.core) {
      return {
        state: "offline",
        detail: this.config.hasRunnerToken()
          ? "Runner is stopped."
          : "Add the desktop runner token in Settings to connect.",
        queuedJobs: 0,
      };
    }
    return mapCoreSnapshot(this.core.getSnapshot(), this.pauseRequested);
  }

  async start(): Promise<RunnerStatus> {
    const core = this.ensureCore();
    this.pauseRequested = false;
    await core.start();
    return this.getStatus();
  }

  async pauseAfterCurrent(): Promise<RunnerStatus> {
    if (!this.core) return this.getStatus();
    this.pauseRequested = true;
    this.core.pauseAfterCurrentJob();
    return this.getStatus();
  }

  async resume(): Promise<RunnerStatus> {
    const core = this.ensureCore();
    this.pauseRequested = false;
    await core.resume();
    return this.getStatus();
  }

  async stop(): Promise<RunnerStatus> {
    if (!this.core) return this.getStatus();
    this.pauseRequested = false;
    await this.core.stop();
    return this.getStatus();
  }

  async runNext(): Promise<RunnerStatus> {
    const core = this.ensureCore();
    this.pauseRequested = false;
    await core.runNextOnce();
    return this.getStatus();
  }

  async getLogs(limit: number): Promise<RunnerLogEntry[]> {
    return this.logEntries.slice(-limit).map((entry) => ({ ...entry }));
  }

  onStatus(listener: (status: RunnerStatus) => void): () => void {
    this.statusListeners.add(listener);
    void this.getStatus().then(listener);
    return () => this.statusListeners.delete(listener);
  }

  onLog(listener: (entry: RunnerLogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.core) {
      const result = await this.core.stop();
      if (result.deferredUntilCurrentJobFinishes) await this.core.waitUntilStopped();
    }
    this.unsubscribeCore?.();
    this.unsubscribeCore = null;
  }

  private ensureCore(): CoreRunnerController {
    if (this.core) return this.core;
    const token = this.config.getRunnerToken();
    if (!token) throw new Error("Add the desktop runner token in Settings before starting the runner.");

    const machine = hostname().replace(/[^a-zA-Z0-9._-]/g, "-") || "windows";
    const runnerConfig: RunnerConfig = {
      apiUrl: this.config.getSettings().apiBaseUrl,
      token,
      runnerId: desktopRunnerId(machine, this.config.getInstallationId()),
      runnerName: `${machine} Sloppy Potato desktop`.slice(0, 100),
      workspace: path.join(this.userDataDirectory, "runner-workspace"),
      pollIntervalMs: 15_000,
      jobTimeoutMs: 240_000,
      httpTimeoutMs: 15_000,
    };
    this.core = new CoreRunnerController(runnerConfig);
    this.unsubscribeCore = this.core.subscribe((snapshot) => this.handleSnapshot(snapshot));
    return this.core;
  }

  private handleSnapshot(snapshot: RunnerControllerSnapshot): void {
    if (snapshot.phase === "paused" || snapshot.phase === "stopped") this.pauseRequested = false;
    const newLogs = snapshot.recentLogs.filter(
      (log) => !this.seenCoreLogs.has(`${log.timestamp}\0${log.level}\0${log.message}`),
    );
    for (const [index, log] of newLogs.entries()) {
      this.seenCoreLogs.add(`${log.timestamp}\0${log.level}\0${log.message}`);
      const entry = mapLog(log, this.logEntries.length + index);
      this.logEntries.push(entry);
      if (this.logEntries.length > 500) this.logEntries.splice(0, this.logEntries.length - 500);
      for (const listener of this.logListeners) listener({ ...entry });
    }
    if (this.seenCoreLogs.size > 1_000) {
      const retained = new Set(
        snapshot.recentLogs.map((log) => `${log.timestamp}\0${log.level}\0${log.message}`),
      );
      this.seenCoreLogs.clear();
      for (const key of retained) this.seenCoreLogs.add(key);
    }
    const status = mapCoreSnapshot(snapshot, this.pauseRequested);
    for (const listener of this.statusListeners) listener(status);
  }
}
