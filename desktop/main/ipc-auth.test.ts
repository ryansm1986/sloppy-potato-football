import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../shared/contracts.js";
import type { SecureConfigStore } from "./config-store.js";
import type { DesktopAuthController } from "./desktop-auth.js";
import type { DesktopUpdaterController } from "./desktop-updater.js";
import { UnavailableRunnerController } from "./runner-controller.js";
import type { DesktopAuthStatus, RunnerLogEntry, RunnerStatus } from "../shared/contracts.js";

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  app: { getVersion: () => "test", isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
}));
import { registerDesktopIpc } from "./ipc.js";

const trusted = { senderFrame: { url: "potato://app/settings" }, sender: { getURL: () => "potato://app/settings" } } as IpcMainInvokeEvent;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.restoreAllMocks(); });

function setup() {
  const requireOwner = vi.fn<() => Promise<DesktopAuthStatus>>(async () => { throw new Error("Sign in as owner"); });
  const snapshot = vi.fn((): DesktopAuthStatus => ({ mode: "google", configured: true, authenticated: false, phase: "idle" }));
  const config = { setRunnerToken: vi.fn(), clearRunnerToken: vi.fn(), updateSettings: vi.fn(), getSettings: vi.fn() };
  const runner = new UnavailableRunnerController();
  const start = vi.spyOn(runner, "start");
  const reset = vi.spyOn(runner, "resetCredential");
  let statusListener!: (status: RunnerStatus) => void;
  let logListener!: (entry: RunnerLogEntry) => void;
  vi.spyOn(runner, "onStatus").mockImplementation((listener) => { statusListener = listener; return () => {}; });
  vi.spyOn(runner, "onLog").mockImplementation((listener) => { logListener = listener; return () => {}; });
  const send = vi.fn();
  cleanup = registerDesktopIpc({
    window: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow, runner,
    auth: { requireOwner, snapshot } as unknown as DesktopAuthController,
    config: config as unknown as SecureConfigStore,
    updates: { onStatus: () => () => undefined } as unknown as DesktopUpdaterController,
    showWindow: vi.fn(), quit: vi.fn(), updateStartup: vi.fn(), onSettingsChanged: vi.fn(),
  });
  return { requireOwner, snapshot, start, reset, config, send, emitStatus: () => statusListener({ state: "offline", queuedJobs: 0 }), emitLog: () => logListener({ id: "log", at: "2026-09-05", level: "info", message: "Private research" }) };
}

describe("desktop auth IPC authorization", () => {
  it.each([
    [IPC_CHANNELS.runnerStart, []], [IPC_CHANNELS.runnerPause, []], [IPC_CHANNELS.runnerResume, []],
    [IPC_CHANNELS.runnerStop, []], [IPC_CHANNELS.runnerRunNext, []],
    [IPC_CHANNELS.runnerStatus, []], [IPC_CHANNELS.runnerLogs, [100]],
    [IPC_CHANNELS.credentialsSetRunnerToken, ["r".repeat(40)]], [IPC_CHANNELS.credentialsClearRunnerToken, []],
    [IPC_CHANNELS.credentialsEnrollRunner, [{ name: "Computer" }]],
    [IPC_CHANNELS.settingsUpdate, [{ apiBaseUrl: "https://other.example" }]],
    [IPC_CHANNELS.settingsUpdate, [{ launchAtStartup: true }]],
  ] as const)("denies non-owner runner mutation through %s", async (channel, args) => {
    const state = setup();
    await expect(handlers.get(channel)!(trusted, ...args)).rejects.toThrow(/owner/);
    expect(state.requireOwner).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.config.setRunnerToken).not.toHaveBeenCalled();
    expect(state.config.clearRunnerToken).not.toHaveBeenCalled();
    expect(state.config.updateSettings).not.toHaveBeenCalled();
  });

  it("blocks auth IPC from an untrusted renderer before invoking the controller", () => {
    setup();
    const untrusted = { senderFrame: { url: "https://evil.example" } } as IpcMainInvokeEvent;
    expect(() => handlers.get(IPC_CHANNELS.authSignIn)!(untrusted)).toThrow(/untrusted/);
  });

  it("suppresses private runner events when owner verification fails", async () => {
    const state = setup(); state.emitStatus(); state.emitLog();
    await vi.waitFor(() => expect(state.requireOwner).toHaveBeenCalledOnce());
    expect(state.send).not.toHaveBeenCalled();
  });

  it("shares verification for event bursts and sends only while still owner", async () => {
    const state = setup();
    const owner: DesktopAuthStatus = { mode: "google", configured: true, authenticated: true, phase: "idle", user: { id: "owner", email: "owner@gmail.com", name: null, role: "owner" } };
    state.requireOwner.mockResolvedValue(owner); state.snapshot.mockReturnValue(owner);
    state.emitStatus(); state.emitLog();
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledTimes(2));
    expect(state.requireOwner).toHaveBeenCalledOnce();
    state.send.mockClear();
    state.emitLog();
    state.snapshot.mockReturnValue({ ...owner, authenticated: false, user: undefined });
    await vi.waitFor(() => expect(state.requireOwner).toHaveBeenCalledTimes(2));
    expect(state.send).not.toHaveBeenCalled();
  });
});
