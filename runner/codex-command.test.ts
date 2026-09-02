import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCodexInvocation } from "./codex-command.js";
import { codexChildEnvironment, resolveResearchResultSchemaPath, summarizeCodexFailure } from "./codex.js";

describe("Codex command resolution", () => {
  it("keeps the adjacent schema path outside a packaged ASAR", () => {
    const modulePath = resolve("dist-desktop", "main", "entry.js");
    expect(resolveResearchResultSchemaPath(pathToFileURL(modulePath).href)).toBe(
      resolve("dist-desktop", "main", "schemas", "research-result.schema.json"),
    );
  });

  it("uses a physical resources path when the desktop bundle runs inside an ASAR", () => {
    const resourcesPath = resolve("test-install", "resources");
    const modulePath = resolve(resourcesPath, "app.asar", "dist-desktop", "main", "entry.js");
    expect(resolveResearchResultSchemaPath(pathToFileURL(modulePath).href, resourcesPath)).toBe(
      resolve(resourcesPath, "schemas", "research-result.schema.json"),
    );
  });

  it("uses the native command on non-Windows systems", () => {
    expect(resolveCodexInvocation({}, "linux")).toEqual({ command: "codex", prefixArgs: [] });
  });

  it("invokes an overridden JavaScript entrypoint through Node outside Windows", () => {
    const path = resolve("tools", "codex.js");
    expect(resolveCodexInvocation({ CODEX_CLI_PATH: path }, "linux")).toEqual({
      command: process.execPath,
      prefixArgs: [path],
    });
  });

  it("never falls back to an overridden JavaScript launcher on Windows", () => {
    const path = resolve("tools", "codex.js");
    expect(resolveCodexInvocation({ CODEX_CLI_PATH: path }, "win32", "x64", () => false)).toEqual({
      command: "codex.exe",
      prefixArgs: [],
    });
  });

  it("invokes the native Windows Codex binary directly so no console window is created", () => {
    const appData = "C:\\Users\\owner\\AppData\\Roaming";
    const expected = win32.join(
      appData,
      "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
    expect(resolveCodexInvocation(
      { APPDATA: appData },
      "win32",
      "x64",
      (path) => path.toLowerCase() === expected.toLowerCase(),
    )).toEqual({ command: expected, prefixArgs: [] });
  });

  it("resolves the native Windows ARM64 Codex binary", () => {
    const appData = "C:\\Users\\owner\\AppData\\Roaming";
    const expected = win32.join(
      appData,
      "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe",
    );
    expect(resolveCodexInvocation(
      { APPDATA: appData },
      "win32",
      "arm64",
      (path) => path.toLowerCase() === expected.toLowerCase(),
    )).toEqual({ command: expected, prefixArgs: [] });
  });

  it("does not fall back to the JavaScript launcher on Windows", () => {
    expect(resolveCodexInvocation(
      { APPDATA: "C:\\Users\\owner\\AppData\\Roaming" },
      "win32",
      "x64",
      () => false,
    )).toEqual({ command: "codex.exe", prefixArgs: [] });
  });

  it("keeps the runner prompt out of user-facing Codex failures", () => {
    const stderr = [
      "OpenAI Codex v0.152.1",
      "model: gpt-5.6-luna",
      "user",
      "You are the bounded fantasy-football research runner",
    ].join("\n");
    expect(summarizeCodexFailure(stderr, "", 1)).toBe("process exited with code 1");
    expect(summarizeCodexFailure(`${stderr}\nERROR: request failed`, "", 1)).toBe("ERROR: request failed");
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
    const invocation = resolveCodexInvocation({ CODEX_CLI_PATH: entrypoint }, "linux");

    expect(invocation).toEqual({ command: originalExecPath, prefixArgs: [entrypoint] });
    expect(codexChildEnvironment(invocation, { PATH: "safe" }, true, originalExecPath))
      .toMatchObject({ PATH: "safe", ELECTRON_RUN_AS_NODE: "1" });
  });
});
