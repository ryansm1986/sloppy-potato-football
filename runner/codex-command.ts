import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type CodexInvocation = {
  command: string;
  prefixArgs: string[];
};

export function resolveCodexInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): CodexInvocation {
  const override = environment.CODEX_CLI_PATH?.trim();
  if (override) {
    const path = isAbsolute(override) ? override : resolve(override);
    return path.toLowerCase().endsWith(".js")
      ? { command: process.execPath, prefixArgs: [path] }
      : { command: path, prefixArgs: [] };
  }

  if (platform === "win32" && environment.APPDATA) {
    const npmEntry = join(environment.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(npmEntry)) return { command: process.execPath, prefixArgs: [npmEntry] };
    return { command: "codex.exe", prefixArgs: [] };
  }

  return { command: "codex", prefixArgs: [] };
}
