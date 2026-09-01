import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { RunnerApiClient } from "./api-client.js";
import { resolveCodexInvocation } from "./codex-command.js";
import { assertIsolatedWorkspace } from "./codex.js";
import { loadRunnerEnv, readConfig } from "./config.js";
import { redact } from "./redact.js";
import { runForever, runOneJob } from "./runner.js";

const execFileAsync = promisify(execFile);

async function doctor(): Promise<void> {
  const config = readConfig();
  assertIsolatedWorkspace(config.workspace);
  await mkdir(config.workspace, { recursive: true });
  const invocation = resolveCodexInvocation();
  const version = await execFileAsync(invocation.command, [...invocation.prefixArgs, "--version"], { timeout: 15_000, windowsHide: true });
  const login = await execFileAsync(invocation.command, [...invocation.prefixArgs, "login", "status"], { timeout: 15_000, windowsHide: true });
  await new RunnerApiClient(config).health(AbortSignal.timeout(config.httpTimeoutMs));
  console.log(`Codex: ${version.stdout.trim()}`);
  console.log(`Authentication: ${login.stdout.trim() || login.stderr.trim()}`);
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Cloudflare API: reachable`);
  console.log("Bridge doctor checks passed. No research job was claimed.");
}

async function main(): Promise<void> {
  loadRunnerEnv();
  const command = process.argv[2] ?? "run";
  if (command === "doctor") return doctor();
  const config = readConfig();
  if (command === "once") {
    const processed = await runOneJob(config);
    if (!processed) console.log("No approved research jobs are queued.");
    return;
  }
  if (command === "run") return runForever(config);
  throw new Error("Usage: pnpm runner:doctor | pnpm runner:once | pnpm runner");
}

main().catch((error) => {
  console.error(`Runner stopped: ${redact(error)}`);
  process.exitCode = 1;
});
