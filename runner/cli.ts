import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { RunnerApiClient } from "./api-client.js";
import { resolveCodexInvocation } from "./codex-command.js";
import { assertIsolatedWorkspace } from "./codex.js";
import { loadRunnerEnv, readConfig } from "./config.js";
import { runWithRunnerInstanceLock } from "./instance-lock.js";
import { redact } from "./redact.js";
import { RunnerController, runOneJob } from "./runner.js";

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
    return runWithRunnerInstanceLock(config, async () => {
      const processed = await runOneJob(config);
      if (!processed) console.log("No approved research jobs are queued.");
    });
  }
  if (command === "run") {
    const controller = new RunnerController(config, { log: console.log });
    const onSigint = () => {
      process.exitCode = 130;
      void controller.stop();
    };
    const onSigterm = () => {
      process.exitCode = 143;
      void controller.stop();
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
      await controller.start();
      await controller.waitUntilStopped();
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
    return;
  }
  throw new Error("Usage: pnpm runner:doctor | pnpm runner:once | pnpm runner");
}

main().catch((error) => {
  console.error(`Runner stopped: ${redact(error)}`);
  process.exitCode = 1;
});
