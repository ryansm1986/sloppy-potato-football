import type { RunnerConfig } from "./config.js";
import { CodexExecutionError, executeCodexJob, type SpawnImplementation } from "./codex.js";
import { RunnerApiClient } from "./api-client.js";
import { redact } from "./redact.js";

export type RunnerDependencies = {
  api?: RunnerApiClient;
  spawn?: SpawnImplementation;
  log?: (message: string) => void;
};

export async function runOneJob(config: RunnerConfig, dependencies: RunnerDependencies = {}): Promise<boolean> {
  const api = dependencies.api ?? new RunnerApiClient(config);
  const log = dependencies.log ?? console.log;
  await api.heartbeat("idle");
  const job = await api.claim();
  if (!job) return false;
  log(`Claimed ${job.type} job ${job.id} (attempt ${job.attempt}).`);
  await api.heartbeat("busy");
  const heartbeat = setInterval(() => {
    void api.heartbeat("busy").catch((error) => log(`Heartbeat warning: ${redact(error)}`));
  }, 30_000);
  heartbeat.unref();
  try {
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
    clearInterval(heartbeat);
    await api.heartbeat("idle").catch((error) => log(`Heartbeat warning: ${redact(error)}`));
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
