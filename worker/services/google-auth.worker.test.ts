import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../index";
import { authenticateAppRequest, bindGoogleIdentity, createAppSession, hashAuthToken, personalIdentity, validateGoogleClaims, type AuthBindings, type AuthRole } from "./google-auth";

const origin = "https://potato.example";
const bindings: AuthBindings & { RESEARCH_OWNER_TOKEN: string; AGENT_RUNNER_TOKEN: string } = {
  DB: env.DB, AUTH_MODE: "google", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "not-a-real-secret",
  APP_BASE_URL: origin, OWNER_GOOGLE_EMAIL: "therealryansmith@gmail.com", RESEARCH_OWNER_TOKEN: "legacy-owner", AGENT_RUNNER_TOKEN: "legacy-runner",
};
const ownerIdentity = { sub: "google-owner-123", email: "therealryansmith@gmail.com", name: "Ryan" };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let nextGoogleToken: Record<string, string> = {};
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [{ ...jwk, kid: "auth-test-key", alg: "RS256", use: "sig" }] });
    if (url === "https://oauth2.googleapis.com/token") return Response.json(nextGoogleToken);
    throw new Error("Unexpected network request in auth test");
  }));
});
afterAll(() => vi.unstubAllGlobals());
async function member(role: AuthRole = "viewer", kind: "browser" | "desktop" = "desktop") {
  const identity = role === "owner" ? ownerIdentity : { sub: `google-${crypto.randomUUID()}`, email: `friend-${crypto.randomUUID()}@gmail.com`, name: "Friend" };
  if (role !== "owner") await env.DB.prepare("INSERT INTO auth_users (id,email,role,status,created_at,updated_at) VALUES (?,?,?,'invited',?,?)").bind(crypto.randomUUID(), identity.email, role, Date.now(), Date.now()).run();
  const user = await bindGoogleIdentity(bindings, identity);
  return { user, ...(await createAppSession(env.DB, user.id, kind)) };
}
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, config = bindings) {
  return app.request(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, config);
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("invite-only Google access", () => {
  it("leaves legacy mode unchanged, and fails closed when Google mode is not configured", async () => {
    const legacy = await request("/api/auth/session", "GET", undefined, {}, { ...bindings, AUTH_MODE: "legacy" });
    expect(await legacy.json()).toMatchObject({ mode: "legacy", authenticated: false, user: null });
    expect((await request("/api/players", "GET", undefined, {}, { ...bindings, AUTH_MODE: "legacy" })).status).toBe(200);
    expect((await request("/api/players", "GET", undefined, {}, { ...bindings, GOOGLE_CLIENT_SECRET: "" })).status).toBe(503);
    expect((await request("/api/players", "GET", undefined, bearer("legacy-owner"), { ...bindings, AUTH_MODE: "GOOGLE" })).status).toBe(503);
    const unavailable = await request("/api/auth/session", "GET", undefined, {}, { ...bindings, GOOGLE_CLIENT_SECRET: "" });
    expect(await unavailable.json()).toMatchObject({ mode: "google", configured: false, authenticated: false });
  });

  it("does not let old owner tokens or unauthenticated requests bypass Google membership", async () => {
    for (const path of ["/api/players", "/api/rankings/snapshots", "/api/sleepers/latest", "/api/research/jobs", "/api/publishers"]) {
      expect((await request(path, "GET", undefined, bearer("legacy-owner"))).status).toBe(401);
    }
    expect((await request("/api/health")).status).toBe(200);
    const machine = await request("/api/runners/heartbeat", "POST", { runnerId: "auth-test-machine", provider: "codex", status: "idle", capabilities: [] }, bearer("legacy-runner"));
    expect(machine.status).toBe(200);
    const user = await member("owner");
    expect((await request("/api/runners/heartbeat", "POST", {}, bearer(user.token))).status).toBe(401);
  });

  it("binds the configured owner, rejects strangers and prevents subject replacement", async () => {
    await expect(bindGoogleIdentity(bindings, { sub: "stranger", email: "stranger@gmail.com", name: null })).rejects.toMatchObject({ code: "invite_required" });
    const owner = await bindGoogleIdentity(bindings, ownerIdentity);
    expect(owner.role).toBe("owner");
    await expect(bindGoogleIdentity(bindings, { ...ownerIdentity, sub: "imposter" })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(personalIdentity(owner)).toBe("primary-owner");
    const viewer = await member();
    expect(personalIdentity(viewer.user)).toBe(viewer.user.id);
  });

  it("rejects unverified email, wrong nonce and wrong authorized party", () => {
    const valid = { sub: "google-123", email: "friend@gmail.com", email_verified: true, nonce: "nonce" };
    expect(validateGoogleClaims(valid, "nonce", "client")).toMatchObject({ email: "friend@gmail.com" });
    for (const claims of [{ ...valid, email_verified: false }, { ...valid, nonce: "different" }, { ...valid, azp: "other-client" }]) {
      expect(() => validateGoogleClaims(claims, "nonce", "client")).toThrow();
    }
    expect(() => validateGoogleClaims({ ...valid, email: "friend@third-party.example" }, "nonce", "client")).toThrow("Google Workspace");
    expect(validateGoogleClaims({ ...valid, email: "friend@managed.example", hd: "managed.example" }, "nonce", "client")).toMatchObject({ email: "friend@managed.example" });
  });

  it("enforces viewer/researcher/owner permissions and isolates personal rankings", async () => {
    const viewer = await member();
    expect((await request("/api/research/jobs", "POST", { type: "player_research", subject: "Josh Allen" }, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/research/schedules", "POST", {}, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/auth/users", "GET", undefined, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/research/runner-credentials", "GET", undefined, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/research/agents/dashboard", "GET", undefined, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/research/jobs", "GET", undefined, bearer(viewer.token))).status).toBe(403);
    expect((await request("/api/research/personal-rankings?season=2026&scoringFormat=ppr&rankingType=redraft", "GET", undefined, bearer(viewer.token))).status).toBe(200);
    const researcher = await member("researcher");
    const queued = await request("/api/research/jobs", "POST", { type: "player_research", subject: "Josh Allen" }, bearer(researcher.token));
    expect(queued.status).toBe(201);
    expect((await request("/api/research/agents/settings", "PUT", {}, bearer(researcher.token))).status).toBe(403);
    expect((await request("/api/research/runner-credentials", "POST", {}, bearer(researcher.token))).status).toBe(403);
    expect((await request("/api/publishers/example", "PATCH", { blocked: true }, bearer(researcher.token))).status).toBe(403);
    const result = await queued.json() as { job: { id: string } };
    expect(await env.DB.prepare("SELECT actor_id FROM research_job_events WHERE job_id = ? AND event_type = 'queued'").bind(result.job.id).first()).toMatchObject({ actor_id: researcher.user.id });
  });

  it("requires same-origin CSRF for browser mutations but permits main-process bearer sessions", async () => {
    const owner = await member("owner", "browser");
    const cookie = { Cookie: `__Host-sp_session=${owner.token}` };
    const invitation = { email: `invited-${crypto.randomUUID()}@gmail.com` };
    expect((await request("/api/auth/users", "POST", invitation, cookie)).status).toBe(403);
    expect((await request("/api/auth/users", "POST", invitation, { ...cookie, Origin: "https://evil.example", "X-CSRF-Token": owner.csrfToken })).status).toBe(403);
    const accepted = await request("/api/auth/users", "POST", invitation, { ...cookie, Origin: origin, "X-CSRF-Token": owner.csrfToken });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ user: { email: invitation.email, role: "viewer", status: "invited" } });
    const session = await request("/api/auth/session", "GET", undefined, cookie);
    expect(await session.json()).toMatchObject({ authenticated: true, csrfToken: owner.csrfToken, user: { role: "owner" } });
    expect(session.headers.get("Cache-Control")).toBe("no-store");
    expect(await authenticateAppRequest(bindings, new Request(`${origin}/api/players`, { headers: bearer(owner.token) }))).toBeUndefined();
  });

  it("saves each viewer's board separately and preserves the owner's legacy board", async () => {
    const first = await member(), second = await member(), owner = await member("owner");
    const playerId = `auth-player:${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO players (id,full_name,search_name,position,nfl_team) VALUES (?,'Test Player','testplayer','RB','ATL')").bind(playerId).run();
    const scope = { season: "2077", scoringFormat: "ppr", rankingType: "redraft" };
    const url = `/api/research/personal-rankings?${new URLSearchParams(scope)}`;
    expect((await request("/api/research/personal-rankings", "PUT", { ...scope, playerIds: [playerId] }, bearer(first.token))).status).toBe(200);
    expect(await (await request(url, "GET", undefined, bearer(second.token))).json()).toEqual({ board: null });
    expect(await (await request(url, "GET", undefined, bearer(first.token))).json()).toMatchObject({ board: { entries: [{ id: playerId }] } });
    const legacy = await request("/api/research/personal-rankings", "PUT", { ...scope, playerIds: [] }, bearer("legacy-owner"), { ...bindings, AUTH_MODE: "legacy" });
    expect(legacy.status).toBe(200);
    const oldBoard = await legacy.json() as { board: { id: string } };
    expect(await (await request(url, "GET", undefined, bearer(owner.token))).json()).toMatchObject({ board: { id: oldBoard.board.id, entries: [] } });
  });

  it("keeps publisher preferences personal while only the owner changes shared policy", async () => {
    const first = await member(), second = await member();
    const domain = `auth-${crypto.randomUUID()}.example`, id = `publisher:${domain}`;
    await env.DB.prepare("INSERT INTO publishers (id,domain,name,url,first_seen_at,last_seen_at) VALUES (?,?,'Auth Test',?,?,?)").bind(id, domain, `https://${domain}`, Date.now(), Date.now()).run();
    const preferences = await request(`/api/publishers/${encodeURIComponent(id)}/preferences`, "PUT", { favorite: true, excluded: true }, bearer(first.token));
    expect(preferences.status).toBe(200);
    const firstList = await (await request(`/api/publishers?search=${domain}`, "GET", undefined, bearer(first.token))).json();
    const secondList = await (await request(`/api/publishers?search=${domain}`, "GET", undefined, bearer(second.token))).json();
    expect(firstList).toMatchObject({ publishers: [{ favorite: true, excluded: true }] });
    expect(secondList).toMatchObject({ publishers: [{ favorite: false, excluded: false }] });
    expect((await request(`/api/publishers/${encodeURIComponent(id)}`, "PATCH", { blocked: true }, bearer(first.token))).status).toBe(403);
  });

  it("revokes browser and desktop sessions immediately and protects the owner role", async () => {
    const owner = await member("owner");
    const viewer = await member();
    const browser = await createAppSession(env.DB, viewer.user.id, "browser");
    const revoked = await request(`/api/auth/users/${viewer.user.id}`, "PATCH", { status: "revoked" }, bearer(owner.token));
    expect(revoked.status).toBe(200);
    expect((await request("/api/players", "GET", undefined, bearer(viewer.token))).status).toBe(401);
    expect((await request("/api/players", "GET", undefined, { Cookie: `__Host-sp_session=${browser.token}` })).status).toBe(401);
    expect((await request(`/api/auth/users/${owner.user.id}`, "PATCH", { role: "viewer" }, bearer(owner.token))).status).toBe(403);
    expect((await request(`/api/auth/users/${owner.user.id}`, "PATCH", { status: "revoked" }, bearer(owner.token))).status).toBe(403);
  });

  it("rejects expired sessions and revokes only the current session on logout", async () => {
    const viewer = await member();
    const other = await createAppSession(env.DB, viewer.user.id, "desktop");
    expect((await request("/api/auth/logout", "POST", {}, bearer(viewer.token))).status).toBe(200);
    expect((await request("/api/players", "GET", undefined, bearer(viewer.token))).status).toBe(401);
    expect((await request("/api/players", "GET", undefined, bearer(other.token))).status).toBe(200);
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1, other.tokenHash).run();
    expect((await request("/api/players", "GET", undefined, bearer(other.token))).status).toBe(401);
  });

  it("completes signed Google OIDC with PKCE, then refuses replay", async () => {
    const started = await request("/api/auth/google/start");
    expect(started.status).toBe(302);
    const authorization = new URL(started.headers.get("Location")!);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const flowCookie = started.headers.get("Set-Cookie")!.split(";")[0]!;
    expect(started.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(started.headers.get("Set-Cookie")).toContain("Secure");
    const state = authorization.searchParams.get("state")!;
    const flow = await env.DB.prepare("SELECT verifier FROM auth_oauth_flows WHERE state_hash = ?").bind(await hashAuthToken(state)).first<{ verifier: string }>();
    expect(await hashAuthToken(flow!.verifier)).toBe(authorization.searchParams.get("code_challenge"));
    const jwt = await new SignJWT({ email: ownerIdentity.email, email_verified: true, name: "Ryan", nonce: authorization.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256", kid: "auth-test-key" }).setIssuer("https://accounts.google.com").setAudience(bindings.GOOGLE_CLIENT_ID!).setSubject(ownerIdentity.sub).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    nextGoogleToken = { id_token: jwt, access_token: "never-return-this" };
    const callbackPath = `/api/auth/google/callback?code=auth-code&state=${state}`;
    const callback = await request(callbackPath, "GET", undefined, { Cookie: flowCookie });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(`${origin}/`);
    expect(callback.headers.get("Set-Cookie")).toContain("__Host-sp_session=sp_session_");
    expect(callback.headers.get("Set-Cookie")).not.toContain("never-return-this");
    expect((await request(callbackPath, "GET", undefined, { Cookie: flowCookie })).status).toBe(403);
  });

  it("rejects wrong issuer/audience, expiration and signature, and binds state to its browser", async () => {
    for (const wrongClaim of ["issuer", "audience", "expired", "signature"]) {
      const started = await request("/api/auth/google/start");
      const authorization = new URL(started.headers.get("Location")!);
      const cookie = started.headers.get("Set-Cookie")!.split(";")[0]!;
      let jwt = await new SignJWT({ email: ownerIdentity.email, email_verified: true, nonce: authorization.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "RS256", kid: "auth-test-key" }).setIssuer(wrongClaim === "issuer" ? "https://evil.example" : "https://accounts.google.com")
        .setAudience(wrongClaim === "audience" ? "another-client" : bindings.GOOGLE_CLIENT_ID!).setSubject(ownerIdentity.sub).setIssuedAt().setExpirationTime(wrongClaim === "expired" ? Math.floor(Date.now() / 1000) - 120 : "5m").sign(keys.privateKey);
      if (wrongClaim === "signature") {
        const offset = jwt.lastIndexOf(".") + 1;
        jwt = jwt.slice(0, offset) + (jwt[offset] === "A" ? "B" : "A") + jwt.slice(offset + 1);
      }
      nextGoogleToken = { id_token: jwt };
      const callbackPath = `/api/auth/google/callback?code=auth-code&state=${authorization.searchParams.get("state")}`;
      expect((await request(callbackPath)).status).toBe(403);
      const rejected = await request(callbackPath, "GET", undefined, { Cookie: cookie });
      expect(rejected.headers.get("Location")).toContain("authError=google_sign_in_failed");
      expect(rejected.headers.get("Set-Cookie")).not.toContain("__Host-sp_session=sp_session_");
    }
  });

  it("requires explicit browser confirmation and one-time secret-bound desktop redemption", async () => {
    const started = await request("/api/auth/desktop/start", "POST", {});
    const handoff = await started.json() as { requestId: string; deviceSecret: string; verificationUrl: string };
    expect(handoff.verificationUrl).not.toContain(handoff.deviceSecret);
    expect((await request("/api/auth/desktop/poll", "POST", { requestId: handoff.requestId, deviceSecret: "x".repeat(43) })).status).toBe(403);
    const pollBody = { requestId: handoff.requestId, deviceSecret: handoff.deviceSecret };
    expect(await (await request("/api/auth/desktop/poll", "POST", pollBody)).json()).toEqual({ status: "pending" });
    const owner = await member("owner", "browser");
    const unbound = await app.request(`${origin}/api/auth/desktop/approve`, { method: "POST", headers: { Cookie: `__Host-sp_session=${owner.token}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ requestId: handoff.requestId, csrfToken: owner.csrfToken }) }, bindings);
    expect(unbound.status).toBe(403);
    const googleStart = await request(`/api/auth/google/start?desktop=${handoff.requestId}`);
    const authorization = new URL(googleStart.headers.get("Location")!);
    const jwt = await new SignJWT({ email: ownerIdentity.email, email_verified: true, nonce: authorization.searchParams.get("nonce") })
      .setProtectedHeader({ alg: "RS256", kid: "auth-test-key" }).setIssuer("https://accounts.google.com").setAudience(bindings.GOOGLE_CLIENT_ID!).setSubject(ownerIdentity.sub).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    nextGoogleToken = { id_token: jwt };
    const callback = await request(`/api/auth/google/callback?code=desktop-code&state=${authorization.searchParams.get("state")}`, "GET", undefined, { Cookie: googleStart.headers.get("Set-Cookie")!.split(";")[0]! });
    expect(callback.status).toBe(200);
    const confirmation = await callback.text();
    expect(confirmation).toContain("Only confirm if");
    const browserToken = callback.headers.get("Set-Cookie")!.match(/__Host-sp_session=(sp_session_[A-Za-z0-9_-]+)/)![1]!;
    const csrf = confirmation.match(/name="csrfToken" value="([A-Za-z0-9_-]+)"/)![1]!;
    const approve = await app.request(`${origin}/api/auth/desktop/approve`, { method: "POST", headers: { Cookie: `__Host-sp_session=${browserToken}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ requestId: handoff.requestId, csrfToken: csrf }) }, bindings);
    expect(approve.status).toBe(200);
    expect(await approve.text()).toContain("Computer connected");
    const approved = await request("/api/auth/desktop/poll", "POST", pollBody);
    const result = await approved.json() as { status: string; token: string; user: { role: string } };
    expect(result).toMatchObject({ status: "approved", user: { role: "owner" } });
    expect(result.token).toMatch(/^sp_session_/);
    expect((await request("/api/players", "GET", undefined, bearer(result.token))).status).toBe(200);
    expect((await request("/api/auth/desktop/poll", "POST", pollBody)).status).toBe(403);
    const rows = await env.DB.prepare("SELECT token_hash FROM auth_sessions WHERE user_id = ?").bind(owner.user.id).all();
    expect(JSON.stringify(rows)).not.toContain(result.token);
  });

  it("throttles shared browser/desktop starts, recovers next minute, and leaves polling alone", async () => {
    const address = "192.0.2.100";
    const headers = { "CF-Connecting-IP": address };
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = await request("/api/auth/desktop/start", "POST", {}, headers);
      const handoff = await first.json() as { requestId: string; deviceSecret: string };
      expect(first.status).toBe(200);
      for (let index = 1; index < 10; index++) expect((await request("/api/auth/google/start", "GET", undefined, headers)).status).toBe(302);
      const blocked = await request("/api/auth/desktop/start", "POST", {}, headers);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect((await request("/api/auth/google/start", "GET", undefined, headers)).status).toBe(429);
      expect(await (await request("/api/auth/desktop/poll", "POST", { requestId: handoff.requestId, deviceSecret: handoff.deviceSecret }, headers)).json()).toEqual({ status: "pending" });
      const buckets = await env.DB.prepare("SELECT bucket_key FROM auth_start_limits").all();
      expect(JSON.stringify(buckets)).not.toContain(address);
      clock.mockReturnValue(now + 60_000);
      expect((await request("/api/auth/desktop/start", "POST", {}, headers)).status).toBe(200);
      clock.mockReturnValue(now + 180_000);
      expect((await request("/api/auth/desktop/start", "POST", {}, headers)).status).toBe(200);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM auth_start_limits WHERE expires_at <= ?").bind(now + 180_000).first()).toEqual({ count: 0 });
    } finally { clock.mockRestore(); }
  });
});
