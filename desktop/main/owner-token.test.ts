import { describe, expect, it } from "vitest";
import { normalizeResearchOwnerTokenInput } from "./owner-token.js";

const ownerToken = "owner_secret_" + "x".repeat(40);

describe("research owner token input", () => {
  it("accepts and trims a raw owner token", () => {
    expect(normalizeResearchOwnerTokenInput(`  ${ownerToken}  `)).toBe(ownerToken);
  });

  it.each([
    `RESEARCH_OWNER_TOKEN=${ownerToken}`,
    `RESEARCH_OWNER_TOKEN = ${ownerToken}`,
    `RESEARCH_OWNER_TOKEN="${ownerToken}"`,
    `RESEARCH_OWNER_TOKEN='${ownerToken}'`,
  ])("extracts the token from a copied environment assignment", (input) => {
    expect(normalizeResearchOwnerTokenInput(input)).toBe(ownerToken);
  });

  it.each([
    `AGENT_RUNNER_TOKEN=${ownerToken}`,
    `RESEARCH_OWNER_TOKEN=${ownerToken}\nAGENT_RUNNER_TOKEN=${ownerToken}`,
    `RESEARCH_OWNER_TOKEN="${ownerToken}`,
    "RESEARCH_OWNER_TOKEN=short",
    "",
  ])("rejects malformed, unrelated, or unsafe input without echoing it", (input) => {
    let message = "";
    try {
      normalizeResearchOwnerTokenInput(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Enter a valid owner token.");
    expect(message).not.toContain(ownerToken);
  });
});
