import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const environmentPath = resolve(".env.runner");

async function assertEnvironmentDoesNotExist(): Promise<void> {
  try {
    await access(environmentPath);
    throw new Error(".env.runner already exists. Remove it only if you intend to rotate the bridge credentials.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function putSecret(name: string, value: string): Promise<void> {
  const wranglerCli = resolve("node_modules", "wrangler", "bin", "wrangler.js");
  return new Promise((resolveSecret, rejectSecret) => {
    const child = spawn(process.execPath, [wranglerCli, "secret", "put", name], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", rejectSecret);
    child.once("close", (code) => {
      if (code === 0) resolveSecret();
      else rejectSecret(new Error(`Wrangler could not configure ${name} (exit ${code ?? "unknown"})`));
    });
    child.stdin.end(value);
  });
}

async function main(): Promise<void> {
  await assertEnvironmentDoesNotExist();
  const runnerToken = randomBytes(48).toString("base64url");
  const ownerToken = randomBytes(48).toString("base64url");
  console.log("Configuring scoped Cloudflare bridge secrets…");
  await putSecret("AGENT_RUNNER_TOKEN", runnerToken);
  await putSecret("RESEARCH_OWNER_TOKEN", ownerToken);
  const apiUrl = process.env.SLOPPY_POTATO_API_URL
    ?? "https://sloppy-potato-fantasy-football.therealryansmith.workers.dev";
  await writeFile(environmentPath, [
    `SLOPPY_POTATO_API_URL=${apiUrl}`,
    `AGENT_RUNNER_TOKEN=${runnerToken}`,
    `RESEARCH_OWNER_TOKEN=${ownerToken}`,
    "RUNNER_POLL_INTERVAL_MS=15000",
    "RUNNER_JOB_TIMEOUT_MS=240000",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log("Both scoped tokens were saved only in the gitignored .env.runner file.");
  console.log("Copy this owner token into the app's Research Desk setup:");
  console.log(ownerToken);
  console.log("Next: pnpm runner:doctor, then pnpm runner");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
