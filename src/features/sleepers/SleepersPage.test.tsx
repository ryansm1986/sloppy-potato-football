import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_OWNER_TOKEN_KEY } from "../research/research-api";
import SleepersPage from "./SleepersPage";
import type { SleeperReport } from "./sleepers-api";

const report: SleeperReport = {
  id: "report-1",
  season: "2026",
  scoringFormat: "ppr",
  rankingType: "redraft",
  leagueSize: 12,
  summary: "Wide receiver values are strongest in the middle rounds.",
  generatedAt: new Date().toISOString(),
  discoverNewSources: true,
  newPublisherCount: 1,
  positionSummaries: {
    QB: "Wait on quarterback and target rushing upside.",
    RB: "The best backs have clear contingent value.",
    WR: "Prioritize route growth in rounds eight through ten.",
    TE: "Late athletic bets carry the best price.",
  },
  positions: {
    QB: [
      {
        id: "qb-low",
        playerName: "One Source QB",
        team: "MIN",
        position: "QB",
        sourceCount: 1,
        recommendedPickStart: 121,
        recommendedPickEnd: 132,
        recommendedRoundStart: 11,
        recommendedRoundEnd: 11,
        summary: "A late fallback with a stable projection.",
        upside: null,
        risk: "Limited rushing production.",
        sources: [{ publisher: "Example Sports", title: "Late QB values", url: "https://example.com/qb", publishedAt: null, recommendation: null }],
      },
      {
        id: "qb-top",
        playerName: "Consensus QB",
        team: "ARI",
        position: "QB",
        sourceCount: 3,
        recommendedPickStart: 97,
        recommendedPickEnd: 108,
        recommendedRoundStart: 9,
        recommendedRoundEnd: 9,
        summary: "Three analysts highlight the same rushing ceiling.",
        upside: "A top-eight finish if rushing volume holds.",
        risk: "Passing efficiency remains volatile.",
        sources: [
          { publisher: "Fantasy Desk", title: "2026 QB sleepers", url: "https://example.com/one", publishedAt: "2026-08-20T00:00:00.000Z", recommendation: "Target after the first quarterback run.", isNewDiscovery: true },
          { publisher: "Gridiron Lab", title: "Late-round quarterbacks", url: "https://example.org/two", publishedAt: null, recommendation: null },
          { publisher: "Draft Review", title: "Rushing upside", url: "https://example.net/three", publishedAt: null, recommendation: null },
        ],
      },
    ],
    RB: [],
    WR: [{
      id: "wr-1",
      playerName: "Breakout Wideout",
      team: "GB",
      position: "WR",
      sourceCount: 4,
      recommendedPickStart: 88,
      recommendedPickEnd: 104,
      recommendedRoundStart: 8,
      recommendedRoundEnd: 9,
      summary: "An ascending route share at a modest acquisition cost.",
      upside: null,
      risk: null,
      sources: [],
    }],
    TE: [],
  },
};

function mockReport(value: SleeperReport | null = report) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/sleepers/latest") return Response.json({ report: value });
    if (String(input) === "/api/research/jobs" && init?.method === "POST") {
      return Response.json({ job: { id: "job-1", status: "queued" } }, { status: 201 });
    }
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  });
}

