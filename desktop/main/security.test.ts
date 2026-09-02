import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSafeExternalUrl,
  isTrustedRendererUrl,
  normalizeApiBaseUrl,
  resolveRendererAsset,
} from "./security.js";

describe("desktop security helpers", () => {
  it("trusts only the application origin or the configured development origin", () => {
    expect(isTrustedRendererUrl("potato://app/rankings")).toBe(true);
    expect(isTrustedRendererUrl("https://evil.example/rankings")).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5173/research", "http://localhost:5173")).toBe(true);
    expect(isTrustedRendererUrl("http://localhost.evil.test:5173", "http://localhost:5173")).toBe(false);
  });

  it("opens only ordinary web links externally", () => {
    expect(isSafeExternalUrl("https://fantasypros.com/nfl/rankings")).toBe(true);
    expect(isSafeExternalUrl("mailto:test@example.com")).toBe(false);
    expect(isSafeExternalUrl("file:///C:/secrets.txt")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("contains renderer asset paths inside the bundled UI", () => {
    const root = path.resolve("C:/app/dist");
    expect(resolveRendererAsset(root, "/assets/app.js")).toBe(path.join(root, "assets", "app.js"));
    expect(resolveRendererAsset(root, "/%2e%2e/secrets.txt")).toBeNull();
    expect(resolveRendererAsset(root, "/bad%ZZ")).toBeNull();
  });

  it("requires a secure API except for local development", () => {
    expect(normalizeApiBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeApiBaseUrl("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(() => normalizeApiBaseUrl("http://example.com")).toThrow(/HTTPS/);
  });
});
