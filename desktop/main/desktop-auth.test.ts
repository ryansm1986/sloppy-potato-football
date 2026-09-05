import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureConfigStore } from "./config-store.js";
import { DesktopAuthController, verificationUrlForApi } from "./desktop-auth.js";

const token = "sp_session_" + "s".repeat(40);
const base = "https://sloppy-potato-fantasy-football.therealryansmith.workers.dev";
const user = { id: "user-1", email: "owner@example.com", name: "Owner", role: "owner" };
const session = (role = "owner") => Response.json({ mode: "google", configured: true, authenticated: true, user: { ...user, role } });
const start = (overrides = {}) => Response.json({ requestId: "request-1", deviceSecret: "secret-never-render", verificationUrl: `${base}/api/auth/desktop/verify?request=request-1`, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides });

async function setup(fetcher = vi.fn<typeof fetch>()) {
  let file = "";
  const config = new SecureConfigStore({ read: async () => file || null, writeAtomically: async (value) => { file = value; } }, {
    isAvailable: () => true, encrypt: (value) => Buffer.from(value).toString("base64"), decrypt: (value) => Buffer.from(value, "base64").toString(),
  });
  await config.initialize();
  const open = vi.fn(async () => undefined);
  const auth = new DesktopAuthController({ config, fetch: fetcher, openExternal: open, pollIntervalMs: 100 });
  return { auth, config, open, fetcher, file: () => file };
}

afterEach(() => vi.useRealTimers());

