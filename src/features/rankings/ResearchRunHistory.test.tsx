import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchRunHistory, type ResearchRunOption } from "./ResearchRunHistory";

const runs: ResearchRunOption[] = [
  { id: "newest-run", generatedAt: "2026-09-05T12:00:00Z", title: "Latest research", detail: "3 sources" },
  { id: "past-run", generatedAt: "2026-08-01T12:00:00Z", title: "Preseason research", detail: "4 sources" },
];

function HistoryHarness({ availableRuns }: { availableRuns: ResearchRunOption[] }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  return <ResearchRunHistory label="Rankings" runs={availableRuns} selectedRunId={selectedRunId} onSelect={setSelectedRunId} loading={availableRuns.length === 0} />;
}

describe("ResearchRunHistory", () => {
  afterEach(cleanup);

  it("selects the newest run after History was opened before runs finished loading", () => {
    const view = render(<MemoryRouter><HistoryHarness availableRuns={[]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "History 0" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved runs");
    view.rerender(<MemoryRouter><HistoryHarness availableRuns={runs} /></MemoryRouter>);
    expect(screen.getByLabelText("Rankings saved run")).toHaveValue("newest-run");
    expect(screen.queryByRole("option", { name: "Run unavailable" })).not.toBeInTheDocument();
  });

  it("preserves a selected past run when the active History button is pressed", () => {
    render(<MemoryRouter><HistoryHarness availableRuns={runs} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "History 2" }));
    fireEvent.change(screen.getByLabelText("Rankings saved run"), { target: { value: "past-run" } });
    fireEvent.click(screen.getByRole("button", { name: "History 2" }));
    expect(screen.getByLabelText("Rankings saved run")).toHaveValue("past-run");
  });

  it("never replaces an unavailable real deep link with a different run", () => {
    const onSelect = vi.fn();
    const view = render(<MemoryRouter><ResearchRunHistory label="Rankings" runs={[]} selectedRunId="missing-job" onSelect={onSelect} loading /></MemoryRouter>);
    view.rerender(<MemoryRouter><ResearchRunHistory label="Rankings" runs={runs} selectedRunId="missing-job" onSelect={onSelect} /></MemoryRouter>);
    expect(screen.getByLabelText("Rankings saved run")).toHaveValue("missing-job");
    expect(screen.getByRole("option", { name: "Run unavailable" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
