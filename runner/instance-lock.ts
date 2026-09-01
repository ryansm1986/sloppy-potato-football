import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RunnerConfig } from "./config.js";

export type RunnerLockMetadata = {
  pid: number;
  runnerId: string;
  startedAt: string;
  ownerId: string;
};

export type RunnerInstanceLock = {
  lockPath: string;
  metadata: RunnerLockMetadata;
  release: () => Promise<void>;
};

type LockOptions = {
  lockRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
  retries?: number;
  retryDelayMs?: number;
  initializationGraceMs?: number;
  now?: () => Date;
};

const DEFAULT_RETRIES = 12;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_INITIALIZATION_GRACE_MS = 1_000;

export class RunnerAlreadyRunningError extends Error {
  constructor(pid: number, runnerId: string) {
    super(`Runner ${runnerId} is already active in process ${pid}. Stop that process before starting another runner.`);
    this.name = "RunnerAlreadyRunningError";
  }
}

function normalizedWorkspace(workspace: string): string {
  const absolute = resolve(workspace);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function runnerLockPath(config: Pick<RunnerConfig, "runnerId" | "workspace">, lockRoot = resolve(tmpdir(), "sloppy-potato-runner-locks")): string {
  const identity = `${normalizedWorkspace(config.workspace)}\0${config.runnerId}`;
  const key = createHash("sha256").update(identity).digest("hex");
  return resolve(lockRoot, `${key}.lock`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isMetadata(value: unknown): value is RunnerLockMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunnerLockMetadata>;
  return Number.isSafeInteger(candidate.pid)
    && typeof candidate.runnerId === "string"
    && typeof candidate.startedAt === "string"
    && !Number.isNaN(Date.parse(candidate.startedAt))
    && typeof candidate.ownerId === "string"
    && candidate.ownerId.length > 0;
}

async function readMetadata(lockPath: string): Promise<RunnerLockMetadata | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8"));
    return isMetadata(value) ? value : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function directoryIsInitializing(lockPath: string, graceMs: number): Promise<boolean> {
  try {
    const details = await stat(lockPath);
    return Date.now() - details.mtimeMs < graceMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeIfOwned(lockPath: string, ownerId: string): Promise<void> {
  const current = await readMetadata(lockPath);
  if (current?.ownerId !== ownerId) return;
  await rm(lockPath, { recursive: true, force: true });
}

export async function acquireRunnerInstanceLock(
  config: Pick<RunnerConfig, "runnerId" | "workspace">,
  options: LockOptions = {},
): Promise<RunnerInstanceLock> {
  const lockRoot = options.lockRoot ?? resolve(tmpdir(), "sloppy-potato-runner-locks");
  const lockPath = runnerLockPath(config, lockRoot);
  const recoveryPath = `${lockPath}.recovery`;
  const alive = options.isProcessAlive ?? processIsAlive;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const initializationGraceMs = options.initializationGraceMs ?? DEFAULT_INITIALIZATION_GRACE_MS;
  const now = options.now ?? (() => new Date());
  await mkdir(lockRoot, { recursive: true });

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const metadata: RunnerLockMetadata = {
      pid: process.pid,
      runnerId: config.runnerId,
      startedAt: now().toISOString(),
      ownerId: randomUUID(),
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(resolve(lockPath, "owner.json"), `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        lockPath,
        metadata,
        release: async () => {
          if (released) return;
          await removeIfOwned(lockPath, metadata.ownerId);
          released = true;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readMetadata(lockPath);
    if (existing && alive(existing.pid)) {
      throw new RunnerAlreadyRunningError(existing.pid, existing.runnerId);
    }
    if (!existing && await directoryIsInitializing(lockPath, initializationGraceMs)) {
      if (attempt < retries) {
        await delay(retryDelayMs);
        continue;
      }
      throw new Error(`Runner ${config.runnerId} is currently acquiring its single-instance lock. Try again shortly.`);
    }

    let ownsRecovery = false;
    try {
      try {
        await mkdir(recoveryPath);
        ownsRecovery = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!ownsRecovery) {
        if (attempt < retries) {
          await delay(retryDelayMs);
          continue;
        }
        throw new Error(`Could not recover the stale lock for runner ${config.runnerId}; another process is already recovering it.`);
      }

      const latest = await readMetadata(lockPath);
      if (latest && alive(latest.pid)) {
        throw new RunnerAlreadyRunningError(latest.pid, latest.runnerId);
      }
      if (!latest && await directoryIsInitializing(lockPath, initializationGraceMs)) {
        if (attempt < retries) {
          await delay(retryDelayMs);
          continue;
        }
        throw new Error(`Runner ${config.runnerId} is currently acquiring its single-instance lock. Try again shortly.`);
      }
      await rm(lockPath, { recursive: true, force: true });
    } finally {
      if (ownsRecovery) await rm(recoveryPath, { recursive: true, force: true });
    }
  }

  throw new Error(`Could not acquire the single-instance lock for runner ${config.runnerId}.`);
}

export async function runWithRunnerInstanceLock<T>(
  config: Pick<RunnerConfig, "runnerId" | "workspace">,
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireRunnerInstanceLock(config);
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= lock.release();
  const exitAfterRelease = (exitCode: number) => {
    void release().finally(() => process.exit(exitCode));
  };
  const onSigint = () => exitAfterRelease(130);
  const onSigterm = () => exitAfterRelease(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await action();
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await release();
  }
}
