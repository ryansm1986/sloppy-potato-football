import { Bot, KeyRound, LoaderCircle, Pause, Play, Power, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopSettings, RunnerLogEntry, RunnerStatus } from "../../../desktop/shared/contracts";
import { readOwnerTokenFromEnvironmentFile } from "./owner-token-file";

type DesktopRunnerControlsProps = {
  ownerToken?: string;
};

export default function DesktopRunnerControls({ ownerToken = "" }: DesktopRunnerControlsProps) {
  const desktop = window.sloppyPotatoDesktop;
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [logs, setLogs] = useState<RunnerLogEntry[]>([]);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [ownerTokenDraft, setOwnerTokenDraft] = useState("");
  const [deviceName, setDeviceName] = useState("My fantasy football computer");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownerTokenFileInput = useRef<HTMLInputElement>(null);

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

  // A saved Research Desk credential replaces any stale one-off override, but
  // is never copied into the rendered password field.
  useEffect(() => {
    setOwnerTokenDraft("");
  }, [ownerToken]);

  if (!desktop) return null;
  const desktopApi = desktop;
  const effectiveOwnerToken = ownerTokenDraft.trim() || ownerToken.trim();

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
    setNotice(null);
    try {
      await desktopApi.credentials.setRunnerToken(tokenDraft.trim());
      setTokenDraft("");
      setHasToken(true);
      setStatus(await desktopApi.runner.start());
      setNotice("Runner credential replaced and polling restarted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not secure the runner token.");
    } finally {
      setBusy(null);
    }
  }

  async function enrollRunner() {
    if (!effectiveOwnerToken || !deviceName.trim()) return;
    setBusy("enroll");
    setError(null);
    setNotice(null);
    try {
      const result = await desktopApi.credentials.enrollRunner({
        ownerToken: effectiveOwnerToken,
        name: deviceName.trim(),
      });
      setOwnerTokenDraft("");
      setHasToken(true);
      setStatus(await desktopApi.runner.start());
      setNotice(`${result.device.name} is enrolled and polling securely.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enroll this computer.");
    } finally {
      setBusy(null);
    }
  }

  async function importOwnerToken(file: File | undefined) {
    if (!file) return;
    setBusy("owner-token-file");
    setError(null);
    try {
      setOwnerTokenDraft(await readOwnerTokenFromEnvironmentFile(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the owner token file.");
    } finally {
      setBusy(null);
      if (ownerTokenFileInput.current) ownerTokenFileInput.current.value = "";
    }
  }

  async function removeToken() {
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      await desktopApi.credentials.clearRunnerToken();
      setHasToken(false);
      setConfirmRemove(false);
      setTokenDraft("");
      setStatus(await desktopApi.runner.status());
      setNotice("Runner credential removed from this computer.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the runner credential.");
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
          <p><KeyRound size={13} /> Enroll this computer with your owner access. The new device credential is encrypted by Windows and is never shown to the page.</p>
          <label><span>Computer name</span><input aria-label="Computer name" value={deviceName} maxLength={100} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <label><span>{ownerToken.trim() ? "Use a different owner token (optional)" : "Owner token"}</span><input aria-label="Owner token" type="password" value={ownerTokenDraft} onChange={(event) => setOwnerTokenDraft(event.target.value)} placeholder={ownerToken.trim() ? "Saved owner access will be used" : "Paste RESEARCH_OWNER_TOKEN"} autoComplete="off" /></label>
          {ownerToken.trim() ? (
            <p className="desktop-token-feedback is-ready" role="status"><KeyRound size={12} /> Saved Research Desk owner access is ready. The token remains hidden.</p>
          ) : !ownerTokenDraft.trim() ? (
            <p className="desktop-token-feedback">Enter an owner token here or save one under Private bridge access to continue.</p>
          ) : null}
          {!ownerToken.trim() && (
            <div className="desktop-owner-token-import">
              <input ref={ownerTokenFileInput} aria-label="Choose .env.runner file" hidden type="file" onChange={(event) => { void importOwnerToken(event.target.files?.[0]); }} />
              <button type="button" disabled={busy !== null} onClick={() => ownerTokenFileInput.current?.click()}><KeyRound size={13} /> Load existing .env.runner</button>
              <span>No file yet? Run <code>pnpm bridge:setup</code> once from the project folder. It securely creates and registers the owner token with Cloudflare.</span>
            </div>
          )}
          <button className="button button--primary" type="button" disabled={!effectiveOwnerToken || !deviceName.trim() || busy !== null} onClick={() => { void enrollRunner(); }}>{busy === "enroll" ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />} {busy === "enroll" ? "Setting up…" : "Set up this computer"}</button>
          {busy === "enroll" && <p className="desktop-token-feedback is-pending" role="status">Creating and securing this computer's runner credential…</p>}
          {error && <p className="research-error desktop-token-error" role="alert">{error}</p>}
          <details className="desktop-manual-token"><summary>Use an existing runner token instead</summary><label><span>Runner token</span><input aria-label="Desktop runner token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste scoped runner token" autoComplete="off" /></label><button type="button" disabled={!tokenDraft.trim() || busy !== null} onClick={() => { void saveToken(); }}>{busy === "token" ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />} Secure and start</button></details>
        </div>
      )}
      {hasToken && (
        <div className="desktop-runner-actions">
          {(state === "offline" || state === "paused") && <button type="button" disabled={busy !== null} onClick={() => { void command("start", () => desktopApi.runner.start()); }}><Play size={13} /> Start</button>}
          {(state === "idle" || state === "running" || state === "starting") && <button type="button" disabled={busy !== null} onClick={() => { void command("pause", () => desktopApi.runner.pauseAfterCurrent()); }}><Pause size={13} /> Pause after job</button>}
          <button type="button" disabled={busy !== null || state === "running" || state === "error" || state === "starting" || state === "stopping"} onClick={() => { void command("next", () => desktopApi.runner.runNext()); }}><Play size={13} /> Run next</button>
          <button type="button" disabled={busy !== null} onClick={() => { void command("stop", () => desktopApi.runner.stop()); }}><Power size={13} /> Stop polling</button>
        </div>
      )}
      {status?.detail && <p className={`desktop-runner-detail is-${state}`} role={state === "error" ? "alert" : undefined}>{status.detail}</p>}
      {hasToken && (
        <details className="desktop-credential-management" open={state === "error"}>
          <summary>Runner credential</summary>
          <div>
            <p>A bad or expired token can always be replaced or removed, even while the runner is offline.</p>
            <label><span>Replacement runner token</span><input aria-label="Replacement runner token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste a new scoped runner token" autoComplete="off" /></label>
            <button type="button" disabled={!tokenDraft.trim() || busy !== null} onClick={() => { void saveToken(); }}><KeyRound size={13} /> Replace and restart</button>
            {!confirmRemove ? <button className="is-danger" type="button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}><Trash2 size={13} /> Remove from this computer</button> : <div className="desktop-remove-confirm"><span>This stops the local runner and removes its saved token. It does not revoke the server credential.</span><button className="is-danger" type="button" disabled={busy !== null} onClick={() => { void removeToken(); }}>{busy === "remove" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} Remove locally</button><button type="button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Cancel</button></div>}
          </div>
        </details>
      )}
      {status?.currentJob && <p className="desktop-current-job">Working: <strong>{status.currentJob.label}</strong></p>}
      {settings && <div className="desktop-settings"><span><Settings2 size={12} /> Desktop behavior</span><label><input type="checkbox" checked={settings.launchAtStartup} onChange={(event) => { void updateSetting({ launchAtStartup: event.target.checked }); }} /> Start with Windows</label><label><input type="checkbox" checked={settings.closeToTray} onChange={(event) => { void updateSetting({ closeToTray: event.target.checked }); }} /> Close to tray</label><label><input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => { void updateSetting({ notificationsEnabled: event.target.checked }); }} /> Notifications</label></div>}
      {logs.length > 0 && <details className="desktop-runner-logs"><summary>Recent runner activity</summary><ol>{logs.slice(-8).reverse().map((entry) => <li key={entry.id} className={`is-${entry.level}`}><time>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><span>{entry.message}</span></li>)}</ol></details>}
      {notice && <p className="desktop-runner-notice" role="status">{notice}</p>}
      {error && hasToken && <p className="research-error" role="alert">{error}</p>}
    </section>
  );
}
