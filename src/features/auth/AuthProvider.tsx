import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import DesktopUpdateControl from "../desktop/DesktopUpdateControl";
import { apiFetch, setAuthTransport, type AuthSession } from "./auth-api";
import "./auth.css";

const legacy: AuthSession = { mode: "legacy", configured: false, authenticated: false, user: null };
type AuthState = AuthSession & { refresh(): Promise<void>; signIn(): Promise<void>; signOut(): Promise<void>; cancel(): Promise<void>; waiting: boolean; error: string | null };
const AuthContext = createContext<AuthState>({ ...legacy, refresh: async () => {}, signIn: async () => {}, signOut: async () => {}, cancel: async () => {}, waiting: false, error: null });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const pending = useRef(false);
  const epoch = useRef(0);
  const [loginError, setLoginError] = useState<string | null>(() => {
    const messages: Record<string, string> = { invite_required: "This Google account has not been invited. Ask the owner to add your email.", google_managed_email_required: "Use a Gmail or Google Workspace account.", sign_in_cancelled: "Sign-in was cancelled. You can try again.", google_sign_in_failed: "Google sign-in failed. Please try again.", identity_mismatch: "This invitation is bound to another Google account.", google_exchange_failed: "Google sign-in could not be completed. Please try again." };
    const code = new URLSearchParams(window.location.search).get("authError");
    return code ? messages[code] ?? "Sign-in could not be completed. Please try again." : null;
  });
  useEffect(() => () => { epoch.current += 1; pending.current = false; }, []);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const generation = epoch.current;
    try {
      const desktopAuth = window.sloppyPotatoDesktop?.auth;
      let next: AuthSession;
      if (desktopAuth) {
        const result = await desktopAuth.status();
        if (generation !== epoch.current) return;
        if (result.phase === "error") throw new Error(result.error || "Could not verify this computer's access.");
        next = { ...result, user: result.user ?? null };
        setWaiting(result.phase === "opening" || result.phase === "waiting");
        setError(result.error ?? null);
      } else {
        const response = await fetch("/api/auth/session", { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error("Could not verify access. Try again.");
        next = await response.json() as AuthSession;
        if (generation !== epoch.current) return;
        if (!["legacy", "google"].includes(next.mode)) throw new Error("Unrecognized access configuration.");
        setError(null);
      }
      setAuthTransport(next);
      setSession(next);
      if (next.authenticated) setLoginError(null);
    } catch (cause) {
      if (generation !== epoch.current) return;
      setError(cause instanceof Error ? cause.message : "Could not verify access.");
      // Don't leave account data mounted after an access verification failure.
      setSession(null);
    } finally { if (generation === epoch.current) pending.current = false; }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("spff:session-expired", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, waiting ? 2_000 : 60_000);
    return () => { window.removeEventListener("spff:session-expired", visible); document.removeEventListener("visibilitychange", visible); window.clearInterval(timer); };
  }, [refresh, waiting]);

  async function signIn() {
    epoch.current += 1; pending.current = false;
    setLoginError(null);
    setError(null);
    if (window.sloppyPotatoDesktop?.auth) {
      try {
        const result = await window.sloppyPotatoDesktop.auth.signIn();
        if (result.phase === "error") throw new Error(result.error || "Sign-in could not start.");
        setWaiting(true); await refresh();
      }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in could not start."); }
    } else if (window.sloppyPotatoDesktop) {
      setError("Update the desktop app to use Google sign-in.");
    } else window.location.assign("/api/auth/google/start");
  }
  async function cancel() { epoch.current += 1; pending.current = false; await window.sloppyPotatoDesktop?.auth?.cancel(); setWaiting(false); await refresh(); }
  async function signOut() {
    epoch.current += 1; pending.current = false;
    try {
      if (window.sloppyPotatoDesktop?.auth) await window.sloppyPotatoDesktop.auth.signOut();
      else {
        const response = await apiFetch("/api/auth/logout", { method: "POST" });
        if (!response.ok) throw new Error("Sign-out failed. Try again.");
      }
      epoch.current += 1; pending.current = false;
      setSession(null); setAuthTransport({ mode: "google" }); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-out failed."); }
  }
  const value: AuthState = { ...(session ?? legacy), refresh, signIn, signOut, cancel, waiting, error };
  return <AuthContext.Provider value={value}>
    {session && (session.mode === "legacy" || session.authenticated) ? <div key={session.user?.id ?? "legacy"}>{children}</div> : <main className="auth-screen">
      <section className="panel auth-card"><ShieldCheck size={36} /><p className="eyebrow">Potato Bowl After Dark</p><h1>Sloppy Potato<br />Fantasy Football</h1>
        <p>{!session ? "Checking workspace access…" : !session.configured ? "Google sign-in is awaiting owner configuration. This workspace is private." : "A private fantasy-football workspace. Sign in with an invited Google account."}</p>
        {(error || loginError) && <p role="alert" className="research-error">{error || loginError}</p>}
        {session?.configured && <button className="button button--primary" disabled={waiting} onClick={() => void signIn()}><LogIn size={17} />{waiting ? "Finish sign-in in your browser" : "Sign in with Google"}</button>}
        {waiting && <button className="button" onClick={() => void cancel()}>Cancel sign-in</button>}
        <button className="button button--secondary" onClick={() => void refresh()}><RefreshCw size={15} /> Check access again</button>
        <DesktopUpdateControl />
      </section>
    </main>}
  </AuthContext.Provider>;
}
