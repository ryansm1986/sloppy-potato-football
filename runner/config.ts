import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  SLOPPY_POTATO_API_URL: z.string().url(),
  AGENT_RUNNER_TOKEN: z.string().min(32),
  RUNNER_ID: z.string().trim().min(3).max(100),
  RUNNER_NAME: z.string().trim().min(1).max(100),
  RUNNER_WORKSPACE: z.string().min(1),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000),
  RUNNER_JOB_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(280_000),
  RUNNER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000),
});

export type RunnerConfig = {
  apiUrl: string;
  token: string;
  runnerId: string;
  runnerName: string;
  workspace: string;
  pollIntervalMs: number;
  jobTimeoutMs: number;
  httpTimeoutMs: number;
};

export function loadRunnerEnv(path = resolve(".env.runner")): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const machineName = hostname().replace(/[^a-zA-Z0-9._-]/g, "-") || "local";
  const parsed = configSchema.parse({
    SLOPPY_POTATO_API_URL: environment.SLOPPY_POTATO_API_URL ?? "https://sloppy-potato-fantasy-football.therealryansmith.workers.dev",
    AGENT_RUNNER_TOKEN: environment.AGENT_RUNNER_TOKEN,
    RUNNER_ID: environment.RUNNER_ID ?? `codex-${machineName}`,
    RUNNER_NAME: environment.RUNNER_NAME ?? `${machineName} Codex runner`,
    RUNNER_WORKSPACE: environment.RUNNER_WORKSPACE ?? join(tmpdir(), "sloppy-potato-runner-workspace"),
    RUNNER_POLL_INTERVAL_MS: environment.RUNNER_POLL_INTERVAL_MS ?? "15000",
    RUNNER_JOB_TIMEOUT_MS: environment.RUNNER_JOB_TIMEOUT_MS ?? "240000",
    RUNNER_HTTP_TIMEOUT_MS: environment.RUNNER_HTTP_TIMEOUT_MS ?? "15000",
  });
  const workspace = isAbsolute(parsed.RUNNER_WORKSPACE)
    ? parsed.RUNNER_WORKSPACE
    : resolve(parsed.RUNNER_WORKSPACE);
  return {
    apiUrl: parsed.SLOPPY_POTATO_API_URL.replace(/\/$/, ""),
    token: parsed.AGENT_RUNNER_TOKEN,
    runnerId: parsed.RUNNER_ID,
    runnerName: parsed.RUNNER_NAME,
    workspace,
    pollIntervalMs: parsed.RUNNER_POLL_INTERVAL_MS,
    jobTimeoutMs: parsed.RUNNER_JOB_TIMEOUT_MS,
    httpTimeoutMs: parsed.RUNNER_HTTP_TIMEOUT_MS,
  };
}
