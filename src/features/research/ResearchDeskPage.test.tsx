import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchDeskPage from "./ResearchDeskPage";
import { RESEARCH_OWNER_TOKEN_KEY, type ResearchJob, type RunnerStatus } from "./research-api";

const failedJob: ResearchJob = {
  id: "job-1",
  type: "player_research",
  status: "failed",
  subject: "Bijan Robinson",
  sourceName: null,
  scoringFormat: "ppr",
  rankingType: "redraft",
  position: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:01:00.000Z",
  startedAt: "2026-09-01T12:00:30.000Z",
  completedAt: null,
  attempts: 1,
  error: "Provider temporarily unavailable",
};

const runner: RunnerStatus = {
  state: "busy",
  provider: "codex",
  lastSeenAt: new Date().toISOString(),
  currentJobId: "job-2",
  jobsToday: 2,
  autoRun: true,
};

function mockBridge(initialJobs: ResearchJob[] = [], runnerResponse = runner) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/rankings/snapshots")) return Response.json({ snapshots: [] });
    if (url === "/api/research/runner/status") return Response.json({ runner: runnerResponse });
    if (url.startsWith("/api/research/jobs/job-1/retry")) return Response.json({ job: { ...failedJob, status: "queued", error: null } });
    if (url === "/api/research/jobs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { type: ResearchJob["type"]; subject?: string };
      return Response.json({ job: { ...failedJob, id: "job-created", type: body.type, subject: body.subject ?? null, status: "queued", error: null } }, { status: 201 });
    }
    if (url.startsWith("/api/research/jobs?")) return Response.json({ jobs: initialJobs });
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  });
}

describe("ResearchDeskPage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a locked runner when production has no owner token", () => {
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(screen.getByRole("button", { name: /queue research/i })).toBeDisabled();
    expect(screen.getAllByText(/runner locked/i)).toHaveLength(1);
    expect(screen.getByText(/Save your owner token below to unlock runner status/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/research/runner/status", expect.anything());
  });

  it("saves an owner token locally and begins verification", () => {
    vi.stubGlobal("fetch", mockBridge());
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText("Research owner token"), { target: { value: "owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /save locally/i }));

    expect(window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)).toBe("owner-secret");
    expect(screen.getByText("Owner token saved only in this browser.")).toBeInTheDocument();
  });

  it.each([401, 403])("keeps the runner locked when the saved token is rejected with %s", async (status) => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "wrong-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/rankings/snapshots")) return Response.json({ snapshots: [] });
      return Response.json({ error: "Unauthorized" }, { status });
    }));
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText(/This owner token was rejected/i)).toBeInTheDocument();
    expect(screen.getAllByText(/runner locked/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /queue research/i })).toBeDisabled();
    expect(screen.queryByText(/runner offline/i)).not.toBeInTheDocument();
  });

  it("unlocks after replacing a rejected token and locks again when it is removed", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "wrong-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/rankings/snapshots")) return Response.json({ snapshots: [] });
      const authorized = (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer owner-secret";
      if (!authorized) return Response.json({ error: "Forbidden" }, { status: 403 });
      if (url === "/api/research/runner/status") return Response.json({ runner: { ...runner, state: "online", currentJobId: null } });
      if (url.startsWith("/api/research/jobs?")) return Response.json({ jobs: [] });
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    }));
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText(/This owner token was rejected/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Research owner token"), { target: { value: "owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /save locally/i }));

    expect(await screen.findByText("Runner online")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(screen.getByText("Runner locked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "locked" })).toBeInTheDocument();
    expect(screen.getByText(/Save your owner token below to unlock runner status/i)).toBeInTheDocument();
    expect(window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)).toBeNull();
  });

  it.each(["offline", "online"] as const)("shows an authorized %s runner", async (state) => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    vi.stubGlobal("fetch", mockBridge([], {
      ...runner,
      state,
      currentJobId: null,
    }));
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText(`Runner ${state}`)).toBeInTheDocument();
    expect(screen.queryByText(/runner locked/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Owner access ready/i)).toBeInTheDocument();
  });

  it("queues only a bounded player-research request with bearer auth", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText("Player name"), { target: { value: "Bijan Robinson" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /queue research/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /queue research/i }));

    expect(await screen.findByText(/Research job queued/)).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
    expect(createCall).toBeDefined();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer owner-secret" });
    expect(JSON.parse(String(init.body))).toEqual({
      type: "player_research",
      subject: "Bijan Robinson",
      scoringFormat: "ppr",
      rankingType: "redraft",
    });
    expect(String(init.body)).not.toContain("prompt");
  });

  it("shows runner state and retries a failed cloud job", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge([failedJob]);
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText("Provider temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByText("Runner busy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry Bijan Robinson" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/research/jobs/job-1/retry",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText("Research job returned to the queue.")).toBeInTheDocument();
  });
});
