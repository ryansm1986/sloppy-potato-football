import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_OWNER_TOKEN_KEY } from "../research/research-api";
import SettingsPage from "./SettingsPage";

const credential = {
  id: "credential-1",
  deviceId: "install-1",
  runnerId: "desktop-abc123",
  name: "Kitchen desktop",
  tokenHint: "spfr_1234...abcd",
  metadata: { platform: "win32" },
  active: true,
  lastUsedAt: "2026-09-02T12:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

function mockSettingsBridge() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorized = (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer owner-secret";
    if (!authorized) return Response.json({ error: "Forbidden" }, { status: 403 });
    if (url === "/api/research/runner/status") return Response.json({ runner: null });
    if (url === "/api/research/runner-credentials") return Response.json({ credentials: [credential] });
    if (url === `/api/research/runner-credentials/${credential.id}` && init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  });
}

describe("SettingsPage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("makes Settings the home for owner access and explains desktop-only setup on the web", () => {
    vi.stubGlobal("fetch", mockSettingsBridge());
    render(<MemoryRouter><SettingsPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Owner access" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Desktop runner" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connected Computers" })).toBeInTheDocument();
    expect(screen.getByText(/Open Settings in the Sloppy Potato desktop app/i)).toBeInTheDocument();
  });

  it("saves and verifies owner access without rendering the saved token", async () => {
    const fetchMock = mockSettingsBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><SettingsPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText("Research owner token"), { target: { value: "owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & verify/i }));

    expect(window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)).toBe("owner-secret");
    expect(await screen.findByText("Private bridge unlocked")).toBeInTheDocument();
    expect(screen.getByLabelText("Research owner token")).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith("/api/research/runner/status", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer owner-secret" }),
    }));
  });

  it("lists and revokes a connected computer with confirmation", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockSettingsBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><SettingsPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText("Kitchen desktop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Kitchen desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke Kitchen desktop" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/research/runner-credentials/${credential.id}`,
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ Authorization: "Bearer owner-secret" }) }),
    ));
    expect(await screen.findByText(/Kitchen desktop was revoked/)).toBeInTheDocument();
    expect(screen.getByText(/^Revoked ·/)).toBeInTheDocument();
  });

  it("lets the user remove rejected access", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "wrong-secret");
    vi.stubGlobal("fetch", mockSettingsBridge());
    render(<MemoryRouter><SettingsPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText(/This owner token was rejected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)).toBeNull();
    expect(screen.getByText("Owner access is not set up")).toBeInTheDocument();
  });
});
