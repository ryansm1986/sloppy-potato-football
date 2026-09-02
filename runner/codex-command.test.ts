import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexInvocation } from "./codex-command.js";
import { codexChildEnvironment } from "./codex.js";

describe("Codex command resolution", () => {
  it("uses the native command on non-Windows systems", () => {
    expect(resolveCodexInvocation({}, "linux")).toEqual({ command: "codex", prefixArgs: [] });
  });

  it("invokes an overridden JavaScript entrypoint through Node", () => {
    const path = resolve("tools", "codex.js");
    expect(resolveCodexInvocation({ CODEX_CLI_PATH: path }, "win32")).toEqual({
      command: process.execPath,
      prefixArgs: [path],
    });
  });

  it("runs a JavaScript Codex entrypoint through packaged Electron's Node mode", () => {
    const runtime = "C:\\Program Files\\Sloppy Potato\\Sloppy Potato Fantasy Football.exe";
    const invocation = { command: runtime, prefixArgs: ["C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.js"] };
    const environment = codexChildEnvironment(
      invocation,
      {
        PATH: "safe",
        AGENT_RUNNER_TOKEN: "must-not-leak",
        RESEARCH_OWNER_TOKEN: "must-not-leak-either",
        YAHOO_CLIENT_SECRET: "also-sensitive",
        NODE_OPTIONS: "--require untrusted.js",
      },
      true,
      runtime,
    );

    expect(environment.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(environment.AGENT_RUNNER_TOKEN).toBeUndefined();
    expect(environment.RESEARCH_OWNER_TOKEN).toBeUndefined();
    expect(environment.YAHOO_CLIENT_SECRET).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
  });

  it("does not add Electron runtime flags to native Codex executables", () => {
    const environment = codexChildEnvironment(
      { command: "codex.exe", prefixArgs: [] },
      { PATH: "safe", ELECTRON_RUN_AS_NODE: "1" },
      true,
      "C:\\Program Files\\Sloppy Potato\\Sloppy Potato Fantasy Football.exe",
    );

    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("combines JavaScript override resolution with the Electron runtime safely", () => {
    const entrypoint = resolve("tools", "codex.js");
    const originalExecPath = process.execPath;
    const invocation = resolveCodexInvocation({ CODEX_CLI_PATH: entrypoint }, "win32");

    expect(invocation).toEqual({ command: originalExecPath, prefixArgs: [entrypoint] });
    expect(codexChildEnvironment(invocation, { PATH: "safe" }, true, originalExecPath))
      .toMatchObject({ PATH: "safe", ELECTRON_RUN_AS_NODE: "1" });
  });
});
