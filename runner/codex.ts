import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerConfig } from "./config.js";
import { resolveCodexInvocation } from "./codex-command.js";
import { buildResearchPrompt } from "./prompt.js";
import { redact, safeChildEnvironment } from "./redact.js";
import { researchResultSchema, type ResearchJob, type ResearchResult } from "./schemas.js";

export type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

const OUTPUT_LIMIT_BYTES = 1_000_000;

export function codexChildEnvironment(
  invocation: ReturnType<typeof resolveCodexInvocation>,
  environment: NodeJS.ProcessEnv = process.env,
  electronRuntime = Boolean(process.versions.electron),
  runtimeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const childEnvironment = safeChildEnvironment(environment);
  const launchesJavaScriptEntrypoint = invocation.command === runtimeExecutable
    && invocation.prefixArgs[0]?.toLowerCase().endsWith(".js");
  if (electronRuntime && launchesJavaScriptEntrypoint) {
    childEnvironment.ELECTRON_RUN_AS_NODE = "1";
  }
  return childEnvironment;
}

function assertIsolatedWorkspace(workspace: string, appDirectory = process.cwd()): void {
  const app = resolve(appDirectory).toLowerCase();
  const target = resolve(workspace).toLowerCase();
  const relation = relative(app, target);
  if (target === app || (!relation.startsWith("..") && !relation.startsWith("/"))) {
    throw new Error("RUNNER_WORKSPACE must be outside the application repository");
  }
}

function collectBounded(current: string, chunk: Buffer | string, maximum = 65_536): string {
  if (current.length >= maximum) return current;
  return (current + chunk.toString()).slice(0, maximum);
}

export class CodexExecutionError extends Error {
  constructor(
    message: string,
    readonly code: "CODEX_NOT_FOUND" | "CODEX_TIMEOUT" | "CODEX_FAILED" | "INVALID_RESULT",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodexExecutionError";
  }
}

export async function executeCodexJob(
  config: RunnerConfig,
  job: ResearchJob,
  spawnImplementation: SpawnImplementation = spawn,
): Promise<ResearchResult> {
  assertIsolatedWorkspace(config.workspace);
  await mkdir(config.workspace, { recursive: true });
  const schemaPath = fileURLToPath(new URL("./schemas/research-result.schema.json", import.meta.url));
  const outputPath = resolve(config.workspace, `result-${job.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);
  await rm(outputPath, { force: true });
  const invocation = resolveCodexInvocation();
  const args = [
    ...invocation.prefixArgs,
    "--search", "exec", "--ignore-user-config", "--ignore-rules",
    "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--output-schema", schemaPath, "-o", outputPath, "-",
  ] as const;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImplementation(invocation.command, args, {
      cwd: config.workspace,
      env: codexChildEnvironment(invocation),
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    throw new CodexExecutionError(`Could not start Codex: ${redact(error)}`, "CODEX_NOT_FOUND", false);
  }

  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout = collectBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = collectBounded(stderr, chunk); });
  child.stdin.end(buildResearchPrompt(job));

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref();
    }, config.jobTimeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectExit(new CodexExecutionError(`Could not start Codex: ${redact(error)}`, "CODEX_NOT_FOUND", false));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) rejectExit(new CodexExecutionError(`Codex exceeded the ${config.jobTimeoutMs}ms limit`, "CODEX_TIMEOUT", true));
      else resolveExit(code ?? 1);
    });
    });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }

  if (exitCode !== 0) {
    const detail = redact(stderr || stdout || `exit code ${exitCode}`).slice(0, 1_000);
    await rm(outputPath, { force: true });
    throw new CodexExecutionError(`Codex failed: ${detail}`, "CODEX_FAILED", true);
  }
  try {
    const statText = await readFile(outputPath, "utf8");
    if (Buffer.byteLength(statText, "utf8") > OUTPUT_LIMIT_BYTES) {
      throw new Error("result exceeds the 1 MB limit");
    }
    return researchResultSchema.parse(JSON.parse(statText) as unknown);
  } catch (error) {
    throw new CodexExecutionError(`Codex returned an invalid result: ${redact(error)}`, "INVALID_RESULT", true);
  } finally {
    await rm(outputPath, { force: true });
  }
}

export { assertIsolatedWorkspace };
