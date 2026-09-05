import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";

export type AuthRole = "owner" | "researcher" | "viewer";
export type AuthUser = { id: string; email: string; name: string | null; role: AuthRole };
export type AuthBindings = {
  DB: D1Database; AUTH_MODE?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  APP_BASE_URL?: string; OWNER_GOOGLE_EMAIL?: string;
};
type UserRow = { id: string; email: string; google_sub: string | null; name: string | null; role: AuthRole; status: "invited" | "active" | "revoked"; created_at: number; updated_at: number };
export type AppSession = { tokenHash: string; kind: "browser" | "desktop"; csrfToken: string; user: AuthUser };
export type AuthVariables = { authSession?: AppSession; authUser?: AuthUser };
type AuthContext = Context<{ Bindings: AuthBindings; Variables: AuthVariables }>;
const SESSION_COOKIE = "__Host-sp_session";
const FLOW_COOKIE = "__Host-sp_oauth";
const FLOW_TTL = 10 * 60_000;
const SESSION_TTL = 7 * 86_400_000;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };

export class AuthError extends Error {
  constructor(public code: string, message: string, public status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 403) { super(message); }
}
// Missing mode preserves the deployed legacy installation. A typo in an
// explicitly configured mode must never accidentally reopen private content.
export const googleMode = (env: AuthBindings) => env.AUTH_MODE !== undefined && env.AUTH_MODE !== "legacy";
export function authOrigin(env: AuthBindings): string | null {
  try {
    const url = new URL(env.APP_BASE_URL ?? "");
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
export function googleConfigured(env: AuthBindings) {
  return Boolean((env.AUTH_MODE === undefined || env.AUTH_MODE === "legacy" || env.AUTH_MODE === "google") && env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim() && authOrigin(env));
}
function requireConfigured(env: AuthBindings) {
  if (!googleMode(env)) throw new AuthError("google_auth_disabled", "Google sign-in has not been enabled.", 409);
  if (env.AUTH_MODE !== "google") throw new AuthError("auth_mode_invalid", "The server authentication mode is not configured correctly.", 503);
  if (!googleConfigured(env)) throw new AuthError("google_auth_not_configured", "Google sign-in is awaiting server configuration.", 503);
}
function randomToken() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
export async function hashAuthToken(value: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function publicUser(row: UserRow): AuthUser { return { id: row.id, email: row.email, name: row.name, role: row.role }; }
function membership(row: UserRow) { return { ...publicUser(row), status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
async function audit(db: D1Database, actor: string | null, action: string, target: string | null) {
  await db.prepare("INSERT INTO auth_audit_events (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), actor, action, target, Date.now()).run();
}

export function validateGoogleClaims(payload: JWTPayload, nonce: string, clientId: string) {
  if (!payload.sub || payload.sub.length > 255 || payload.email_verified !== true || typeof payload.email !== "string"
    || !z.email().safeParse(payload.email).success || payload.nonce !== nonce
    || (payload.azp !== undefined && payload.azp !== clientId)) {
    throw new AuthError("invalid_google_identity", "Google could not verify this sign-in.");
  }
  // For third-party consumer emails Google only verified ownership when that
  // Google account was created. Require a Google-managed address for invitations.
  const emailDomain = payload.email.toLowerCase().split("@")[1];
  if (!["gmail.com", "googlemail.com"].includes(emailDomain!) && !(typeof payload.hd === "string" && payload.hd.length > 0)) {
    throw new AuthError("google_managed_email_required", "Use a Gmail or Google Workspace account so Google can verify current email ownership.");
  }
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name: typeof payload.name === "string" ? payload.name.slice(0, 120) : null };
}

// Called only after signature, issuer, audience, expiration and nonce validation.
export async function bindGoogleIdentity(env: AuthBindings, identity: { sub: string; email: string; name: string | null }): Promise<AuthUser> {
  const email = identity.email.toLowerCase();
  const ownerEmail = (env.OWNER_GOOGLE_EMAIL ?? "therealryansmith@gmail.com").trim().toLowerCase();
  const now = Date.now();
  if (email === ownerEmail) {
    await env.DB.prepare("INSERT OR IGNORE INTO auth_users (id,email,google_sub,name,role,status,created_at,updated_at) VALUES (?, ?, NULL, NULL, 'owner','invited',?,?)")
      .bind(crypto.randomUUID(), email, now, now).run();
  }
  let row = await env.DB.prepare("SELECT * FROM auth_users WHERE email = ?").bind(email).first<UserRow>();
  if (!row || row.status === "revoked") throw new AuthError("invite_required", "This app is invite-only. Ask the owner to invite this Google email.");
  if (row.google_sub && row.google_sub !== identity.sub) throw new AuthError("identity_mismatch", "This invitation is already bound to another Google account.");
  // Atomic conditional binding prevents concurrent first sign-ins taking over an invitation.
  await env.DB.prepare("UPDATE auth_users SET google_sub = ?, name = ?, status = 'active', updated_at = ? WHERE id = ? AND status != 'revoked' AND (google_sub IS NULL OR google_sub = ?)")
    .bind(identity.sub, identity.name, now, row.id, identity.sub).run();
  row = await env.DB.prepare("SELECT * FROM auth_users WHERE id = ?").bind(row.id).first<UserRow>();
  if (!row || row.status !== "active" || row.google_sub !== identity.sub) throw new AuthError("identity_mismatch", "This Google account cannot access the invitation.");
  await audit(env.DB, row.id, "google_sign_in", row.id);
  return publicUser(row);
}

export async function createAppSession(db: D1Database, userId: string, kind: "browser" | "desktop") {
  const token = `sp_session_${randomToken()}`;
  const csrfToken = randomToken();
  const tokenHash = await hashAuthToken(token);
  const result = await db.prepare("INSERT INTO auth_sessions (token_hash,user_id,kind,csrf_token,created_at,expires_at) SELECT ?,id,?,?,?,? FROM auth_users WHERE id = ? AND status = 'active'")
    .bind(tokenHash, kind, csrfToken, Date.now(), Date.now() + SESSION_TTL, userId).run();
  if (!result.meta.changes) throw new AuthError("access_revoked", "This account no longer has access.");
  return { token, tokenHash, csrfToken };
}
export async function authenticateAppRequest(env: AuthBindings, request: Request): Promise<AppSession | undefined> {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer (sp_session_[A-Za-z0-9_-]{43})$/)?.[1];
  const cookie = request.headers.get("Cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const token = bearer ?? cookie;
  if (!token || token.length > 100) return undefined;
  const tokenHash = await hashAuthToken(token);
  const row = await env.DB.prepare("SELECT u.*, s.kind, s.csrf_token FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'")
    .bind(tokenHash, Date.now()).first<UserRow & { kind: "browser" | "desktop"; csrf_token: string }>();
  if (!row || row.kind !== (bearer ? "desktop" : "browser")) return undefined;
  return { tokenHash, kind: row.kind, csrfToken: row.csrf_token, user: publicUser(row) };
}
export function personalIdentity(user?: AuthUser) { return !user || user.role === "owner" ? "primary-owner" : user.id; }
export function assertRole(user: AuthUser | undefined, roles: AuthRole[]) {
  if (!user) throw new AuthError("sign_in_required", "Sign in to access this invite-only app.", 401);
  if (!roles.includes(user.role)) throw new AuthError("insufficient_role", "Your role does not allow this action.");
}
export function assertCsrf(env: AuthBindings, request: Request, session: AppSession, suppliedToken?: string) {
  if (session.kind === "desktop") return;
  if (request.headers.get("Origin") !== authOrigin(env) || (suppliedToken ?? request.headers.get("X-CSRF-Token")) !== session.csrfToken) {
    throw new AuthError("csrf_rejected", "Refresh the page before trying this action again.");
  }
}
function requestRole(path: string, method: string): AuthRole[] {
  if (path.startsWith("/api/research/runner-credentials") || path.startsWith("/api/research/agents/")) return ["owner"];
  if (path.startsWith("/api/research/jobs") || path.startsWith("/api/research/schedules") || path === "/api/research/runner/status") return ["owner", "researcher"];
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return ["owner", "researcher", "viewer"];
  if (path === "/api/research/personal-rankings" || /^\/api\/publishers\/[^/]+\/preferences$/.test(path)) return ["owner", "researcher", "viewer"];
  return ["owner"];
}
function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;"); }
function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Sloppy Potato</title><body style="margin:0;background:#10120f;color:#f3f1df;font:18px system-ui;line-height:1.6"><main style="max-width:620px;margin:12vh auto;padding:32px;border:1px solid #53573e;border-radius:20px"><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}
async function prune(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM auth_oauth_flows WHERE expires_at < ?").bind(Date.now()),
    db.prepare("DELETE FROM auth_desktop_requests WHERE expires_at < ?").bind(Date.now()),
    db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(Date.now()),
  ]);
}
async function throttleAuthStart(c: AuthContext) {
  const now = Date.now(), window = Math.floor(now / 60_000);
  // Cloudflare overwrites this header at the trusted edge. Never store raw IPs.
  // Missing headers share a conservative bucket for local/direct test requests.
  const bucket = await hashAuthToken(`${window}:${c.req.header("CF-Connecting-IP") ?? "unknown"}`);
  const [, result] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_start_limits WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare("INSERT INTO auth_start_limits (bucket_key,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 10 RETURNING attempts")
      .bind(bucket, (window + 2) * 60_000),
  ]);
  if (!result.results.length) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000))));
    throw new AuthError("auth_rate_limited", "Too many sign-in attempts. Wait a minute before trying again.", 429);
  }
}
const invitationInput = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()), role: z.enum(["viewer", "researcher"]).default("viewer") }).strict();
const memberUpdateInput = z.object({ role: z.enum(["viewer", "researcher"]).optional(), status: z.enum(["active", "revoked"]).optional() }).strict().refine((value) => Object.keys(value).length > 0);
const desktopPollInput = z.object({ requestId: z.uuid(), deviceSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export function registerGoogleAuth<T extends { Bindings: AuthBindings; Variables: AuthVariables }>(app: Hono<T>) {
  // Runs before legacy route guards. Old owner secrets cannot bypass Google mode.
  app.use("/api/*", async (rawContext, next) => {
    const c = rawContext as unknown as AuthContext;
    if (c.req.path.startsWith("/api/auth/")) {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Frame-Options", "DENY");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    }
    if (!googleMode(c.env) || c.req.path === "/api/health" || c.req.path.startsWith("/api/runners/")) return next();
    c.header("Cache-Control", "no-store");
    if (c.req.path === "/api/auth/session") {
      if (googleConfigured(c.env)) {
        const session = await authenticateAppRequest(c.env, c.req.raw);
        if (session) { c.set("authSession", session); c.set("authUser", session.user); }
      }
      return next();
    }
    requireConfigured(c.env);
    const session = await authenticateAppRequest(c.env, c.req.raw);
    if (session) { c.set("authSession", session); c.set("authUser", session.user); }
    if (c.req.path.startsWith("/api/auth/")) return next();
    assertRole(session?.user, requestRole(c.req.path, c.req.method));
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) assertCsrf(c.env, c.req.raw, session!);
    return next();
  });

  app.get("/api/auth/session", (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    c.header("Cache-Control", "no-store");
    const session = c.get("authSession");
    return c.json({ mode: googleMode(c.env) ? "google" : "legacy", configured: googleConfigured(c.env), authenticated: Boolean(session), user: session?.user ?? null, ...(session ? { csrfToken: session.csrfToken } : {}) });
  });
  app.get("/api/auth/google/start", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    requireConfigured(c.env);
    const origin = authOrigin(c.env)!;
    if (new URL(c.req.url).origin !== origin) throw new AuthError("invalid_origin", "Use the configured app address to sign in.");
    await throttleAuthStart(c);
    const desktop = c.req.query("desktop") ?? null;
    if (desktop && (!z.uuid().safeParse(desktop).success || !await c.env.DB.prepare("SELECT id FROM auth_desktop_requests WHERE id = ? AND expires_at > ? AND user_id IS NULL").bind(desktop, Date.now()).first())) throw new AuthError("desktop_request_invalid", "This computer sign-in request expired. Start again in the app.");
    await prune(c.env.DB);
    const state = randomToken(), browser = randomToken(), nonce = randomToken(), verifier = randomToken();
    await c.env.DB.prepare("INSERT INTO auth_oauth_flows (state_hash,browser_hash,nonce,verifier,desktop_request_id,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await hashAuthToken(state), await hashAuthToken(browser), nonce, verifier, desktop, Date.now() + FLOW_TTL).run();
    setCookie(c, FLOW_COOKIE, browser, { ...cookieOptions, maxAge: FLOW_TTL / 1000 });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID!, redirect_uri: `${origin}/api/auth/google/callback`, response_type: "code", scope: "openid email profile", state, nonce, code_challenge: await hashAuthToken(verifier), code_challenge_method: "S256", prompt: "select_account" }).toString();
    return c.redirect(url.toString());
  });
  app.get("/api/auth/google/callback", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    requireConfigured(c.env);
    c.header("Referrer-Policy", "no-referrer");
    const state = c.req.query("state"), browser = getCookie(c, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, cookieOptions);
    if (!state || state.length > 100 || !browser || browser.length > 100 || new URL(c.req.url).origin !== authOrigin(c.env)) throw new AuthError("oauth_state_invalid", "This sign-in expired. Please start again.");
    const flow = await c.env.DB.prepare("DELETE FROM auth_oauth_flows WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING nonce,verifier,desktop_request_id")
      .bind(await hashAuthToken(state), await hashAuthToken(browser), Date.now()).first<{ nonce: string; verifier: string; desktop_request_id: string | null }>();
    if (!flow) throw new AuthError("oauth_state_invalid", "This sign-in expired or was already used. Please start again.");
    const code = c.req.query("code");
    if (!code || code.length > 4096 || c.req.query("error")) return c.redirect(`${authOrigin(c.env)}/?authError=sign_in_cancelled`);
    try {
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${authOrigin(c.env)}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: flow.verifier }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new AuthError("google_exchange_failed", "Google sign-in could not be completed. Please try again.");
      const tokens = await response.json() as { id_token?: unknown };
      if (typeof tokens.id_token !== "string") throw new AuthError("invalid_google_identity", "Google did not return a verified identity.");
      const { payload } = await jwtVerify(tokens.id_token, googleKeys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: c.env.GOOGLE_CLIENT_ID!, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "email", "email_verified", "nonce"], maxTokenAge: "10m", clockTolerance: 30 });
      const user = await bindGoogleIdentity(c.env, validateGoogleClaims(payload, flow.nonce, c.env.GOOGLE_CLIENT_ID!));
      const oldSession = c.get("authSession");
      if (oldSession?.kind === "browser") await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(oldSession.tokenHash).run();
      const session = await createAppSession(c.env.DB, user.id, "browser");
      setCookie(c, SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
      if (flow.desktop_request_id) {
        const bound = await c.env.DB.prepare("UPDATE auth_desktop_requests SET browser_session_hash = ? WHERE id = ? AND expires_at > ? AND user_id IS NULL")
          .bind(session.tokenHash, flow.desktop_request_id, Date.now()).run();
        if (!bound.meta.changes) throw new AuthError("desktop_request_invalid", "This computer sign-in request expired. Start again in the app.");
        return c.html(page("Connect this computer?", `<p>Signed in as <strong>${escapeHtml(user.email)}</strong>.</p><p>Only confirm if you just selected Sign in with Google in your own Sloppy Potato desktop app. This gives that computer access with your ${escapeHtml(user.role)} permissions.</p><form method="post" action="/api/auth/desktop/approve"><input type="hidden" name="requestId" value="${escapeHtml(flow.desktop_request_id)}"><input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}"><button style="font:inherit;padding:12px 20px;cursor:pointer" type="submit">Confirm this computer</button></form><p><a style="color:#e7bd63" href="/">Cancel and return to the website</a></p>`));
      }
      return c.redirect(`${authOrigin(c.env)}/`);
    } catch (error) {
      // Never expose upstream token responses, authorization codes or JWT parsing details.
      if (error instanceof AuthError) return c.redirect(`${authOrigin(c.env)}/?authError=${encodeURIComponent(error.code)}`);
      return c.redirect(`${authOrigin(c.env)}/?authError=google_sign_in_failed`);
    }
  });
  app.post("/api/auth/logout", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    const session = c.get("authSession");
    if (session) {
      assertCsrf(c.env, c.req.raw, session);
      await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(session.tokenHash).run();
    }
    deleteCookie(c, SESSION_COOKIE, cookieOptions);
    return c.json({ ok: true });
  });
  app.get("/api/auth/users", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    assertRole(c.get("authUser"), ["owner"]);
    const rows = await c.env.DB.prepare("SELECT * FROM auth_users ORDER BY role = 'owner' DESC, email LIMIT 200").all<UserRow>();
    return c.json({ users: rows.results.map(membership) });
  });
  app.post("/api/auth/users", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    assertRole(c.get("authUser"), ["owner"]); assertCsrf(c.env, c.req.raw, c.get("authSession")!);
    const input = invitationInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthError("invalid_invitation", "Enter a valid email and viewer or researcher role.", 400);
    const existing = await c.env.DB.prepare("SELECT * FROM auth_users WHERE email = ?").bind(input.data.email).first<UserRow>();
    if (existing) throw new AuthError("member_exists", "This email already has a membership. Update its existing access instead.", 409);
    const count = await c.env.DB.prepare("SELECT count(*) AS count FROM auth_users").first<{ count: number }>();
    if ((count?.count ?? 0) >= 200) throw new AuthError("member_limit", "This small-group app supports up to 200 memberships.", 409);
    const id = crypto.randomUUID(), now = Date.now();
    await c.env.DB.prepare("INSERT INTO auth_users (id,email,role,status,created_at,updated_at) VALUES (?,?,?,'invited',?,?)").bind(id, input.data.email, input.data.role, now, now).run();
    await audit(c.env.DB, c.get("authUser")!.id, "user_invited", id);
    const row = await c.env.DB.prepare("SELECT * FROM auth_users WHERE id = ?").bind(id).first<UserRow>();
    return c.json({ user: membership(row!) }, 201);
  });
  app.patch("/api/auth/users/:id", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    assertRole(c.get("authUser"), ["owner"]); assertCsrf(c.env, c.req.raw, c.get("authSession")!);
    const input = memberUpdateInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthError("invalid_membership", "Choose a viewer or researcher role and an access status.", 400);
    const row = await c.env.DB.prepare("SELECT * FROM auth_users WHERE id = ?").bind(c.req.param("id")).first<UserRow>();
    if (!row) throw new AuthError("member_not_found", "Member not found.", 404);
    if (row.role === "owner") throw new AuthError("owner_protected", "The configured owner cannot be revoked or demoted.");
    const status = input.data.status === "active" && !row.google_sub ? "invited" : input.data.status ?? row.status;
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE auth_users SET role = ?, status = ?, updated_at = ? WHERE id = ?").bind(input.data.role ?? row.role, status, Date.now(), row.id),
      // Clear all old desktop and browser sessions when access or role changes.
      c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(row.id),
      c.env.DB.prepare("DELETE FROM auth_desktop_requests WHERE user_id = ?").bind(row.id),
    ]);
    await audit(c.env.DB, c.get("authUser")!.id, status === "revoked" ? "user_revoked" : "user_updated", row.id);
    return c.json({ user: membership((await c.env.DB.prepare("SELECT * FROM auth_users WHERE id = ?").bind(row.id).first<UserRow>())!) });
  });
  app.post("/api/auth/desktop/start", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    requireConfigured(c.env);
    // Device authorization may originate in Electron, but never a third-party webpage.
    if (c.req.header("Origin") && c.req.header("Origin") !== authOrigin(c.env)) throw new AuthError("invalid_origin", "Start sign-in from the desktop app.");
    await throttleAuthStart(c);
    await prune(c.env.DB);
    const requestId = crypto.randomUUID(), deviceSecret = randomToken(), expiresAt = Date.now() + FLOW_TTL;
    await c.env.DB.prepare("INSERT INTO auth_desktop_requests (id,secret_hash,expires_at) VALUES (?,?,?)").bind(requestId, await hashAuthToken(deviceSecret), expiresAt).run();
    return c.json({ requestId, deviceSecret, verificationUrl: `${authOrigin(c.env)}/api/auth/google/start?desktop=${requestId}`, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.post("/api/auth/desktop/approve", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    const session = c.get("authSession");
    assertRole(session?.user, ["owner", "researcher", "viewer"]);
    if (session!.kind !== "browser") throw new AuthError("browser_required", "Confirm this request in your browser.");
    const form = await c.req.parseBody();
    assertCsrf(c.env, c.req.raw, session!, typeof form.csrfToken === "string" ? form.csrfToken : "");
    if (typeof form.requestId !== "string" || !z.uuid().safeParse(form.requestId).success) throw new AuthError("desktop_request_invalid", "Invalid computer sign-in request.");
    const result = await c.env.DB.prepare("UPDATE auth_desktop_requests SET user_id = ?, approved_at = ? WHERE id = ? AND expires_at > ? AND user_id IS NULL AND browser_session_hash = ?")
      .bind(session!.user.id, Date.now(), form.requestId, Date.now(), session!.tokenHash).run();
    if (!result.meta.changes) throw new AuthError("desktop_request_invalid", "This computer sign-in expired or was already approved.");
    await audit(c.env.DB, session!.user.id, "desktop_approved", form.requestId);
    return c.html(page("Computer connected", "<p>You can return to your Sloppy Potato desktop app and close this browser tab.</p>"));
  });
  app.post("/api/auth/desktop/poll", async (rawContext) => {
    const c = rawContext as unknown as AuthContext;
    requireConfigured(c.env);
    const input = desktopPollInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthError("desktop_request_invalid", "Invalid computer sign-in request.");
    const hash = await hashAuthToken(input.data.deviceSecret);
    const request = await c.env.DB.prepare("SELECT user_id FROM auth_desktop_requests WHERE id = ? AND secret_hash = ? AND expires_at > ?").bind(input.data.requestId, hash, Date.now()).first<{ user_id: string | null }>();
    if (!request) throw new AuthError("desktop_request_invalid", "This computer sign-in expired or was already completed.");
    if (!request.user_id) return c.json({ status: "pending" });
    // Consume atomically so a race or replay can never mint a second desktop session.
    const consumed = await c.env.DB.prepare("DELETE FROM auth_desktop_requests WHERE id = ? AND secret_hash = ? AND expires_at > ? AND user_id IS NOT NULL RETURNING user_id").bind(input.data.requestId, hash, Date.now()).first<{ user_id: string }>();
    if (!consumed) throw new AuthError("desktop_request_invalid", "This computer sign-in was already completed.");
    const user = await c.env.DB.prepare("SELECT * FROM auth_users WHERE id = ? AND status = 'active'").bind(consumed.user_id).first<UserRow>();
    if (!user) throw new AuthError("access_revoked", "This account no longer has access.");
    const session = await createAppSession(c.env.DB, user.id, "desktop");
    return c.json({ status: "approved", token: session.token, user: publicUser(user) });
  });
}
