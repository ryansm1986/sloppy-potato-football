import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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
const RESEARCH_RESULT_SCHEMA_FILE = "research-result.schema.json";
export const RESEARCH_CODEX_MODEL = "gpt-5.6-luna";

export function resolveResearchResultSchemaPath(
  moduleUrl = import.meta.url,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
): string {
  const adjacentPath = fileURLToPath(new URL(`./schemas/${RESEARCH_RESULT_SCHEMA_FILE}`, moduleUrl));
  const asarSegment = `${sep}app.asar${sep}`;
  if (!adjacentPath.toLowerCase().includes(asarSegment.toLowerCase())) return adjacentPath;
  if (!resourcesPath) throw new Error("Packaged desktop resources path is unavailable");
  return resolve(resourcesPath, "schemas", RESEARCH_RESULT_SCHEMA_FILE);
}

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

export function summarizeCodexFailure(stderr: string, stdout: string, exitCode: number): string {
  const output = redact(stderr || stdout).trim();
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const diagnostic = [...lines].reverse().find((line) => /^(?:error|fatal|failed)\b/iu.test(line));
  if (diagnostic) return diagnostic.slice(0, 500);
  return `process exited with code ${exitCode}`;
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
  const schemaPath = resolveResearchResultSchemaPath();
  const outputPath = resolve(config.workspace, `result-${job.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);
  await rm(outputPath, { force: true });
  const invocation = resolveCodexInvocation();
  const args = [
    ...invocation.prefixArgs,
    "--search", "exec", "--ignore-user-config", "--ignore-rules",
    "--model", RESEARCH_CODEX_MODEL,
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
    const detail = summarizeCodexFailure(stderr, stdout, exitCode);
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
