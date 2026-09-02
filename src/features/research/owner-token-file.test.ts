import { describe, expect, it } from "vitest";
import { readOwnerTokenFromEnvironmentFile } from "./owner-token-file";

const token = `owner_${"x".repeat(48)}`;

describe("owner token environment file", () => {
  it("extracts a single owner token without exposing the other values", async () => {
    const file = new File([
      `SLOPPY_POTATO_API_URL=https://example.test\nAGENT_RUNNER_TOKEN=runner-secret\nRESEARCH_OWNER_TOKEN=${token}\n`,
    ], ".env.runner", { type: "text/plain" });

    await expect(readOwnerTokenFromEnvironmentFile(file)).resolves.toBe(token);
  });

  it.each([
    "AGENT_RUNNER_TOKEN=not-the-owner-token\n",
    "RESEARCH_OWNER_TOKEN=short\n",
    `RESEARCH_OWNER_TOKEN=${token}\nRESEARCH_OWNER_TOKEN=${token}\n`,
  ])("rejects missing, malformed, or duplicate assignments", async (contents) => {
    const file = new File([contents], ".env.runner", { type: "text/plain" });
    await expect(readOwnerTokenFromEnvironmentFile(file)).rejects.toThrow(/does not contain a valid/i);
  });
});
