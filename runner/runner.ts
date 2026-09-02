import type { RunnerConfig } from "./config.js";
import { CodexExecutionError, executeCodexJob, type SpawnImplementation } from "./codex.js";
import { RunnerApiClient, RunnerAuthenticationError } from "./api-client.js";
import { acquireRunnerInstanceLock, type RunnerInstanceLock } from "./instance-lock.js";
import { redact } from "./redact.js";
import type { ResearchJob } from "./schemas.js";

export type RunnerDependencies = {
  api?: RunnerApiClient;
  spawn?: SpawnImplementation;
  log?: (message: string) => void;
};

type JobLifecycle = {
  signal?: AbortSignal;
  onJobStarted?: (job: ResearchJob) => void;
  onJobFinished?: (job: ResearchJob) => void;
};

export async function runOneJob(
  config: RunnerConfig,
  dependencies: RunnerDependencies = {},
  lifecycle: JobLifecycle = {},
): Promise<boolean> {
  const api = dependencies.api ?? new RunnerApiClient(config);
  const log = dependencies.log ?? console.log;
  await api.heartbeat("idle", lifecycle.signal);
  const job = await api.claim(lifecycle.signal);
  if (!job) return false;
  lifecycle.onJobStarted?.(job);
  log(`Claimed ${job.type} job ${job.id} (attempt ${job.attempt}).`);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await api.heartbeat("busy");
    heartbeat = setInterval(() => {
      void api.heartbeat("busy").catch((error) => log(`Heartbeat warning: ${redact(error)}`));
    }, 30_000);
    heartbeat.unref();
    const result = await executeCodexJob(config, job, dependencies.spawn);
    await api.complete(job.id, job.leaseToken, result);
    log(`Completed job ${job.id}.`);
  } catch (error) {
    const failure = error instanceof CodexExecutionError
      ? { code: error.code, message: redact(error).slice(0, 1_000), retryable: error.retryable && job.attempt < job.maxAttempts }
      : { code: "RUNNER_ERROR", message: redact(error).slice(0, 1_000), retryable: job.attempt < job.maxAttempts };
    await api.fail(job.id, job.leaseToken, failure);
    log(`Failed job ${job.id}: ${failure.message}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await api.heartbeat("idle").catch((error) => log(`Heartbeat warning: ${redact(error)}`));
    lifecycle.onJobFinished?.(job);
  }
  return true;
}

export async function runForever(config: RunnerConfig, dependencies: RunnerDependencies = {}): Promise<void> {
  const api = dependencies.api ?? new RunnerApiClient(config);
  const log = dependencies.log ?? console.log;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`Runner ${config.runnerId} is polling ${config.apiUrl}.`);
  try {
    while (!stopping) {
      try {
        const processed = await runOneJob(config, { ...dependencies, api, log });
        if (processed) continue;
      } catch (error) {
        if (error instanceof RunnerAuthenticationError) {
          log(error.message);
          break;
        }
        log(`Polling warning: ${redact(error)}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, config.pollIntervalMs));
    }
  } finally {
    await api.heartbeat("stopping").catch(() => undefined);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export type RunnerControllerPhase =
  | "stopped"
  | "starting"
  | "idle"
  | "busy"
  | "offline"
  | "error"
  | "paused"
  | "stopping";

export type RunnerCurrentJob = {
  id: string;
  type: ResearchJob["type"];
  attempt: number;
  maxAttempts: number;
  startedAt: string;
};

export type RunnerLogEntry = {
  timestamp: string;
  level: "info" | "warning";
  message: string;
};

export type RunnerControllerSnapshot = {
  phase: RunnerControllerPhase;
  currentJob: RunnerCurrentJob | null;
  recentLogs: readonly RunnerLogEntry[];
  startedAt: string | null;
  updatedAt: string;
};

export type RunnerStopResult = {
  stopped: boolean;
  deferredUntilCurrentJobFinishes: boolean;
};

export type RunnerControllerDependencies = RunnerDependencies & {
  acquireLock?: (config: Pick<RunnerConfig, "runnerId" | "workspace">) => Promise<RunnerInstanceLock>;
  now?: () => Date;
  maximumLogs?: number;
};

type SnapshotListener = (snapshot: RunnerControllerSnapshot) => void;

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * A narrow, in-process control surface for desktop hosts. It intentionally exposes
 * lifecycle operations only: no shell execution, environment access, or bearer token.
 */
export class RunnerController {
  private readonly api: RunnerApiClient;
  private readonly acquireLock: NonNullable<RunnerControllerDependencies["acquireLock"]>;
  private readonly now: () => Date;
  private readonly maximumLogs: number;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly logs: RunnerLogEntry[] = [];
  private phase: RunnerControllerPhase = "stopped";
  private currentJob: RunnerCurrentJob | null = null;
  private startedAt: string | null = null;
  private updatedAt: string;
  private lock: RunnerInstanceLock | null = null;
  private loopPromise: Promise<void> | null = null;
  private initializationPromise: Promise<void> | null = null;
  private operationAbort: AbortController | null = null;
  private wakeLoop: (() => void) | null = null;
  private wakePending = false;
  private automatic = false;
  private authenticationBlocked = false;
  private stopRequested = false;
  private manualRequest: { resolve: (processed: boolean) => void; reject: (error: unknown) => void } | null = null;

  constructor(
    private readonly config: RunnerConfig,
    private readonly dependencies: RunnerControllerDependencies = {},
  ) {
    this.api = dependencies.api ?? new RunnerApiClient(config);
    this.acquireLock = dependencies.acquireLock ?? acquireRunnerInstanceLock;
    this.now = dependencies.now ?? (() => new Date());
    this.maximumLogs = Math.max(1, Math.min(dependencies.maximumLogs ?? 100, 500));
    this.updatedAt = this.now().toISOString();
  }

  getSnapshot(): RunnerControllerSnapshot {
    return {
      phase: this.phase,
      currentJob: this.currentJob ? { ...this.currentJob } : null,
      recentLogs: this.logs.map((entry) => ({ ...entry })),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.stopRequested && (this.loopPromise || this.initializationPromise)) {
      throw new Error("Runner is stopping; wait until it has stopped before starting it again.");
    }
    const shouldWake = this.loopPromise !== null || this.initializationPromise !== null;
    this.automatic = true;
    this.authenticationBlocked = false;
    await this.ensureLoop();
    if (shouldWake) this.wake();
  }

  async resume(): Promise<void> {
    await this.start();
  }

  pauseAfterCurrentJob(): void {
    if (!this.loopPromise) return;
    this.automatic = false;
    this.record("Runner will pause after the current job.");
    if (!this.currentJob) this.interruptSafeOperation();
    this.wake();
  }

  async runNextOnce(): Promise<boolean> {
    if (this.manualRequest) throw new Error("A run-next request is already pending.");
    if (this.stopRequested && (this.loopPromise || this.initializationPromise)) throw new Error("Runner is stopping.");
    this.automatic = false;
    this.authenticationBlocked = false;
    await this.ensureLoop();
    return new Promise<boolean>((resolve, reject) => {
      this.manualRequest = { resolve, reject };
      this.record("Run-next requested.");
      if (!this.currentJob) this.interruptSafeOperation();
      this.wake();
    });
  }

  async stop(): Promise<RunnerStopResult> {
    this.automatic = false;
    if (this.initializationPromise) await this.initializationPromise;
    if (!this.loopPromise) return { stopped: true, deferredUntilCurrentJobFinishes: false };
    this.stopRequested = true;
    const deferred = this.currentJob !== null;
    this.setPhase("stopping");
    this.record(deferred
      ? "Stop requested; the claimed job will finish before shutdown."
      : "Stopping runner.");
    if (!deferred) this.interruptSafeOperation();
    this.wake();
    if (!deferred) await this.loopPromise;
    return { stopped: !deferred, deferredUntilCurrentJobFinishes: deferred };
  }

  async waitUntilStopped(): Promise<void> {
    await this.initializationPromise;
    await this.loopPromise;
  }

  private async ensureLoop(): Promise<void> {
    if (this.loopPromise) return;
    if (!this.initializationPromise) {
      this.stopRequested = false;
      this.initializationPromise = this.beginLoop().finally(() => {
        this.initializationPromise = null;
      });
    }
    await this.initializationPromise;
  }

  private async beginLoop(): Promise<void> {
    this.setPhase("starting");
    try {
      this.lock = await this.acquireLock(this.config);
    } catch (error) {
      this.setPhase("stopped");
      throw error;
    }
    this.startedAt = this.now().toISOString();
    this.record(`Runner ${this.config.runnerId} is ready.`);
    this.loopPromise = this.loop().finally(async () => {
      this.operationAbort = null;
      const manual = this.manualRequest;
      this.manualRequest = null;
      manual?.reject(new Error("Runner stopped before the run-next request completed."));
      await this.api.heartbeat("stopping").catch(() => undefined);
      try {
        await this.lock?.release();
      } catch (error) {
        this.record(`Runner lock release warning: ${redact(error)}`, "warning");
      } finally {
        this.lock = null;
        this.loopPromise = null;
        this.wakePending = false;
        this.currentJob = null;
        this.startedAt = null;
        this.setPhase("stopped");
        this.record("Runner stopped.");
      }
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.authenticationBlocked) {
        this.setPhase("error");
        await this.waitForWake();
        continue;
      }
      if (!this.automatic && !this.manualRequest) {
        this.setPhase("paused");
        await this.waitForWake();
        continue;
      }

      const isManualRun = this.manualRequest !== null;
      this.setPhase("idle");
      this.operationAbort = new AbortController();
      try {
        const processed = await runOneJob(
          this.config,
          { ...this.dependencies, api: this.api, log: (message) => this.record(message) },
          {
            signal: this.operationAbort.signal,
            onJobStarted: (job) => {
              this.currentJob = {
                id: job.id,
                type: job.type,
                attempt: job.attempt,
                maxAttempts: job.maxAttempts,
                startedAt: this.now().toISOString(),
              };
              this.setPhase("busy");
            },
            onJobFinished: () => {
              this.currentJob = null;
              if (this.stopRequested) this.setPhase("stopping");
            },
          },
        );
        if (isManualRun) this.finishManualRequest(processed);
        if (processed && this.automatic) continue;
      } catch (error) {
        if (error instanceof RunnerAuthenticationError) {
          this.automatic = false;
          this.authenticationBlocked = true;
          this.setPhase("error");
          this.record(error.message, "warning");
          if (isManualRun) this.finishManualRequest(false);
        } else if (!isAbort(error)) {
          this.setPhase("offline");
          this.record(`Polling warning: ${redact(error)}`, "warning");
          if (isManualRun) this.finishManualRequest(false);
        }
      } finally {
        this.operationAbort = null;
      }

      if (this.stopRequested) break;
      if (!this.automatic) continue;
      await this.waitForWake(this.config.pollIntervalMs);
    }
  }

  private finishManualRequest(processed: boolean): void {
    const request = this.manualRequest;
    this.manualRequest = null;
    request?.resolve(processed);
  }

  private interruptSafeOperation(): void {
    this.operationAbort?.abort();
  }

  private wake(): void {
    if (this.wakeLoop) {
      this.wakeLoop();
      this.wakeLoop = null;
      return;
    }
    this.wakePending = true;
  }

  private async waitForWake(timeoutMs?: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return;
    }
    await new Promise<void>((resolveWake) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (this.wakeLoop === finish) this.wakeLoop = null;
        resolveWake();
      };
      this.wakeLoop = finish;
      if (timeoutMs !== undefined) {
        timer = setTimeout(finish, timeoutMs);
        timer.unref();
      }
    });
  }

  private setPhase(phase: RunnerControllerPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private record(message: string, level: RunnerLogEntry["level"] = "info"): void {
    const safe = redact(message).split(this.config.token).join("[REDACTED]");
    this.logs.push({ timestamp: this.now().toISOString(), level, message: safe });
    if (this.logs.length > this.maximumLogs) this.logs.splice(0, this.logs.length - this.maximumLogs);
    this.dependencies.log?.(safe);
    this.emit();
  }

  private emit(): void {
    this.updatedAt = this.now().toISOString();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
