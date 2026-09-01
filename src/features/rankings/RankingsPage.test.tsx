import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RankingsPage from "./RankingsPage";
import { RESEARCH_OWNER_TOKEN_KEY } from "../research/research-api";

const agentSnapshot = {
  id: "snapshot-1",
  source: { id: "source-1", canonicalKey: "agent:codex-rank-agent", slug: "codex-rank-agent", name: "Codex Rank Agent", kind: "agent" as const, provider: "codex" },
  title: "September PPR Refresh",
  scoringFormat: "ppr",
  rankingType: "redraft",
  season: "2026",
  week: null,
  generatedAt: "2026-09-01T12:00:00.000Z",
  summary: "A structured test snapshot.",
  methodology: null,
  entries: [
    { id: "entry-1", playerId: null, playerName: "Malik Nabers", position: "WR", team: "NYG", rank: 1, previousRank: 4, tier: 1, insight: "Target volume." },
    { id: "entry-2", playerId: null, playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 2, previousRank: 1, tier: 1, insight: "Elite ceiling." },
  ],
};

const secondExpertSnapshot = {
  ...agentSnapshot,
  id: "snapshot-2",
  source: { id: "source-2", canonicalKey: "external:expert-b", slug: "expert-b", name: "Expert B", kind: "external" as const, provider: null, attributionUrl: "https://example.com/expert-b-rankings" },
  title: "Expert B PPR Rankings",
  generatedAt: "2026-09-01T13:00:00.000Z",
  entries: [
    { id: "entry-b1", playerId: null, playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, previousRank: 2, tier: 1, insight: "Elite ceiling." },
    { id: "entry-b2", playerId: null, playerName: "Malik Nabers", position: "WR", team: "NYG", rank: 2, previousRank: 1, tier: 1, insight: "Target volume remains strong." },
  ],
};

describe("RankingsPage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("moves and saves a personal ranking with accessible controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ snapshots: [] })));
    render(<MemoryRouter><RankingsPage /></MemoryRouter>);

    expect(await screen.findByText("No agent snapshots yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move Ja'Marr Chase up" }));
    expect(screen.getByText(/Moved Ja'Marr Chase from rank 2 to rank 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save my rankings/i }));
    expect(screen.getByText(/Saved your personal rankings on this device/)).toBeInTheDocument();
  });

  it("keeps agent rankings separate until a confirmed copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ snapshots: [agentSnapshot] })));
    render(<MemoryRouter><RankingsPage /></MemoryRouter>);

    const personal = screen.getByRole("region", { name: "My Rankings" });
    const agent = await screen.findByRole("region", { name: "Agent Rankings" });
    expect(within(personal).getByText("Bijan Robinson")).toBeInTheDocument();
    expect(within(agent).getByText(/All Available Sources Aggregate/)).toBeInTheDocument();

    fireEvent.click(within(agent).getByRole("button", { name: "Copy into My Rankings" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Copy all positions from All Available Sources Aggregate");
    expect(within(personal).getByText("Bijan Robinson")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(within(personal).getByText("Bijan Robinson")).toBeInTheDocument();
  });

  it("persists favorite sources and agent workspace layout choices", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ snapshots: [agentSnapshot] })));
    const first = render(<MemoryRouter><RankingsPage /></MemoryRouter>);

    const favorite = await screen.findByRole("button", { name: "Add Codex Rank Agent to favorites" });
    fireEvent.click(favorite);
    expect(screen.getByRole("button", { name: "Remove Codex Rank Agent from favorites" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show agents first" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse agent rankings" }));
    first.unmount();

    render(<MemoryRouter><RankingsPage /></MemoryRouter>);
    const expand = await screen.findByRole("button", { name: "Expand agent rankings" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Show my board first" })).toBeInTheDocument();
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Remove Codex Rank Agent from favorites" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches between aggregate and individual expert lists with numbered expandable rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ snapshots: [agentSnapshot, secondExpertSnapshot] })));
    render(<MemoryRouter><RankingsPage /></MemoryRouter>);

    const agent = await screen.findByRole("region", { name: "Agent Rankings" });
    expect(within(agent).getByRole("button", { name: "Aggregate" })).toHaveAttribute("aria-pressed", "true");
    const aggregateChase = within(agent).getByRole("button", { name: /Ja'Marr Chase.*Average 1\.5/i });
    expect(within(aggregateChase).getByText("1")).toHaveClass("agent-ranking-number");
    fireEvent.click(aggregateChase);
    expect(within(agent).getByRole("link", { name: /Expert B/i })).toHaveAttribute("href", "https://example.com/expert-b-rankings");

    fireEvent.click(within(agent).getByRole("button", { name: "Expert B" }));
    expect(within(agent).getByText("Expert B PPR Rankings")).toBeInTheDocument();
    expect(within(agent).getByRole("link", { name: /View original source/i })).toHaveAttribute("href", "https://example.com/expert-b-rankings");
    const expertChase = within(agent).getByRole("button", { name: /Ja'Marr Chase.*Expert B/i });
    expect(expertChase).toHaveAttribute("aria-expanded", "false");
    expect(within(expertChase).getByText("1")).toHaveClass("agent-ranking-number");

    fireEvent.click(expertChase);
    expect(expertChase).toHaveAttribute("aria-expanded", "true");
    const details = within(agent).getByRole("region", { name: "Ja'Marr Chase details" });
    expect(within(details).getByText("Elite ceiling.")).toBeInTheDocument();
    expect(within(details).getByText("Latest player research")).toBeInTheDocument();
    expect(within(details).getByText("Weekly & season stats")).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: /Research latest news/i })).toHaveAttribute("href", "/research?subject=Ja'Marr%20Chase");
  });

  it("shows saved cited player research inside an expanded ranking row", async () => {
    window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, "owner-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/research/jobs")) return Response.json({ jobs: [{
        id: "research-1",
        type: "player_research",
        status: "completed",
        subject: "Malik Nabers",
        sourceName: null,
        scoringFormat: "ppr",
        rankingType: "redraft",
        position: "WR",
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:05:00.000Z",
        startedAt: "2026-09-01T10:01:00.000Z",
        completedAt: "2026-09-01T10:05:00.000Z",
        attempts: 1,
        error: null,
        result: {
          summary: "Nabers remains the focal point of the passing game.",
          generatedAt: "2026-09-01T10:05:00.000Z",
          insights: [{ subject: "Malik Nabers", finding: "Target share remains elite.", confidence: "high", citationUrls: ["https://example.com/nabers"] }],
          citations: [{ title: "Practice report", url: "https://example.com/nabers", publisher: "Example Sports", publishedAt: null, accessedAt: null }],
        },
      }] });
      return Response.json({ snapshots: [agentSnapshot] });
    }));
    render(<MemoryRouter><RankingsPage /></MemoryRouter>);

    const agent = await screen.findByRole("region", { name: "Agent Rankings" });
    fireEvent.click(within(agent).getByRole("button", { name: /Malik Nabers.*Average 1\.0/i }));
    expect(await within(agent).findByText("Nabers remains the focal point of the passing game.")).toBeInTheDocument();
    expect(within(agent).getByText("Target share remains elite.")).toBeInTheDocument();
    expect(within(agent).getByRole("link", { name: /Example Sports/i })).toHaveAttribute("href", "https://example.com/nabers");
  });
});
