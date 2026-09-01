import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RankingsPage from "./RankingsPage";

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
    expect(within(agent).getByText("September PPR Refresh")).toBeInTheDocument();

    fireEvent.click(within(agent).getByRole("button", { name: "Copy into My Rankings" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Copy all positions from September PPR Refresh?");
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
});
