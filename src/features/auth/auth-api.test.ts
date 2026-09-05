import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, setAuthTransport } from "./auth-api";
import { accountStorage } from "./account-storage";
afterEach(() => { vi.unstubAllGlobals(); setAuthTransport({ mode: "legacy" }); localStorage.clear(); });
describe("account request boundaries", () => {
  it("adds CSRF but removes obsolete owner secrets for same-origin mutations", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true })); vi.stubGlobal("fetch", fetchMock);
    setAuthTransport({ mode: "google", csrfToken: "csrf-token" });
    await apiFetch("/api/research/jobs", { method: "POST", headers: { Authorization: "Bearer obsolete-owner", "X-Research-Owner-Token": "obsolete-owner" } });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token"); expect(headers.has("Authorization")).toBe(false); expect(headers.has("X-Research-Owner-Token")).toBe(false);
  });
  it("never attaches the app CSRF token to external URLs", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({})); vi.stubGlobal("fetch", fetchMock);
    setAuthTransport({ mode: "google", csrfToken: "csrf-token" }); await apiFetch("https://external.example/api/news");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("X-CSRF-Token")).toBe(false);
  });
  it("keeps local personal rankings separate across Google accounts", () => {
    localStorage.setItem("rankings", "legacy");
    const first = accountStorage(localStorage, "first"), second = accountStorage(localStorage, "second");
    first.setItem("rankings", "first-board");
    expect(first.getItem("rankings")).toBe("first-board"); expect(second.getItem("rankings")).toBeNull(); expect(localStorage.getItem("rankings")).toBe("legacy");
  });
});
