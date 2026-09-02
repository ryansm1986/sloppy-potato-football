import path from "node:path";

export const DESKTOP_ORIGIN = "potato://app";

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isTrustedRendererUrl(value: string, devServerUrl?: string): boolean {
  try {
    const candidate = new URL(value);
    if (candidate.protocol === "potato:" && candidate.hostname === "app") {
      return true;
    }

    if (!devServerUrl) return false;
    const developmentOrigin = new URL(devServerUrl).origin;
    return candidate.origin === developmentOrigin;
  } catch {
    return false;
  }
}

/** Returns a safe path below rendererRoot, or null for malformed/traversal paths. */
export function resolveRendererAsset(rendererRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^[/\\]+/, "").replaceAll("\\", "/");
  const candidate = path.resolve(rendererRoot, relative || "index.html");
  const relativeToRoot = path.relative(path.resolve(rendererRoot), candidate);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) return null;
  return candidate;
}

export function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  const isLocalDevelopment =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("The API URL must use HTTPS (HTTP is allowed only for localhost)." );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
