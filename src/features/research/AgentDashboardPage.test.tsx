import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDashboardPage from "./AgentDashboardPage";
import { DEFAULT_AGENT_SETTINGS, type AgentDashboard } from "./agent-dashboard-api";

const fixture: AgentDashboard = {
  settings: DEFAULT_AGENT_SETTINGS,
  runners: [{ id: "desktop", name: "Draft desktop", provider: "codex", version: "0.1.10", state: "online", currentJobId: null, lastSeenAt: "2026-09-05T12:00:00Z", capabilities: [] }],
  events: [{ id: "event", jobId: "job", type: "progress", actorType: "runner", actorId: "desktop", createdAt: "2026-09-05T12:00:00Z", details: { message: "Researching current evidence" } }],
  jobs: [{ id: "job", type: "rankings_research", status: "completed", subject: "PPR board", sourceName: null, position: "ALL", scoringFormat: "ppr", rankingType: "redraft", leagueSize: 12, createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:02:00Z", startedAt: "2026-09-05T12:00:00Z", completedAt: "2026-09-05T12:02:00Z", attempts: 1, error: null, runnerId: "desktop", researchSettings: DEFAULT_AGENT_SETTINGS, citationCount: 3, insightCount: 4 }],
};
function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/dashboard")) return Response.json(fixture);
    if (url.endsWith("/settings") && init?.method === "PUT") return Response.json({ settings: JSON.parse(String(init.body)) });
    if (url.endsWith("/events")) return Response.json({ events: fixture.events });
    if (url.endsWith("/job")) return Response.json({ job: fixture.jobs[0] });
    return Response.json({ error: "Unexpected URL" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("AgentDashboardPage", () => {
  it("keeps private agent data locked without owner access", () => {
    const fetchMock = mockApi();
    render(<MemoryRouter><AgentDashboardPage localDevelopmentOverride={false} /></MemoryRouter>);
    expect(screen.getByText("Connect your research workspace")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a run from its URL with recorded events and a historical rankings link", async () => {
    mockApi();
    render(<MemoryRouter initialEntries={["/agents?job=job"]}><AgentDashboardPage localDevelopmentOverride /></MemoryRouter>);
    expect(await screen.findByText("Researching current evidence")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open ranking run" })).toHaveAttribute("href", "/rankings?run=job&leagueSize=12");
    expect(screen.getByText("2m 0s")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Job status"), { target: { value: "failed" } });
    expect(screen.getByText("No runs match these filters.")).toBeInTheDocument();
  });

  it("preserves unsaved tuning during refresh and saves exact server preferences", async () => {
    const fetchMock = mockApi();
    render(<MemoryRouter><AgentDashboardPage localDevelopmentOverride /></MemoryRouter>);
    const focus = await screen.findByLabelText("Research focus");
    fireEvent.change(focus, { target: { value: "usage" } });
    fireEvent.change(screen.getByLabelText("Independent source target"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh activity" })).toBeEnabled());
    expect(focus).toHaveValue("usage");
    fireEvent.click(screen.getByRole("button", { name: "Save playbook" }));
    await screen.findByText(/Research settings saved/);
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ ...DEFAULT_AGENT_SETTINGS, focus: "usage", sourceTarget: 10 });
    expect(screen.getByRole("button", { name: "Save playbook" })).toBeDisabled();
  });

  it("shows refresh failures without replacing previously loaded history", async () => {
    const fetchMock = mockApi();
    render(<MemoryRouter><AgentDashboardPage localDevelopmentOverride /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Draft desktop" });
    fetchMock.mockRejectedValueOnce(new Error("Temporary connection error"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary connection error");
    expect(screen.getByRole("heading", { name: "Draft desktop" })).toBeInTheDocument();
  });
});
