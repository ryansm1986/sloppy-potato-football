import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    if (url === "/api/research/schedules" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return Response.json({ schedule: {
        id: "schedule-1",
        ...body,
        nextRunAt: "2026-09-07T14:00:00.000Z",
        lastRunAt: null,
        lastJobId: null,
        createdAt: "2026-09-02T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:00.000Z",
      } }, { status: 201 });
    }
    if (url === "/api/research/schedules") return Response.json({ schedules: [] });
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
    expect(screen.getByText(/Set up owner access in Settings to unlock runner status/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manage runner settings/i })).toHaveAttribute("href", "/settings");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/research/runner/status", expect.anything());
    expect(screen.queryByRole("heading", { name: /Owner token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Connected Runners/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Desktop runner controls")).not.toBeInTheDocument();
  });

  it("prefills player research from a ranking-row link", () => {
    vi.stubGlobal("fetch", mockBridge());
    render(<MemoryRouter initialEntries={["/research?subject=Malik%20Nabers"]}><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(screen.getByLabelText("Player name")).toHaveValue("Malik Nabers");
  });

  it.each([401, 403])("keeps the runner locked when the saved token is rejected with %s", async (status) => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "wrong-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/rankings/snapshots")) return Response.json({ snapshots: [] });
      return Response.json({ error: "Unauthorized" }, { status });
    }));
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Owner access was rejected/i);
    expect(screen.getAllByText(/runner locked/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /queue research/i })).toBeDisabled();
    expect(screen.queryByText(/runner offline/i)).not.toBeInTheDocument();
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
      leagueSize: 12,
    });
    expect(String(init.body)).not.toContain("prompt");
  });

  it("sends a configurable ranking count up to 500", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.click(screen.getByLabelText("Rankings research"));
    expect(screen.getByRole("checkbox", { name: /Scout new publishers/i })).toBeChecked();
    const limit = screen.getByLabelText("Number of players");
    expect(limit).toHaveValue(100);
    fireEvent.change(limit, { target: { value: "500" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /queue research/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /queue research/i }));

    const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      type: "rankings_research",
      position: "ALL",
      rankingLimit: 500,
      discoverNewSources: true,
    });

    fireEvent.change(limit, { target: { value: "501" } });
    expect(screen.getByRole("button", { name: /queue research/i })).toBeDisabled();
  });

  it("creates a cloud schedule from the current bounded assignment", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.click(screen.getByLabelText("Rankings research"));
    fireEvent.change(screen.getByLabelText("Number of players"), { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("Schedule name"), { target: { value: "Monday rankings" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /schedule current assignment/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /schedule current assignment/i }));

    expect(await screen.findByText(/Scheduled Monday rankings/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/schedules" && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      name: "Monday rankings",
      enabled: true,
      daysOfWeek: [1, 2, 3, 4, 5],
      job: {
        type: "rankings_research",
        rankingLimit: 250,
        leagueSize: 12,
        discoverNewSources: true,
      },
    });
  });

  it("shares the selected league size and submits it for every assignment type", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    const leagueSize = screen.getByLabelText("League size");
    expect(leagueSize).toHaveValue("12");
    fireEvent.change(leagueSize, { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Player name"), { target: { value: "CeeDee Lamb" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /queue research/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /queue research/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
      expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ leagueSize: 14 });
    });
    expect(window.localStorage.getItem("spff:league-size:v1")).toBe("14");
    expect(fetchMock).toHaveBeenCalledWith("/api/rankings/snapshots?limit=100&leagueSize=14", expect.anything());
  });

  it("allows ranking research to opt out of scouting new publishers", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.click(screen.getByLabelText("Rankings research"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Scout new publishers/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /queue research/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /queue research/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
      expect(createCall).toBeDefined();
      expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
        type: "rankings_research",
        discoverNewSources: false,
      });
    });
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

  it("filters queue history and loads more history on demand", async () => {
    vi.stubGlobal("fetch", mockBridge([failedJob, { ...failedJob, id: "queued", subject: "Josh Allen", status: "queued", error: null }]));
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride /></MemoryRouter>);
    const queue = within(screen.getByRole("region", { name: "Research job queue" }));
    await queue.findByText("Josh Allen");
    fireEvent.change(queue.getByLabelText("Status"), { target: { value: "active" } });
    expect(queue.queryByText("Bijan Robinson")).not.toBeInTheDocument();
    expect(queue.getByText("Josh Allen")).toBeInTheDocument();
    fireEvent.change(queue.getByLabelText("Find a job"), { target: { value: "missing" } });
    expect(queue.getByText("No jobs match these filters.")).toBeInTheDocument();
    fireEvent.change(queue.getByLabelText("History"), { target: { value: "100" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/research/jobs?limit=100", expect.anything()));
  });

  it("refreshes rankings when a job completes without downloading them on unchanged refreshes", async () => {
    let complete = false;
    const base = mockBridge();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/research/jobs?")) return Response.json({ jobs: [{ ...failedJob, status: complete ? "completed" : "running" }] });
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride /></MemoryRouter>);
    await screen.findByText("Runner busy");
    const snapshotCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/rankings/snapshots")).length;
    const initialCalls = snapshotCalls();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(snapshotCalls()).toBe(initialCalls);
    complete = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(snapshotCalls()).toBe(initialCalls + 1));
  });

});
