import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_SETTINGS,
  SecureConfigStore,
  sanitizeSettingsPatch,
  type CredentialCipher,
  type FileDataAdapter,
} from "./config-store.js";

class MemoryFile implements FileDataAdapter {
  constructor(public value: string | null = null) {}
  async read() {
    return this.value;
  }
  async writeAtomically(value: string) {
    this.value = value;
  }
}

const testCipher: CredentialCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`protected:${value}`).toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString().replace(/^protected:/, ""),
};

describe("SecureConfigStore", () => {
  it("stores credentials encrypted and never exposes them with settings", async () => {
    const file = new MemoryFile();
    const store = new SecureConfigStore(file, testCipher);
    await store.initialize();
    await store.setRunnerToken("very-secret-token-that-is-long-enough");

    expect(file.value).not.toContain("very-secret-token-that-is-long-enough");
    expect(store.getSettings()).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(store.hasRunnerToken()).toBe(true);

    const restored = new SecureConfigStore(file, testCipher);
    await restored.initialize();
    expect(restored.getRunnerToken()).toBe("very-secret-token-that-is-long-enough");
    expect(restored.getInstallationId()).toBe(store.getInstallationId());
  });

  it("creates a stable identity that is distinct for each installation", async () => {
    const firstFile = new MemoryFile();
    const first = new SecureConfigStore(firstFile, testCipher);
    const second = new SecureConfigStore(new MemoryFile(), testCipher);
    await Promise.all([first.initialize(), second.initialize()]);

    expect(first.getInstallationId()).not.toBe(second.getInstallationId());

    const restored = new SecureConfigStore(firstFile, testCipher);
    await restored.initialize();
    expect(restored.getInstallationId()).toBe(first.getInstallationId());
  });

  it("refuses to persist secrets when OS encryption is unavailable", async () => {
    const store = new SecureConfigStore(new MemoryFile(), {
      isAvailable: () => false,
      encrypt: () => "",
      decrypt: () => "",
    });
    await store.initialize();
    await expect(store.setRunnerToken("a-secure-runner-token-that-is-long-enough")).rejects.toThrow(/unavailable/);
  });

  it("rejects unknown settings and insecure remote API URLs", () => {
    expect(() => sanitizeSettingsPatch({ surprise: true })).toThrow(/Unknown/);
    expect(() => sanitizeSettingsPatch({ apiBaseUrl: "http://example.com" })).toThrow(/HTTPS/);
  });
});
