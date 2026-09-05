import { describe, expect, it, vi } from "vitest";
import { proxyApiRequest } from "./api-proxy.js";

const base = "https://app.example";
const token = "sp_session_" + "a".repeat(40);
const auth = () => ({ getToken: vi.fn((origin: string) => origin === base ? token : undefined), unauthorized: vi.fn(async () => undefined) });

describe("desktop API session proxy", () => {
  it("injects the main-process session, overriding renderer auth without forwarding cookies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await proxyApiRequest(new Request("potato://app/api/research/jobs", { headers: { authorization: "Bearer legacy", cookie: "stale-browser-cookie" } }), base, fetcher, auth());
    expect(String(fetcher.mock.calls[0][0])).toBe(`${base}/api/research/jobs`);
    const options = fetcher.mock.calls[0][1];
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
    expect(options?.redirect).toBe("manual");
  });

  it("never attaches app sessions to machine endpoints or another configured origin", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
    const bridge = auth();
    await proxyApiRequest(new Request("potato://app/api/runners/heartbeat"), base, fetcher, bridge);
    await proxyApiRequest(new Request("potato://app/api/research/jobs"), "https://different.example", fetcher, bridge);
    for (const call of fetcher.mock.calls) expect(new Headers(call[1]?.headers).has("authorization")).toBe(false);
    expect(bridge.getToken).toHaveBeenCalledTimes(1);
  });

  it("blocks upstream redirects rather than replaying the credential elsewhere", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.redirect("https://evil.example", 302));
    const response = await proxyApiRequest(new Request("potato://app/api/research/jobs"), base, fetcher, auth());
    expect(response.status).toBe(502);
    expect(response.headers.has("location")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/auth/desktop/start", "/api/auth/desktop/poll", "/api/auth/logout"])("prevents renderer access to credential handoff: %s", async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await proxyApiRequest(new Request(`potato://app${path}`), base, fetcher, auth())).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("clears a rejected main-process session", async () => {
    const bridge = auth();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await proxyApiRequest(new Request("potato://app/api/research/jobs"), base, fetcher, bridge);
    expect(bridge.unauthorized).toHaveBeenCalledWith(token, base);
  });

  it.each(["/api/research/runner-credentials", "/api/research/runner-credentials/"])("keeps machine credential minting main-only: %s", async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyApiRequest(new Request(`potato://app${path}`, { method: "POST" }), base, fetcher, auth());
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["/api/auth%2fdesktop%2fpoll", "/api/auth%252fdesktop%252fpoll", "/api/runners%5cheartbeat"])("rejects encoded route-boundary bypasses: %s", async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await proxyApiRequest(new Request(`potato://app${path}`), base, fetcher, auth())).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
