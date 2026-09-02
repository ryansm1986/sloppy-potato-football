import { randomUUID } from "node:crypto";
import type { DesktopSettings } from "../shared/contracts.js";
import { normalizeApiBaseUrl } from "./security.js";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeToTray: true,
  launchAtStartup: false,
  notificationsEnabled: true,
  apiBaseUrl: "https://sloppy-potato-fantasy-football.therealryansmith.workers.dev",
};

export interface DesktopCredentials {
  runnerToken?: string;
}

export interface FileDataAdapter {
  read(): Promise<string | null>;
  writeAtomically(value: string): Promise<void>;
}

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface PersistedDesktopData {
  version: 1;
  installationId?: string;
  settings: DesktopSettings;
  encryptedCredentials?: {
    runnerToken?: string;
  };
}

export function sanitizeSettings(
  value: Partial<DesktopSettings> | null | undefined,
  defaults = DEFAULT_DESKTOP_SETTINGS,
): DesktopSettings {
  const apiBaseUrl = normalizeApiBaseUrl(value?.apiBaseUrl ?? defaults.apiBaseUrl);
  return {
    closeToTray: typeof value?.closeToTray === "boolean" ? value.closeToTray : defaults.closeToTray,
    launchAtStartup:
      typeof value?.launchAtStartup === "boolean" ? value.launchAtStartup : defaults.launchAtStartup,
    notificationsEnabled:
      typeof value?.notificationsEnabled === "boolean"
        ? value.notificationsEnabled
        : defaults.notificationsEnabled,
    apiBaseUrl,
  };
}

export function sanitizeSettingsPatch(value: unknown): Partial<DesktopSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings update must be an object.");
  }

  const source = value as Record<string, unknown>;
  const allowed = new Set<keyof DesktopSettings>([
    "closeToTray",
    "launchAtStartup",
    "notificationsEnabled",
    "apiBaseUrl",
  ]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key as keyof DesktopSettings)) throw new Error(`Unknown desktop setting: ${key}`);
  }

  const patch: Partial<DesktopSettings> = {};
  for (const key of ["closeToTray", "launchAtStartup", "notificationsEnabled"] as const) {
    if (key in source) {
      if (typeof source[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
      patch[key] = source[key];
    }
  }
  if ("apiBaseUrl" in source) {
    if (typeof source.apiBaseUrl !== "string") throw new Error("apiBaseUrl must be a string.");
    patch.apiBaseUrl = normalizeApiBaseUrl(source.apiBaseUrl);
  }
  return patch;
}

/**
 * Serializes public preferences and encrypted credentials. Credentials are never
 * returned by the public snapshot methods and are never persisted in plaintext.
 */
export class SecureConfigStore {
  private installationId = "";
  private settings = DEFAULT_DESKTOP_SETTINGS;
  private credentials: DesktopCredentials = {};
  private initialized = false;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly files: FileDataAdapter,
    private readonly cipher: CredentialCipher,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const raw = await this.files.read();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedDesktopData>;
        this.settings = sanitizeSettings(parsed.settings);
        if (typeof parsed.installationId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.installationId)) {
          this.installationId = parsed.installationId;
        }
        const encryptedToken = parsed.encryptedCredentials?.runnerToken;
        if (encryptedToken && this.cipher.isAvailable()) {
          this.credentials.runnerToken = this.cipher.decrypt(encryptedToken);
        }
      } catch {
        // A malformed or no-longer-decryptable file must not prevent app startup.
        this.settings = DEFAULT_DESKTOP_SETTINGS;
        this.credentials = {};
      }
    }
    const needsInstallationId = !this.installationId;
    if (needsInstallationId) this.installationId = randomUUID();
    this.initialized = true;
    // This local, non-secret ID distinguishes two computers even when they
    // happen to share the same host name and user-data path.
    if (needsInstallationId) await this.persist();
  }

  getInstallationId(): string {
    this.assertInitialized();
    return this.installationId;
  }

  getSettings(): DesktopSettings {
    this.assertInitialized();
    return { ...this.settings };
  }

  async updateSettings(value: unknown): Promise<DesktopSettings> {
    this.assertInitialized();
    const patch = sanitizeSettingsPatch(value);
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    await this.persist();
    return this.getSettings();
  }

  hasRunnerToken(): boolean {
    this.assertInitialized();
    return Boolean(this.credentials.runnerToken);
  }

  getRunnerToken(): string | undefined {
    this.assertInitialized();
    return this.credentials.runnerToken;
  }

  async setRunnerToken(token: string): Promise<void> {
    this.assertInitialized();
    const normalized = token.trim();
    if (normalized.length < 32 || normalized.length > 4096) {
      throw new Error("The runner token must be between 32 and 4096 characters.");
    }
    if (!this.cipher.isAvailable()) {
      throw new Error("Secure credential storage is unavailable on this computer.");
    }
    this.credentials.runnerToken = normalized;
    await this.persist();
  }

  async clearRunnerToken(): Promise<void> {
    this.assertInitialized();
    delete this.credentials.runnerToken;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const runnerToken = this.credentials.runnerToken;
    if (runnerToken && !this.cipher.isAvailable()) {
      throw new Error("Secure credential storage is unavailable on this computer.");
    }
    const data: PersistedDesktopData = {
      version: 1,
      installationId: this.installationId,
      settings: this.settings,
      encryptedCredentials: runnerToken ? { runnerToken: this.cipher.encrypt(runnerToken) } : undefined,
    };
    const serialized = JSON.stringify(data, null, 2);
    this.writeQueue = this.writeQueue.then(() => this.files.writeAtomically(serialized));
    await this.writeQueue;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Desktop config store has not been initialized.");
  }
}
