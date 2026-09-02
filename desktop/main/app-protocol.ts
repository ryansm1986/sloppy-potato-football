import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { DESKTOP_ORIGIN, normalizeApiBaseUrl, resolveRendererAsset } from "./security.js";

const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface DesktopProtocolOptions {
  rendererRoot: string;
  getApiBaseUrl(): string;
}

export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "potato",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

async function existingAssetOrIndex(rendererRoot: string, pathname: string): Promise<string | null> {
  const candidate = resolveRendererAsset(rendererRoot, pathname);
  if (!candidate) return null;
  try {
    if ((await stat(candidate)).isFile()) return candidate;
  } catch {
    // BrowserRouter routes intentionally fall through to index.html.
  }

  if (path.extname(pathname)) return null;
  return resolveRendererAsset(rendererRoot, "/index.html");
}

async function proxyApiRequest(request: Request, apiBaseUrl: string): Promise<Response> {
  const requestUrl = new URL(request.url);
  const base = normalizeApiBaseUrl(apiBaseUrl);
  const target = `${base}${requestUrl.pathname}${requestUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  return net.fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
  });
}

export function installDesktopProtocol(options: DesktopProtocolOptions): void {
  protocol.handle("potato", async (request) => {
    const url = new URL(request.url);
    if (`${url.protocol}//${url.hostname}` !== DESKTOP_ORIGIN) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return proxyApiRequest(request, options.getApiBaseUrl());
    }

    const asset = await existingAssetOrIndex(options.rendererRoot, url.pathname);
    if (!asset) return new Response("Not found", { status: 404 });

    const response = await net.fetch(pathToFileURL(asset).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", STATIC_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}
