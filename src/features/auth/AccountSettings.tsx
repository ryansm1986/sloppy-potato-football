import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LogOut, ShieldCheck, UserPlus } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { authRequest, type AuthUser } from "./auth-api";

type Member = AuthUser & { status: "invited" | "active" | "revoked" };
export default function AccountSettings() {
  const auth = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "researcher">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const owner = auth.mode === "google" && auth.user?.role === "owner";
  const load = useCallback(async () => {
    try { const response = await authRequest<{ users: Member[] }>("/api/auth/users"); setMembers(response.users); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load members."); }
  }, []);
  useEffect(() => { if (owner) void load(); }, [owner, load]);
  async function invite(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      await authRequest("/api/auth/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim(), role }) });
      setEmail(""); setRole("viewer"); setNotice("Access added. Share the app link with your friend; no invitation email was sent."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not invite this account."); }
    finally { setBusy(false); }
  }
  async function update(member: Member, patch: { role?: "viewer" | "researcher"; status?: "active" | "revoked" }) {
    setBusy(true); setError(null);
    try { await authRequest(`/api/auth/users/${encodeURIComponent(member.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change access."); }
    finally { setBusy(false); }
  }
  return <>
    <section className="panel account-card"><ShieldCheck size={23} /><h2>Google account & access</h2>
      {auth.mode === "google" ? <><p><strong>{auth.user?.name || auth.user?.email}</strong><br />{auth.user?.email} · {auth.user?.role}</p><p>Invite-only workspace. Researchers can queue bounded work; only the owner can manage users, computers, and global publisher blocks.</p><button className="button button--secondary" onClick={() => void auth.signOut()}><LogOut size={15} /> Sign out</button>{auth.error && <p role="alert">{auth.error}</p>}</> : <p>Google access is not activated yet. Configure the Google OAuth client and complete the owner sign-in check before switching this workspace to invite-only mode. Existing owner-token access is still active.</p>}
    </section>
    {owner && <section className="panel access-members"><h2>People & permissions</h2><p>Invited friends start as viewers. Researcher access allows jobs to use your connected runners and subscription capacity.</p>
      <form className="member-form" onSubmit={(event) => void invite(event)}><label>Google email<input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Invite role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="viewer">Viewer</option><option value="researcher">Researcher</option></select></label><button className="button button--primary" disabled={busy}><UserPlus size={15} /> Add access</button></form>
      {error && <p role="alert" className="research-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="member-list">{members.map((member) => <article className="member-row" key={member.id}><div><strong>{member.name || member.email}</strong><small>{member.email} · {member.status}</small></div>{member.role === "owner" ? <span className="badge badge--amber">Owner</span> : <><select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy || member.status === "revoked"} onChange={(event) => void update(member, { role: event.target.value as "viewer" | "researcher" })}><option value="viewer">Viewer</option><option value="researcher">Researcher</option></select><button className="button button--secondary" disabled={busy} onClick={() => void update(member, { status: member.status === "revoked" ? "active" : "revoked" })}>{member.status === "revoked" ? "Restore access" : "Revoke access"}</button></>}</article>)}</div>
    </section>}
  </>;
}
