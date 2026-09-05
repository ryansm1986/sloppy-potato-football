import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";
import { setAuthTransport } from "./auth-api";

const owner = { mode: "google", configured: true, authenticated: true, user: { id: "owner", email: "therealryansmith@gmail.com", name: "Ryan", role: "owner" }, csrfToken: "csrf" };
const signedOut = { ...owner, authenticated: false, user: null, csrfToken: undefined };
function PrivatePage() { const auth = useAuth(); return <div>Private rankings<button onClick={() => void auth.signOut()}>Sign out now</button></div>; }
function app() { render(<MemoryRouter><AuthProvider><PrivatePage /></AuthProvider></MemoryRouter>); }
beforeEach(() => { localStorage.clear(); setAuthTransport({ mode: "legacy" }); delete window.sloppyPotatoDesktop; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setAuthTransport({ mode: "legacy" }); delete window.sloppyPotatoDesktop; });

describe("Google access gate", () => {
  it("does not mount account data before verified access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(signedOut)));
    app();
    expect(screen.queryByText("Private rankings")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByText("Private rankings")).not.toBeInTheDocument();
  });
  it("keeps the gate closed on a desktop startup verification failure", async () => {
    window.sloppyPotatoDesktop = { auth: { status: vi.fn(async () => ({ mode: "legacy", configured: false, authenticated: false, phase: "error", error: "Server unreachable" })) } } as unknown as NonNullable<Window["sloppyPotatoDesktop"]>;
    app();
    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
    expect(screen.queryByText("Private rankings")).not.toBeInTheDocument();
  });
  it("never restores a stale account response after sign-out", async () => {
    let resolveStale!: (value: Response) => void;
    let sessions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/logout") return Response.json({ ok: true });
      sessions += 1;
      if (sessions === 1) return Response.json(owner);
      if (sessions === 2) return new Promise<Response>((resolve) => { resolveStale = resolve; });
      return Response.json(signedOut);
    });
    vi.stubGlobal("fetch", fetchMock); app();
    await screen.findByText("Private rankings");
    act(() => window.dispatchEvent(new Event("spff:session-expired")));
    await waitFor(() => expect(sessions).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Sign out now" }));
    await screen.findByRole("button", { name: "Sign in with Google" });
    await act(async () => resolveStale(Response.json(owner)));
    expect(screen.queryByText("Private rankings")).not.toBeInTheDocument();
  });
  it("preserves existing legacy access only when the server explicitly reports it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ mode: "legacy", configured: false, authenticated: false, user: null })));
    app(); expect(await screen.findByText("Private rankings")).toBeInTheDocument();
  });
});
