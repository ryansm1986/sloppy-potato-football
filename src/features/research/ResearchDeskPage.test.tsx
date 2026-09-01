import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchDeskPage from "./ResearchDeskPage";
import { RESEARCH_OWNER_TOKEN_KEY, type ResearchJob } from "./research-api";

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

const runner = {
  state: "busy" as const,
  provider: "codex",
  lastSeenAt: new Date().toISOString(),
  currentJobId: "job-2",
  jobsToday: 2,
  autoRun: true,
};

function mockBridge(initialJobs: ResearchJob[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/rankings/snapshots")) return Response.json({ snapshots: [] });
    if (url === "/api/research/runner/status") return Response.json({ runner });
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

  it("requires a locally saved owner token in production", () => {
    vi.stubGlobal("fetch", mockBridge());
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(screen.getByRole("button", { name: /queue research/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Research owner token"), { target: { value: "owner-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /save locally/i }));

    expect(window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)).toBe("owner-secret");
    expect(screen.getByText("Owner token saved only in this browser.")).toBeInTheDocument();
  });

  it("queues only a bounded player-research request with bearer auth", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockBridge();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><ResearchDeskPage localDevelopmentOverride={false} /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText("Player name"), { target: { value: "Bijan Robinson" } });
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
