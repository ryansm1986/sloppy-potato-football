import type { RunnerLogEntry, RunnerStatus } from "../shared/contracts.js";

export interface RunnerController {
  getStatus(): Promise<RunnerStatus>;
  start(): Promise<RunnerStatus>;
  pauseAfterCurrent(): Promise<RunnerStatus>;
  resume(): Promise<RunnerStatus>;
  stop(): Promise<RunnerStatus>;
  runNext(): Promise<RunnerStatus>;
  getLogs(limit: number): Promise<RunnerLogEntry[]>;
  onStatus(listener: (status: RunnerStatus) => void): () => void;
  onLog(listener: (entry: RunnerLogEntry) => void): () => void;
  dispose(): Promise<void>;
}

const unavailableStatus: RunnerStatus = {
  state: "offline",
  detail: "Desktop runner service is not connected.",
  queuedJobs: 0,
};

/** Safe placeholder used until the existing runner is wired into the shell. */
export class UnavailableRunnerController implements RunnerController {
  async getStatus(): Promise<RunnerStatus> {
    return unavailableStatus;
  }

  async start(): Promise<RunnerStatus> {
    throw new Error("Desktop runner service is not connected.");
  }

  async pauseAfterCurrent(): Promise<RunnerStatus> {
    throw new Error("Desktop runner service is not connected.");
  }

  async resume(): Promise<RunnerStatus> {
    throw new Error("Desktop runner service is not connected.");
  }

  async stop(): Promise<RunnerStatus> {
    return unavailableStatus;
  }

  async runNext(): Promise<RunnerStatus> {
    throw new Error("Desktop runner service is not connected.");
  }

  async getLogs(_limit: number): Promise<RunnerLogEntry[]> {
    return [];
  }

  onStatus(_listener: (status: RunnerStatus) => void): () => void {
    return () => undefined;
  }

  onLog(_listener: (entry: RunnerLogEntry) => void): () => void {
    return () => undefined;
  }

  async dispose(): Promise<void> {}
}
