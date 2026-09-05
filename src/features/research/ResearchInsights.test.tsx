import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchInsights, { INSIGHT_BOOKMARKS_KEY } from "./ResearchInsights";
import type { ResearchJob } from "./research-api";

function report(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    id: "report-1", type: "player_research", status: "completed", subject: "Player report", sourceName: null,
    scoringFormat: "ppr", rankingType: "redraft", position: "RB", leagueSize: 12,
    createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:10:00Z", startedAt: "2026-09-05T12:01:00Z",
    completedAt: "2026-09-05T12:10:00Z", attempts: 1, error: null,
    result: {
      summary: "A useful opportunity report.", generatedAt: "2026-09-05T12:10:00Z",
      citations: [{ title: "Depth chart report", url: "https://example.com/depth", publisher: "Gridiron News", publishedAt: null, accessedAt: null }],
      insights: [
        { subject: "Bijan Robinson", finding: "Increasing receiving work", confidence: "high", citationUrls: ["https://example.com/depth"] },
        { subject: "James Cook", finding: "Limited practice", confidence: "low", citationUrls: ["javascript:alert(1)"] },
      ],
    }, ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ResearchInsights", () => {
  it("searches findings, summaries, and publishers while confidence narrows matching findings", () => {
    render(<ResearchInsights jobs={[report()]} leagueSize={12} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Bijan" } });
    expect(screen.getByRole("heading", { name: "Bijan Robinson" })).toBeVisible();
    expect(screen.queryByText("James Cook")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Gridiron" } });
    expect(screen.getByRole("heading", { name: "James Cook" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Confidence"), { target: { value: "high" } });
    expect(screen.queryByText("James Cook")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "opportunity" } });
    expect(screen.getByRole("heading", { name: "Bijan Robinson" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nonexistent" } });
    expect(screen.getByText(/No reports match these filters/)).toBeInTheDocument();
  });

  it("saves only report IDs across mounts and remains usable if storage fails", () => {
    const first = render(<ResearchInsights jobs={[report()]} leagueSize={12} />);
    fireEvent.click(screen.getByRole("button", { name: "Save report: Player report" }));
    expect(JSON.parse(localStorage.getItem(INSIGHT_BOOKMARKS_KEY)!)).toEqual(["report-1"]);
    first.unmount();
    render(<ResearchInsights jobs={[report()]} leagueSize={12} />);
    expect(screen.getByRole("button", { name: "Unsave report: Player report" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText("Saved only"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    fireEvent.click(screen.getByRole("button", { name: "Unsave report: Player report" }));
    expect(screen.getByText(/Browser storage is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("limits reports latest first, scopes league sizes, and handles summary-only and legacy reports", () => {
    const jobs = Array.from({ length: 8 }, (_, index) => report({
      id: `report-${index}`, subject: `Report ${index}`, leagueSize: index === 7 ? 10 : 12,
      result: { summary: `Summary ${index}`, generatedAt: `2026-09-0${index + 1}T12:00:00Z`, insights: [], citations: [] },
    }));
    jobs.push(report({ id: "legacy", subject: "Legacy report", leagueSize: undefined }));
    render(<ResearchInsights jobs={jobs} leagueSize={12} />);
    expect(screen.getAllByRole("article")).toHaveLength(6);
    expect(within(screen.getAllByRole("article")[0]).getByRole("heading", { name: "Report 6" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Report 7" })).not.toBeInTheDocument();
    expect(screen.getByText("League size unspecified · PPR · redraft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show more reports/ }));
    expect(screen.getAllByRole("article")).toHaveLength(8);
    fireEvent.click(screen.getByLabelText("12-team reports"));
    expect(within(screen.getAllByRole("article")[0]).getByText("Summary 7")).toBeInTheDocument();
  });

  it("exposes safe source links and excludes incomplete jobs and unsafe URLs", () => {
    const data = report();
    data.result!.citations.push({ title: "Unsafe", url: "javascript:alert(1)", publisher: null, publishedAt: null, accessedAt: null });
    render(<ResearchInsights jobs={[data, report({ id: "pending", status: "running", subject: "Pending" })]} leagueSize={12} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "opportunity" } });
    expect(screen.getAllByRole("link")).toHaveLength(2);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("href", "https://example.com/depth");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.queryByText("Unsafe")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Pending" })).not.toBeInTheDocument();
  });
});
