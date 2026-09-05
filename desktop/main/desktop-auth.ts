import type { DesktopAuthStatus, DesktopAuthUser } from "../shared/contracts.js";
import type { SecureConfigStore } from "./config-store.js";
import { normalizeApiBaseUrl } from "./security.js";

interface AuthOptions {
  config: SecureConfigStore;
  openExternal(url: string): Promise<unknown>;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sign-in response.");
  return value as Record<string, unknown>;
}

function parseUser(value: unknown): DesktopAuthUser {
  const user = record(value);
  if (typeof user.id !== "string" || typeof user.email !== "string" || (user.name !== null && typeof user.name !== "string")
    || !["owner", "researcher", "viewer"].includes(String(user.role))) throw new Error("Invalid sign-in response.");
  return { id: user.id, email: user.email, name: user.name, role: user.role as DesktopAuthUser["role"] };
}

export function verificationUrlForApi(value: unknown, apiBaseUrl: string): string {
  if (typeof value !== "string") throw new Error("Invalid sign-in destination.");
  const url = new URL(value);
  const base = new URL(normalizeApiBaseUrl(apiBaseUrl));
  if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith("/api/auth/")) {
    throw new Error("Invalid sign-in destination.");
  }
  return url.toString();
}

/** Browser handoff secrets, app sessions and role verification stay in the main process. */
export class DesktopAuthController {
  private current: DesktopAuthStatus = { mode: "legacy", configured: false, authenticated: false, phase: "idle" };
  private generation = 0;
  private pending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: AuthOptions) { this.fetcher = options.fetch ?? fetch; }

  private base(): string { return normalizeApiBaseUrl(this.options.config.getSettings().apiBaseUrl); }
  snapshot(): DesktopAuthStatus { return { ...this.current, ...(this.current.user ? { user: { ...this.current.user } } : {}) }; }
  getToken(apiBaseUrl: string): string | undefined { return this.options.config.getAppSessionToken(apiBaseUrl); }

  private async request(path: string, options: { base?: string; token?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return this.fetcher(new URL(path, options.base ?? this.base()), {
      method: options.body === undefined ? "GET" : "POST", headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error", cache: "no-store", credentials: "omit",
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  }

  private async verifiedStatus(base: string, token?: string, signal?: AbortSignal): Promise<DesktopAuthStatus> {
    const response = await this.request("/api/auth/session", { base, token, signal });
    if (response.status === 401) {
      if (token && token === this.getToken(base)) await this.options.config.clearAppSessionToken();
      return { mode: "google", configured: true, authenticated: false, phase: "idle" };
    }
    if (!response.ok) throw new Error("Sign-in status could not be verified. Check your connection and try again.");
    const body = record(await response.json());
    if ((body.mode !== "google" && body.mode !== "legacy") || typeof body.configured !== "boolean"
      || typeof body.authenticated !== "boolean") throw new Error("Invalid sign-in response.");
    if (!body.authenticated && token && token === this.getToken(base)) await this.options.config.clearAppSessionToken();
    return { mode: body.mode, configured: body.configured, authenticated: body.authenticated,
      ...(body.authenticated ? { user: parseUser(body.user) } : {}), phase: "idle" };
  }

  async status(): Promise<DesktopAuthStatus> {
    if (this.pending) return this.snapshot();
    const generation = this.generation;
    const base = this.base();
    try {
      const status = await this.verifiedStatus(base, this.getToken(base));
      if (generation === this.generation && base === this.base()) this.current = status;
    } catch {
      if (generation === this.generation) this.current = { ...this.current, authenticated: false, user: undefined,
        phase: "error", error: "Sign-in status could not be verified. Check your connection and try again." };
    }
    return this.snapshot();
  }

  /** Every control checks the server: a stale cached owner role never authorizes IPC. */
  async requireOwner(): Promise<DesktopAuthStatus> {
    const base = this.base();
    const generation = this.generation;
    const status = await this.verifiedStatus(base, this.getToken(base));
    if (base !== this.base() || generation !== this.generation) throw new Error("Sign-in changed. Verify access again.");
    if (status.mode === "google" && (!status.authenticated || status.user?.role !== "owner")) {
      throw new Error("Sign in as the app owner to manage this computer's runner.");
    }
    if (!this.pending) this.current = status;
    return status;
  }

  cancel(): DesktopAuthStatus {
    this.generation += 1;
    this.pending?.abort();
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.current = { ...this.current, phase: "idle", error: undefined };
    return this.snapshot();
  }

  async signIn(): Promise<DesktopAuthStatus> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = controller;
    const base = this.base();
    this.current = { ...this.current, phase: "opening", error: undefined };
    try {
      const response = await this.request("/api/auth/desktop/start", { base, body: {}, signal: controller.signal });
      if (!response.ok) throw new Error("Unable to start Google sign-in. Check that Google access is configured.");
      const body = record(await response.json());
      if (typeof body.requestId !== "string" || typeof body.deviceSecret !== "string"
        || typeof body.expiresAt !== "string") throw new Error("Invalid sign-in response.");
      const deadline = Math.min(Date.parse(body.expiresAt), Date.now() + 10 * 60_000);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("The sign-in request expired. Try again.");
      const url = verificationUrlForApi(body.verificationUrl, base);
      if (generation !== this.generation) return this.snapshot();
      await this.options.openExternal(url);
      if (generation !== this.generation) return this.snapshot();
      this.current = { ...this.current, mode: "google", phase: "waiting", error: undefined };
      this.schedulePoll(generation, controller, base, body.requestId, body.deviceSecret, deadline);
    } catch {
      if (generation === this.generation) {
        this.pending = undefined;
        this.current = { ...this.current, phase: "error", error: "Unable to open Google sign-in. Check your connection and Google configuration, then try again." };
      }
    }
    return this.snapshot();
  }

  private schedulePoll(generation: number, controller: AbortController, base: string, requestId: string, deviceSecret: string, deadline: number): void {
    this.timer = setTimeout(() => void this.poll(generation, controller, base, requestId, deviceSecret, deadline), this.options.pollIntervalMs ?? 2_000);
    this.timer.unref?.();
  }

  private async poll(generation: number, controller: AbortController, base: string, requestId: string, deviceSecret: string, deadline: number): Promise<void> {
    if (generation !== this.generation || controller.signal.aborted) return;
    let issuedToken: string | undefined;
    try {
      if (Date.now() >= deadline || base !== this.base()) throw new Error("Sign-in expired.");
      const response = await this.request("/api/auth/desktop/poll", { base, body: { requestId, deviceSecret }, signal: controller.signal });
      if (!response.ok) throw new Error("Sign-in expired or unavailable.");
      const body = record(await response.json());
      if (body.status === "approved" && typeof body.token === "string" && /^sp_session_[A-Za-z0-9_-]{20,}$/.test(body.token)) {
        issuedToken = body.token;
        const status = await this.verifiedStatus(base, body.token, controller.signal);
        if (generation !== this.generation || controller.signal.aborted || Date.now() >= deadline || base !== this.base()) throw new Error("Sign-in cancelled.");
        if (status.mode !== "google" || !status.authenticated) throw new Error("Sign-in could not be verified.");
        await this.options.config.setAppSessionToken(body.token, base);
        if (generation !== this.generation || controller.signal.aborted) {
          if (this.getToken(base) === body.token) await this.options.config.clearAppSessionToken();
          throw new Error("Sign-in cancelled.");
        }
        this.current = status;
        this.pending = undefined;
        return;
      }
      if (body.status !== "pending") throw new Error("Invalid sign-in response.");
      if (generation === this.generation) this.schedulePoll(generation, controller, base, requestId, deviceSecret, deadline);
    } catch {
      if (issuedToken) await this.revoke(base, issuedToken).catch(() => undefined);
      if (generation === this.generation) {
        this.pending = undefined;
        this.current = { ...this.current, phase: "error", error: "Sign-in expired, was cancelled, or could not be verified. Try signing in again." };
      }
    }
  }

  private async revoke(base: string, token: string): Promise<void> {
    const response = await this.request("/api/auth/logout", { base, token, body: {} });
    if (!response.ok && response.status !== 401) throw new Error("Sign-out unavailable.");
  }

  async signOut(): Promise<DesktopAuthStatus> {
    this.cancel();
    const generation = this.generation;
    const base = this.base();
    const token = this.getToken(base);
    this.current = { ...this.current, authenticated: false, user: undefined, phase: "idle", error: undefined };
    await this.options.config.clearAppSessionToken();
    if (token) {
      try { await this.revoke(base, token); } catch {
        if (generation === this.generation) this.current = { ...this.current, phase: "error", error: "Signed out on this computer. Server revocation could not be confirmed; the old session will expire automatically." };
      }
    }
    return this.snapshot();
  }

  async unauthorized(token: string, base: string): Promise<void> {
    if (token === this.getToken(base)) {
      await this.options.config.clearAppSessionToken();
      this.current = { mode: "google", configured: true, authenticated: false, phase: "idle" };
    }
  }
}
