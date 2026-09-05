export type AuthUser = { id: string; email: string; name: string | null; role: "owner" | "researcher" | "viewer" };
export type AuthSession = { mode: "legacy" | "google"; configured: boolean; authenticated: boolean; user: AuthUser | null; csrfToken?: string };
let transport: Pick<AuthSession, "mode" | "csrfToken"> = { mode: "legacy" };
export function setAuthTransport(session: Pick<AuthSession, "mode" | "csrfToken">) { transport = session; }

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
  const localApi = target.origin === window.location.origin && target.pathname.startsWith("/api/");
  if (!localApi || transport.mode !== "google") return fetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (localApi && transport.mode === "google") {
    // Browser authentication uses an HttpOnly cookie; desktop main injects its
    // own app session. Never replay an old owner token in Google mode.
    headers.delete("Authorization");
    headers.delete("X-Research-Owner-Token");
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && transport.csrfToken) headers.set("X-CSRF-Token", transport.csrfToken);
  }
  const response = await fetch(input, { ...init, headers });
  if (localApi && transport.mode === "google" && response.status === 401) window.dispatchEvent(new Event("spff:session-expired"));
  return response;
}

export async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `Request failed (${response.status}).`);
  return body as T;
}
