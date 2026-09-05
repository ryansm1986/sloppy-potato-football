import { normalizeApiBaseUrl } from "./security.js";

export interface ApiProxyAuth {
  getToken(apiBaseUrl: string): string | undefined;
  unauthorized(token: string, apiBaseUrl: string): Promise<void>;
}

export async function proxyApiRequest(request: Request, apiBaseUrl: string, fetcher: typeof fetch, auth?: ApiProxyAuth): Promise<Response> {
  const requestUrl = new URL(request.url);
  const base = normalizeApiBaseUrl(apiBaseUrl);
  let pathname: string;
  try { pathname = decodeURIComponent(requestUrl.pathname); } catch { return new Response("Invalid API path.", { status: 400 }); }
  // Reject encoded separators outright: the route we classify must match the upstream route.
  if (/%(?:2f|5c|25)/i.test(requestUrl.pathname) || pathname.includes("\\")) return new Response("Invalid API path.", { status: 400 });
  // These endpoints mint credentials and must only be called by main-process IPC.
  if (pathname === "/api/auth/desktop" || pathname.startsWith("/api/auth/desktop/") || pathname === "/api/auth/logout"
    || (request.method.toUpperCase() === "POST" && /^\/api\/research\/runner-credentials\/?$/.test(pathname))) {
    return Response.json({ error: "Use the desktop sign-in controls for authentication." }, { status: 403 });
  }
  const target = new URL(`${base}${requestUrl.pathname}${requestUrl.search}`);
  if (target.origin !== new URL(base).origin) return new Response("Invalid API destination.", { status: 400 });
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");
  const machineRoute = pathname === "/api/runners" || pathname.startsWith("/api/runners/");
  const token = machineRoute ? undefined : auth?.getToken(base);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await fetcher(target, { method, headers, body, redirect: "manual", credentials: "omit" });
  if (response.status >= 300 && response.status < 400) {
    return new Response("The configured API returned an unsafe redirect.", { status: 502 });
  }
  if (response.status === 401 && token) await auth?.unauthorized(token, base);
  return response;
}
