import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexInvocation } from "./codex-command.js";

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
});
