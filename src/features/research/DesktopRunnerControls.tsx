import { Bot, KeyRound, LoaderCircle, Pause, Play, Power, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopSettings, RunnerLogEntry, RunnerStatus } from "../../../desktop/shared/contracts";

export default function DesktopRunnerControls() {
  const desktop = window.sloppyPotatoDesktop;
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [logs, setLogs] = useState<RunnerLogEntry[]>([]);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void Promise.all([
      desktop.runner.status(),
      desktop.runner.logs(30),
      desktop.settings.get(),
      desktop.credentials.hasRunnerToken(),
    ]).then(([nextStatus, nextLogs, nextSettings, tokenReady]) => {
      if (!active) return;
      setStatus(nextStatus);
      setLogs(nextLogs);
      setSettings(nextSettings);
      setHasToken(tokenReady);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Desktop controls are unavailable."));
    const unsubscribeStatus = desktop.runner.onStatus(setStatus);
    const unsubscribeLog = desktop.runner.onLog((entry) => setLogs((current) => [...current.slice(-29), entry]));
    return () => {
      active = false;
      unsubscribeStatus();
      unsubscribeLog();
    };
  }, [desktop]);

  if (!desktop) return null;
  const desktopApi = desktop;

  async function command(name: string, operation: () => Promise<RunnerStatus>) {
    setBusy(name);
    setError(null);
    try { setStatus(await operation()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The runner command failed."); }
    finally { setBusy(null); }
  }

  async function saveToken() {
    if (!tokenDraft.trim()) return;
    setBusy("token");
    setError(null);
    try {
      await desktopApi.credentials.setRunnerToken(tokenDraft.trim());
      setTokenDraft("");
      setHasToken(true);
      setStatus(await desktopApi.runner.start());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not secure the runner token.");
    } finally {
      setBusy(null);
    }
  }

  async function updateSetting(patch: Partial<DesktopSettings>) {
    setError(null);
    try { setSettings(await desktopApi.settings.update(patch)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update desktop settings."); }
  }

  const state = status?.state ?? "offline";
  return (
    <section className="panel desktop-runner-controls" aria-label="Desktop runner controls">
      <header><div className="research-callout__icon"><Bot size={18} /></div><div><p className="eyebrow">Desktop companion</p><h2>Runner Controls</h2></div><span className={`desktop-runner-state is-${state}`}>{state}</span></header>
      {!hasToken && (
        <div className="desktop-token-setup">
          <p><KeyRound size={13} /> Add the scoped <code>AGENT_RUNNER_TOKEN</code> from your local <code>.env.runner</code>. It is encrypted with Windows DPAPI and cannot be read back by the page.</p>
          <label><span className="sr-only">Desktop runner token</span><input aria-label="Desktop runner token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste scoped runner token" /></label>
          <button className="button button--primary" type="button" disabled={!tokenDraft.trim() || busy === "token"} onClick={() => { void saveToken(); }}>{busy === "token" ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />} Secure and start</button>
        </div>
      )}
      {hasToken && (
        <div className="desktop-runner-actions">
          {(state === "offline" || state === "error" || state === "paused") && <button type="button" disabled={busy !== null} onClick={() => { void command("start", () => desktopApi.runner.start()); }}><Play size={13} /> Start</button>}
          {(state === "idle" || state === "running" || state === "starting") && <button type="button" disabled={busy !== null} onClick={() => { void command("pause", () => desktopApi.runner.pauseAfterCurrent()); }}><Pause size={13} /> Pause after job</button>}
          <button type="button" disabled={busy !== null || state === "running"} onClick={() => { void command("next", () => desktopApi.runner.runNext()); }}><Play size={13} /> Run next</button>
          <button type="button" disabled={busy !== null || state === "offline"} onClick={() => { void command("stop", () => desktopApi.runner.stop()); }}><Power size={13} /> Stop</button>
        </div>
      )}
      {status?.currentJob && <p className="desktop-current-job">Working: <strong>{status.currentJob.label}</strong></p>}
      {settings && <div className="desktop-settings"><span><Settings2 size={12} /> Desktop behavior</span><label><input type="checkbox" checked={settings.launchAtStartup} onChange={(event) => { void updateSetting({ launchAtStartup: event.target.checked }); }} /> Start with Windows</label><label><input type="checkbox" checked={settings.closeToTray} onChange={(event) => { void updateSetting({ closeToTray: event.target.checked }); }} /> Close to tray</label><label><input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => { void updateSetting({ notificationsEnabled: event.target.checked }); }} /> Notifications</label></div>}
      {logs.length > 0 && <details className="desktop-runner-logs"><summary>Recent runner activity</summary><ol>{logs.slice(-8).reverse().map((entry) => <li key={entry.id} className={`is-${entry.level}`}><time>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><span>{entry.message}</span></li>)}</ol></details>}
      {error && <p className="research-error" role="alert">{error}</p>}
    </section>
  );
}