describe("SleepersPage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("separates positions and ranks players by recommendation count", async () => {
    vi.stubGlobal("fetch", mockReport());
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Consensus QB" })).toBeInTheDocument();
    const playerNames = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(playerNames.indexOf("Consensus QB")).toBeLessThan(playerNames.indexOf("One Source QB"));
    expect(screen.getByText("Wait on quarterback and target rushing upside.")).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".sleeper-consensus strong" })).toBeInTheDocument();
    expect(screen.getByText("Round 9")).toBeInTheDocument();
    expect(screen.getByText("Picks 97\u2013108")).toBeInTheDocument();
    expect(screen.getByText("1 new publisher found")).toBeInTheDocument();
    const quarterbackPanel = screen.getByRole("tabpanel", { name: /QB 2 sleepers/i });
    expect(within(quarterbackPanel).getByText("Wait on quarterback and target rushing upside.")).toBeInTheDocument();
    expect(within(quarterbackPanel).getByRole("heading", { name: "Consensus QB" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /WR 1/i }));
    expect(screen.getByRole("heading", { name: "Breakout Wideout" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Consensus QB" })).not.toBeInTheDocument();
    expect(screen.getByText("Rounds 8\u20139")).toBeInTheDocument();
  });

  it("moves and activates position tabs with left and right arrow keys", async () => {
    vi.stubGlobal("fetch", mockReport());
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Consensus QB" });
    const quarterbackTab = screen.getByRole("tab", { name: /QB 2 sleepers/i });
    quarterbackTab.focus();
    fireEvent.keyDown(quarterbackTab, { key: "ArrowRight" });

    const runningBackTab = screen.getByRole("tab", { name: /RB 0 sleepers/i });
    expect(runningBackTab).toHaveFocus();
    expect(runningBackTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /RB 0 sleepers/i })).toContainElement(
      screen.getByRole("heading", { name: /No RB sleepers yet/i }),
    );

    fireEvent.keyDown(runningBackTab, { key: "ArrowLeft" });
    expect(quarterbackTab).toHaveFocus();
    expect(quarterbackTab).toHaveAttribute("aria-selected", "true");
  });

  it("expands scouting details with direct source hyperlinks", async () => {
    vi.stubGlobal("fetch", mockReport());
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Consensus QB" });
    fireEvent.click(screen.getByText(/Scouting notes and 3 source links/i));
    const source = screen.getByRole("link", { name: /Fantasy Desk/i });
    expect(source).toHaveAttribute("href", "https://example.com/one");
    expect(source).toHaveAttribute("target", "_blank");
    expect(within(source).getByText("New source")).toBeInTheDocument();
    expect(screen.getByText(/A top-eight finish/i)).toBeInTheDocument();
  });

  it("keeps refresh locked for friends and shows a useful empty state", async () => {
    vi.stubGlobal("fetch", mockReport(null));
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: /No QB sleepers yet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Research sleepers/i })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Add owner access/i })).toHaveAttribute("href", "/research");
  });

  it("shows a clear result when source scouting finds no new publishers", async () => {
    vi.stubGlobal("fetch", mockReport({ ...report, newPublisherCount: 0 }));
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    expect(await screen.findByText("No new publishers found")).toBeInTheDocument();
  });

  it("queues a bounded sleeper assignment with owner authorization", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockReport();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Consensus QB" });
    expect(screen.getByRole("checkbox", { name: /Scout new publishers/i })).toBeChecked();
    fireEvent.change(screen.getByLabelText("League size"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Sleepers per position"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /Research sleepers/i }));

    expect(await screen.findByText(/Sleeper research queued/i)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
    expect(call?.[1]?.headers).toMatchObject({ Authorization: "Bearer owner-secret" });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      type: "sleepers_research",
      scoringFormat: "ppr",
      rankingType: "redraft",
      leagueSize: 14,
      sleepersPerPosition: 10,
      discoverNewSources: true,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Research sleepers/i })).toBeEnabled());
  });

  it("allows the owner to skip source scouting for a faster known-source refresh", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const fetchMock = mockReport();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Consensus QB" });
    const scoutToggle = screen.getByRole("checkbox", { name: /Scout new publishers/i });
    fireEvent.click(scoutToggle);
    expect(scoutToggle).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Research sleepers/i }));

    await screen.findByText(/Sleeper research queued/i);
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/research/jobs" && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ discoverNewSources: false });
  });

  it("polls after dispatch and publishes a newer completed report", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    const updatedReport: SleeperReport = {
      ...report,
      id: "report-2",
      generatedAt: new Date(Date.parse(report.generatedAt) + 60_000).toISOString(),
      summary: "The refreshed board found new late-round receiving value.",
    };
    let reportRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sleepers/latest") {
        reportRequests += 1;
        return Response.json({ report: reportRequests === 1 ? report : updatedReport });
      }
      if (String(input) === "/api/research/jobs" && init?.method === "POST") {
        return Response.json({ job: { id: "job-2", status: "queued" } }, { status: 201 });
      }
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter><SleepersPage localDevelopmentOverride={false} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Consensus QB" });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /Research sleepers/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Sleeper research queued/i)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("The refreshed board found new late-round receiving value.")).toBeInTheDocument();
    expect(screen.getByText(/Sleeper board updated with the completed research report/i)).toBeInTheDocument();
    expect(reportRequests).toBe(2);
  });
});
