import { Bot, Clock3, KeyRound, LoaderCircle, Pause, Play, Power, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopSettings, RunnerLogEntry, RunnerStatus } from "../../../desktop/shared/contracts";
import { readOwnerTokenFromEnvironmentFile } from "./owner-token-file";

type DesktopRunnerControlsProps = {
  ownerToken?: string;
};

const runnerStates: Record<RunnerStatus["state"], { label: string; description: string }> = {
  offline: { label: "Offline", description: "Start this computer's runner to pick up research from your queue." },
  starting: { label: "Connecting", description: "Connecting this computer to your research queue." },
  idle: { label: "Ready", description: "Watching your queue. New research will start automatically." },
  running: { label: "Researching", description: "Research is in progress. You can leave this page while it works." },
  pausing: { label: "Pause scheduled", description: "The current job will finish, then this computer will stop picking up research." },
  paused: { label: "Paused", description: "Your queue is waiting. Resume automatic research or run just one job." },
  stopping: { label: "Stopping", description: "Finishing any current job before disconnecting. No new jobs will be picked up." },
  error: { label: "Needs attention", description: "Check the message below, then reconnect or replace this computer's credential." },
};

function elapsedLabel(startedAt: string, now: number): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
    : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function mergeLogs(current: RunnerLogEntry[], incoming: RunnerLogEntry[]): RunnerLogEntry[] {
  return [...new Map([...current, ...incoming].map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-100);
}

export default function DesktopRunnerControls({ ownerToken = "" }: DesktopRunnerControlsProps) {
  const desktop = window.sloppyPotatoDesktop;
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [logs, setLogs] = useState<RunnerLogEntry[]>([]);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [tokenDraft, setTokenDraft] = useState("");
  const [ownerTokenDraft, setOwnerTokenDraft] = useState("");
  const [deviceName, setDeviceName] = useState("My fantasy football computer");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningNext, setRunningNext] = useState(false);
  const [logFilter, setLogFilter] = useState("all");
  const [logSearch, setLogSearch] = useState("");
  const [visibleLogs, setVisibleLogs] = useState(8);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState<string | null>(null);
  const ownerTokenFileInput = useRef<HTMLInputElement>(null);
  const commandSequence = useRef(0);
  const statusRevision = useRef(0);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setLoading(true);
    setError(null);
    const revision = statusRevision.current;
    void Promise.allSettled([
      desktop.runner.status(),
      desktop.runner.logs(100),
      desktop.settings.get(),
      desktop.credentials.hasRunnerToken(),
    ]).then((results) => {
      if (!active) return;
      const [nextStatus, nextLogs, nextSettings, tokenReady] = results;
      if (nextStatus.status === "fulfilled" && revision === statusRevision.current) setStatus(nextStatus.value);
      if (nextLogs.status === "fulfilled") setLogs((current) => mergeLogs(nextLogs.value, current));
      if (nextSettings.status === "fulfilled") setSettings(nextSettings.value);
      if (tokenReady.status === "fulfilled") setHasToken(tokenReady.value);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        setError(failure.reason instanceof Error ? failure.reason.message : "Some desktop controls could not be loaded. Try refreshing.");
      }
      setLoading(false);
    });
    const unsubscribeStatus = desktop.runner.onStatus((nextStatus) => {
      if (!active) return;
      statusRevision.current += 1;
      setStatus(nextStatus);
    });
    const unsubscribeLog = desktop.runner.onLog((entry) => {
      if (active) setLogs((current) => mergeLogs(current, [entry]));
    });
    return () => {
      active = false;
      unsubscribeStatus();
      unsubscribeLog();
    };
  }, [desktop, refreshRequest]);

  useEffect(() => {
    if (!status?.currentJob?.startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status?.currentJob?.startedAt]);

  // A saved Research Desk credential replaces any stale one-off override, but
  // is never copied into the rendered password field.
  useEffect(() => {
    setOwnerTokenDraft("");
  }, [ownerToken]);

  if (!desktop) return null;
  const desktopApi = desktop;
  const effectiveOwnerToken = ownerTokenDraft.trim() || ownerToken.trim();

  async function command(name: string, operation: () => Promise<RunnerStatus>) {
    const sequence = ++commandSequence.current;
    // Run-next stays pending for the entire job. Keep pause and stop available.
    if (name === "next") setRunningNext(true);
    else setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const nextStatus = await operation();
      if (sequence === commandSequence.current) setStatus(nextStatus);
    } catch (cause) {
      if (sequence === commandSequence.current) setError(cause instanceof Error ? cause.message : "The runner command failed.");
    } finally {
      if (name === "next") setRunningNext(false);
      else if (sequence === commandSequence.current) setBusy(null);
    }
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
  const stateInfo = runnerStates[state];
  const elapsed = status?.currentJob?.startedAt ? elapsedLabel(status.currentJob.startedAt, now) : null;
  const filteredLogs = logs.filter((entry) => {
    const matchesLevel = logFilter === "all" || (logFilter === "problems" ? entry.level === "warn" || entry.level === "error" : entry.level === logFilter);
    return matchesLevel && `${entry.message} ${entry.jobId ?? ""}`.toLowerCase().includes(logSearch.trim().toLowerCase());
  }).slice().reverse();
  const pendingMessages: Record<string, string> = {
    start: "Connecting runner...", resume: "Resuming automatic research...", pause: "Requesting pause...", stop: "Requesting a safe stop...",
  };
  return (
    <section className="panel desktop-runner-controls" aria-label="Desktop runner controls">
      <header><div className="research-callout__icon"><Bot size={18} /></div><div><p className="eyebrow">Desktop companion</p><h2>Runner Controls</h2></div><span className={`desktop-runner-state is-${state}`}>{status ? stateInfo.label : "Loading"}</span><button className="desktop-runner-refresh" type="button" aria-label="Refresh runner status" title="Refresh runner status and activity" disabled={loading || busy !== null} onClick={() => setRefreshRequest((current) => current + 1)}><RefreshCw size={15} className={loading ? "spin" : undefined} /></button></header>
      {loading && hasToken === null && <p className="desktop-runner-loading" role="status"><LoaderCircle className="spin" size={15} /> Loading this computer's runner...</p>}
      {hasToken && <p className="desktop-runner-overview">{stateInfo.description}</p>}
      {hasToken === false && (
        <div className="desktop-token-setup">
          <p><KeyRound size={13} /> Enroll this computer with your owner access. The new device credential is encrypted by Windows and is never shown to the page.</p>
          <label><span>Computer name</span><input aria-label="Computer name" value={deviceName} maxLength={100} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <label><span>{ownerToken.trim() ? "Use a different owner token (optional)" : "Owner token"}</span><input aria-label="Owner token" type="password" value={ownerTokenDraft} onChange={(event) => setOwnerTokenDraft(event.target.value)} placeholder={ownerToken.trim() ? "Saved owner access will be used" : "Paste RESEARCH_OWNER_TOKEN"} autoComplete="off" /></label>
          {ownerToken.trim() ? (
            <p className="desktop-token-feedback is-ready" role="status"><KeyRound size={12} /> Saved owner access from Settings is ready. The token remains hidden.</p>
          ) : !ownerTokenDraft.trim() ? (
            <p className="desktop-token-feedback">Enter an owner token here or save one under Access &amp; security to continue.</p>
          ) : null}
          {!ownerToken.trim() && (
            <div className="desktop-owner-token-import">
              <input ref={ownerTokenFileInput} aria-label="Choose .env.runner file" hidden type="file" onChange={(event) => { void importOwnerToken(event.target.files?.[0]); }} />
              <button type="button" disabled={busy !== null} onClick={() => ownerTokenFileInput.current?.click()}><KeyRound size={13} /> Load existing .env.runner</button>
              <span>Already have a legacy setup file? Import it here. New owner access is managed above.</span>
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
          {(state === "offline" || state === "error") && <button type="button" disabled={busy !== null || runningNext} onClick={() => { void command("start", () => desktopApi.runner.start()); }}><Play size={13} /> {state === "error" ? "Reconnect" : "Start"}</button>}
          {(state === "paused" || state === "pausing") && <button type="button" disabled={busy !== null} onClick={() => { void command("resume", () => desktopApi.runner.resume()); }}><Play size={13} /> {state === "pausing" ? "Keep running" : "Resume"}</button>}
          {(state === "idle" || state === "running" || state === "starting") && <button type="button" disabled={busy !== null} onClick={() => { void command("pause", () => desktopApi.runner.pauseAfterCurrent()); }}><Pause size={13} /> {state === "running" ? "Pause after job" : "Pause"}</button>}
          <button type="button" title="Run one queued job, then pause" disabled={busy !== null || runningNext || !["idle", "offline", "paused"].includes(state)} onClick={() => { void command("next", () => desktopApi.runner.runNext()); }}>{runningNext ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />} {runningNext ? "Running next..." : "Run next"}</button>
          <button type="button" title="Stop picking up research; a current job will finish first" disabled={busy !== null || state === "stopping"} onClick={() => { void command("stop", () => desktopApi.runner.stop()); }}><Power size={13} /> {state === "stopping" ? "Stopping..." : "Stop polling"}</button>
        </div>
      )}
      {busy && pendingMessages[busy] ? <p className="desktop-runner-pending" role="status"><LoaderCircle className="spin" size={13} /> {pendingMessages[busy]}</p> : runningNext && state !== "stopping" && <p className="desktop-runner-pending" role="status">One-job run requested. Stop polling remains available while it finishes.</p>}
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
      {status?.currentJob && <div className="desktop-current-job"><span>Working: <strong>{status.currentJob.label}</strong></span>{elapsed && <span className="desktop-runner-metrics"><Clock3 size={13} /> <time aria-label="Current job elapsed time" dateTime={`PT${Math.max(0, Math.floor((now - Date.parse(status.currentJob.startedAt!)) / 1_000))}S`}>{elapsed}</time> elapsed</span>}</div>}
      {settings && <div className="desktop-settings"><span><Settings2 size={12} /> Desktop behavior</span><label><input type="checkbox" checked={settings.launchAtStartup} onChange={(event) => { void updateSetting({ launchAtStartup: event.target.checked }); }} /> Start with Windows</label><label><input type="checkbox" checked={settings.closeToTray} onChange={(event) => { void updateSetting({ closeToTray: event.target.checked }); }} /> Close to tray</label><label><input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => { void updateSetting({ notificationsEnabled: event.target.checked }); }} /> Notifications</label></div>}
      <details className="desktop-runner-logs"><summary>Recent runner activity ({logs.length})</summary><div className="desktop-log-toolbar"><label><Search size={13} /><input aria-label="Search runner activity" placeholder="Search activity..." value={logSearch} onChange={(event) => { setLogSearch(event.target.value); setVisibleLogs(8); }} /></label><select aria-label="Filter runner activity" value={logFilter} onChange={(event) => { setLogFilter(event.target.value); setVisibleLogs(8); }}><option value="all">All activity</option><option value="problems">Warnings &amp; errors</option><option value="success">Completed</option><option value="info">Information</option></select></div>{filteredLogs.length > 0 ? <><p className="desktop-log-count">Showing {Math.min(visibleLogs, filteredLogs.length)} of {filteredLogs.length}{filteredLogs.length !== logs.length ? ` matching (${logs.length} total)` : " recent entries"}</p><ol>{filteredLogs.slice(0, visibleLogs).map((entry) => <li key={entry.id} className={`is-${entry.level}`}><time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><span>{entry.message}</span></li>)}</ol>{filteredLogs.length > visibleLogs && <button className="desktop-log-more" type="button" onClick={() => setVisibleLogs((current) => current + 20)}>Show more activity</button>}</> : <p className="desktop-log-empty">{logs.length ? "No activity matches these filters." : "Activity will appear here when this computer runs research."}</p>}</details>
      {notice && <p className="desktop-runner-notice" role="status">{notice}</p>}
      {error && hasToken !== false && <p className="research-error" role="alert">{error}</p>}
    </section>
  );
}