describe("desktop Google authentication", () => {
  it("opens only a same-origin auth URL and never returns handoff secrets", async () => {
    const { auth, fetcher, open } = await setup();
    fetcher.mockResolvedValueOnce(start());
    const status = await auth.signIn();
    expect(status.phase).toBe("waiting");
    expect(open).toHaveBeenCalledWith(`${base}/api/auth/desktop/verify?request=request-1`);
    expect(JSON.stringify(status)).not.toMatch(/request-1|secret-never-render/);
    expect(await auth.status()).toEqual(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
    auth.cancel();
  });

  it.each(["https://evil.example/api/auth/start", `${base}/unexpected`, "file:///api/auth/start", `https://user:password@${new URL(base).host}/api/auth/start`])("rejects unsafe browser destinations: %s", async (url) => {
    expect(() => verificationUrlForApi(url, base)).toThrow();
    const { auth, fetcher, open } = await setup();
    fetcher.mockResolvedValueOnce(start({ verificationUrl: url }));
    expect((await auth.signIn()).phase).toBe("error");
    expect(open).not.toHaveBeenCalled();
  });

  it("verifies an approved token server-side and persists it encrypted separately from the runner", async () => {
    vi.useFakeTimers();
    const { auth, config, fetcher, file } = await setup();
    await config.setRunnerToken("runner-token-" + "r".repeat(40));
    fetcher.mockResolvedValueOnce(start()).mockResolvedValueOnce(Response.json({ status: "approved", token, user })).mockResolvedValueOnce(session());
    await auth.signIn();
    await vi.advanceTimersByTimeAsync(100);
    expect(auth.snapshot()).toMatchObject({ authenticated: true, phase: "idle", user });
    expect(config.getAppSessionToken(base)).toBe(token);
    expect(config.getAppSessionToken("https://evil.example")).toBeUndefined();
    expect(file()).not.toContain(token);
    expect(JSON.stringify(auth.snapshot())).not.toContain(token);
    const verifyRequest = fetcher.mock.calls[2][1];
    expect(new Headers(verifyRequest?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(verifyRequest).toMatchObject({ credentials: "omit", redirect: "error" });
  });

  it("rejects invalid or unauthenticated approved credentials", async () => {
    vi.useFakeTimers();
    const { auth, config, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(start()).mockResolvedValueOnce(Response.json({ status: "approved", token: "not-an-app-token" }));
    await auth.signIn();
    await vi.advanceTimersByTimeAsync(100);
    expect(auth.snapshot().phase).toBe("error");
    expect(config.getAppSessionToken(base)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight request and permits a fresh sign-in without overlapping polls", async () => {
    vi.useFakeTimers();
    const { auth, fetcher } = await setup();
    let pendingSignal: AbortSignal | undefined;
    fetcher.mockResolvedValueOnce(start()).mockImplementationOnce((_url, init) => {
      pendingSignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => pendingSignal?.addEventListener("abort", () => reject(new Error("cancelled"))));
    }).mockResolvedValueOnce(start({ requestId: "request-2" }));
    await auth.signIn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.cancel().phase).toBe("idle");
    expect(pendingSignal?.aborted).toBe(true);
    await auth.signIn();
    expect(auth.snapshot().phase).toBe("waiting");
    auth.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("bounds polling to the server expiry and allows recovery", async () => {
    vi.useFakeTimers();
    const { auth, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(start({ expiresAt: new Date(Date.now() + 150).toISOString() })).mockResolvedValue(Response.json({ status: "pending" }));
    await auth.signIn();
    await vi.advanceTimersByTimeAsync(300);
    expect(auth.snapshot().phase).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.cancel().phase).toBe("idle");
  });

  it.each(["viewer", "researcher"])("does not permit %s to control the local runner", async (role) => {
    const { auth, config, fetcher } = await setup();
    await config.setAppSessionToken(token, base);
    fetcher.mockResolvedValue(session(role));
    await expect(auth.requireOwner()).rejects.toThrow(/owner/);
  });

  it("checks the owner's current server role on every control, failing closed offline", async () => {
    const { auth, config, fetcher } = await setup();
    await config.setAppSessionToken(token, base);
    fetcher.mockResolvedValueOnce(session()).mockResolvedValueOnce(session("viewer")).mockRejectedValueOnce(new Error("offline"));
    expect((await auth.requireOwner()).user?.role).toBe("owner");
    await expect(auth.requireOwner()).rejects.toThrow(/owner/);
    await expect(auth.requireOwner()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("clears expired sessions, but ignores 401s from older concurrent requests", async () => {
    const { auth, config, fetcher } = await setup();
    await config.setAppSessionToken(token, base);
    await auth.unauthorized("sp_session_" + "old".repeat(20), base);
    expect(config.getAppSessionToken(base)).toBe(token);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await auth.status()).authenticated).toBe(false);
    expect(config.getAppSessionToken(base)).toBeUndefined();
  });

  it("also removes revoked sessions when the status endpoint reports unauthenticated with HTTP 200", async () => {
    const { auth, config, fetcher } = await setup();
    await config.setAppSessionToken(token, base);
    fetcher.mockResolvedValueOnce(Response.json({ mode: "google", configured: true, authenticated: false, user: null }));
    expect((await auth.status()).authenticated).toBe(false);
    expect(config.getAppSessionToken(base)).toBeUndefined();
  });

  it("revokes an issued session if cancellation wins the server verification race", async () => {
    vi.useFakeTimers();
    const { auth, config, fetcher } = await setup();
    let finish: ((response: Response) => void) | undefined;
    fetcher.mockResolvedValueOnce(start()).mockResolvedValueOnce(Response.json({ status: "approved", token }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await auth.signIn();
    await vi.advanceTimersByTimeAsync(100);
    auth.cancel();
    finish?.(session());
    await vi.advanceTimersByTimeAsync(0);
    expect(auth.snapshot()).toMatchObject({ authenticated: false, phase: "idle" });
    expect(config.getAppSessionToken(base)).toBeUndefined();
    expect(new URL(String(fetcher.mock.calls[3][0])).pathname).toBe("/api/auth/logout");
  });

  it("signs out and revokes only the app session without deleting the machine credential", async () => {
    const { auth, config, fetcher } = await setup();
    await config.setAppSessionToken(token, base);
    const machine = "runner-token-" + "r".repeat(40);
    await config.setRunnerToken(machine);
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await auth.signOut()).authenticated).toBe(false);
    expect(config.getAppSessionToken(base)).toBeUndefined();
    expect(config.getRunnerToken()).toBe(machine);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/api/auth/logout");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("leaves legacy control available only when the server confirms legacy mode", async () => {
    const { auth, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(Response.json({ mode: "legacy", configured: false, authenticated: false }));
    expect((await auth.requireOwner()).mode).toBe("legacy");
  });

  it("accepts verified accounts when Google does not supply a display name", async () => {
    const { auth, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(Response.json({ mode: "google", configured: true, authenticated: true, user: { ...user, name: null } }));
    expect((await auth.status()).user?.name).toBeNull();
  });
});
