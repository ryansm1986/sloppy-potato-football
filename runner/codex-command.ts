import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

export type CodexInvocation = {
  command: string;
  prefixArgs: string[];
};

type FileExists = (path: string) => boolean;

function resolveWindowsNativeCodex(
  packageRoot: string,
  architecture: string,
  fileExists: FileExists,
): string | undefined {
  const target = architecture === "arm64"
    ? { packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" }
    : { packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  const candidates = [
    win32.join(packageRoot, "node_modules", "@openai", target.packageName, "vendor", target.triple, "bin", "codex.exe"),
    win32.join(packageRoot, "vendor", target.triple, "bin", "codex.exe"),
  ];
  return candidates.find(fileExists);
}

export function resolveCodexInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  architecture = process.arch,
  fileExists: FileExists = existsSync,
): CodexInvocation {
  const override = environment.CODEX_CLI_PATH?.trim();
  if (override) {
    const path = isAbsolute(override) ? override : resolve(override);
    if (platform === "win32" && path.toLowerCase().endsWith(".js")) {
      const nativeCommand = resolveWindowsNativeCodex(dirname(dirname(path)), architecture, fileExists);
      if (nativeCommand) return { command: nativeCommand, prefixArgs: [] };
      return { command: "codex.exe", prefixArgs: [] };
    }
    return path.toLowerCase().endsWith(".js")
      ? { command: process.execPath, prefixArgs: [path] }
      : { command: path, prefixArgs: [] };
  }

  if (platform === "win32" && environment.APPDATA) {
    const packageRoot = win32.join(environment.APPDATA, "npm", "node_modules", "@openai", "codex");
    const nativeCommand = resolveWindowsNativeCodex(packageRoot, architecture, fileExists);
    if (nativeCommand) return { command: nativeCommand, prefixArgs: [] };
    return { command: "codex.exe", prefixArgs: [] };
  }

  return { command: "codex", prefixArgs: [] };
}
