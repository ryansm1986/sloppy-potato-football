import {
  AlertCircle,
  Bot,
  CheckCircle2,
  KeyRound,
  MonitorCog,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router";
import DesktopRunnerControls from "../research/DesktopRunnerControls";
import {
  fetchRunnerCredentials,
  fetchRunnerStatus,
  isLocalDevelopment,
  ResearchApiError,
  revokeRunnerCredential,
  type RunnerCredential,
} from "../research/research-api";
import { useResearchOwnerAccess } from "../research/useResearchOwnerAccess";

type AccessState = "locked" | "checking" | "authorized" | "denied";

function formatRelativeDate(value: string | null): string {
  if (!value) return "Never";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

export default function SettingsPage({ localDevelopmentOverride }: { localDevelopmentOverride?: boolean } = {}) {
  const localDevelopment = localDevelopmentOverride ?? isLocalDevelopment();
  const { ownerToken, revision, saveOwnerToken, removeOwnerToken } = useResearchOwnerAccess();
  const [tokenDraft, setTokenDraft] = useState("");
  const [accessState, setAccessState] = useState<AccessState>(() => localDevelopment || ownerToken ? "checking" : "locked");
  const [credentials, setCredentials] = useState<RunnerCredential[]>([]);
  const [credentialToRevoke, setCredentialToRevoke] = useState<string | null>(null);
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = window.sloppyPotatoDesktop;
  const canAttemptAccess = localDevelopment || Boolean(ownerToken);

  const refreshAccess = useCallback(async (signal?: AbortSignal) => {
    if (!canAttemptAccess) {
      setAccessState("locked");
      setCredentials([]);
      return;
    }
    setAccessState("checking");
    setError(null);
    try {
      const [, nextCredentials] = await Promise.all([
        fetchRunnerStatus(ownerToken, signal),
        fetchRunnerCredentials(ownerToken, signal),
      ]);
      setCredentials(nextCredentials);
      setAccessState("authorized");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setCredentials([]);
      if (cause instanceof ResearchApiError && (cause.status === 401 || cause.status === 403)) {
        setAccessState("denied");
        setError("This owner token was rejected. Replace it below or remove it from this device.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not reach the research bridge.");
      }
    }
  }, [canAttemptAccess, ownerToken]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAccess(controller.signal);
    return () => controller.abort();
  }, [refreshAccess, revision]);

  function saveToken() {
    const cleanToken = tokenDraft.trim();
    if (!cleanToken) return;
    setNotice("Owner access saved only on this device. Verifying it now.");
    setError(null);
    setTokenDraft("");
    saveOwnerToken(cleanToken);
  }

  function removeToken() {
    removeOwnerToken();
    setTokenDraft("");
    setAccessState(localDevelopment ? "checking" : "locked");
    setCredentials([]);
    setError(null);
    setNotice("Owner access removed from this device.");
  }

  async function revokeCredential(credential: RunnerCredential) {
    setCredentialBusy(credential.id);
    setNotice(null);
    setError(null);
    try {
      await revokeRunnerCredential(ownerToken, credential.id);
      const revokedAt = new Date().toISOString();
      setCredentials((current) => current.map((item) => item.id === credential.id
        ? { ...item, active: false, revokedAt, updatedAt: revokedAt }
        : item));
      setCredentialToRevoke(null);
      setNotice(`${credential.name} was revoked. Its saved token can no longer claim research jobs.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke this runner credential.");
    } finally {
      setCredentialBusy(null);
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">App & runner configuration</p>
          <h1>Settings</h1>
          <p className="page-header__copy">Manage private access, this computer, and every runner connected to Sloppy Potato.</p>
        </div>
        <div className="page-header__actions">
          <span className={`status-pill status-pill--${accessState === "authorized" ? "online" : accessState === "denied" ? "offline" : "locked"}`}>
            {accessState === "authorized" ? <CheckCircle2 size={12} /> : <KeyRound size={12} />} Owner {accessState}
          </span>
          <NavLink className="button button--secondary" to="/research">Open Research Desk</NavLink>
        </div>
      </header>

      {notice && <p className="research-notice settings-notice" role="status">{notice}</p>}
      {error && <p className="research-error settings-notice" role="alert"><AlertCircle size={13} /> {error}</p>}

      <div className="settings-layout">
        <div className="settings-main">
          <section className="panel owner-token-card settings-access-card">
            <header><ShieldCheck size={18} /><div><p className="eyebrow">Access & security</p><h2>Owner access</h2></div></header>
            <div className={`settings-access-state is-${accessState}`}>
              {accessState === "authorized" ? <CheckCircle2 size={17} /> : <KeyRound size={17} />}
              <div>
                <strong>{accessState === "authorized" ? "Private bridge unlocked" : accessState === "checking" ? "Checking saved access" : accessState === "denied" ? "Saved access was rejected" : "Owner access is not set up"}</strong>
                <span>{accessState === "authorized" ? "Research jobs, schedules, and runner management are available on this device." : "Save the owner token for this Sloppy Potato deployment. It stays in this device's browser storage."}</span>
              </div>
            </div>
            <label>
              <span>{ownerToken ? "Replace owner token" : "Owner token"}</span>
              <input aria-label="Research owner token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder={ownerToken ? "Paste a replacement token" : "Paste owner token"} autoComplete="off" />
            </label>
            <p>The token is never bundled into the site or displayed again after saving.</p>
            <div>
              <button className="button button--primary" type="button" onClick={saveToken} disabled={!tokenDraft.trim()}><Save size={13} /> {ownerToken ? "Replace & verify" : "Save & verify"}</button>
              {ownerToken && <button className="button button--secondary" type="button" onClick={removeToken}><Trash2 size={13} /> Remove</button>}
            </div>
            {localDevelopment && <small><ShieldCheck size={12} /> Local development can connect without a token.</small>}
          </section>

          {desktop ? <DesktopRunnerControls ownerToken={ownerToken} /> : (
            <section className="panel settings-desktop-empty">
              <MonitorCog size={24} />
              <div><p className="eyebrow">This computer</p><h2>Desktop runner</h2><p>Open Settings in the Sloppy Potato desktop app to enroll and control a runner on this computer.</p></div>
            </section>
          )}
        </div>

        <aside className="settings-side">
          <section className="panel runner-devices" aria-label="Connected runner devices">
            <header>
              <div><p className="eyebrow">Device security</p><h2>Connected Computers</h2></div>
              <span>{credentials.filter((credential) => credential.active).length} active</span>
            </header>
            {accessState !== "authorized" ? (
              <div className="runner-devices__empty"><KeyRound size={18} /><p>Verify owner access to manage connected computers.</p></div>
            ) : credentials.length === 0 ? (
              <div className="runner-devices__empty"><Bot size={18} /><p>No device-specific runners are enrolled yet. Use the desktop app on a computer to add one.</p></div>
            ) : credentials.map((credential) => (
              <article key={credential.id} className={!credential.active ? "is-revoked" : ""}>
                <div className="runner-devices__identity">
                  <strong>{credential.name}</strong>
                  <span>{credential.active ? "Active" : "Revoked"} · {credential.tokenHint}</span>
                  <small>{credential.runnerId} · Last used {formatRelativeDate(credential.lastUsedAt)}</small>
                </div>
                {credential.active && credentialToRevoke !== credential.id && (
                  <button className="is-danger" type="button" disabled={credentialBusy !== null} aria-label={`Revoke ${credential.name}`} onClick={() => setCredentialToRevoke(credential.id)}>Revoke</button>
                )}
                {credential.active && credentialToRevoke === credential.id && (
                  <div className="runner-devices__confirm">
                    <span>Disable this computer's cloud access?</span>
                    <button className="is-danger" type="button" disabled={credentialBusy !== null} aria-label={`Confirm revoke ${credential.name}`} onClick={() => { void revokeCredential(credential); }}>{credentialBusy === credential.id ? "Revoking…" : "Confirm revoke"}</button>
                    <button type="button" disabled={credentialBusy !== null} onClick={() => setCredentialToRevoke(null)}>Cancel</button>
                  </div>
                )}
              </article>
            ))}
            <p className="runner-devices__note"><ShieldCheck size={12} /> Revoking disables cloud access. Removing a credential in the desktop app only clears its encrypted local copy.</p>
          </section>

          <section className="panel settings-help-card">
            <Settings size={18} />
            <div><p className="eyebrow">What lives here</p><h2>One place for runner setup</h2><p>Owner access, computer enrollment, polling controls, desktop behavior, credential recovery, connected computers, and runner activity are all managed in Settings.</p></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
