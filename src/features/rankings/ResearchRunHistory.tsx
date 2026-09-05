import { ChevronLeft, ChevronRight, Clock3, History, Radio } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";
import "./research-run-history.css";

export type ResearchRunOption = {
  id: string;
  generatedAt: string;
  title: string;
  detail: string;
  researchJobId?: string | null;
};

export function formatRunDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "Date unavailable";
}

export function ResearchRunHistory({ label, runs, selectedRunId, onSelect, loading = false, error, onRetry }: {
  label: string;
  runs: ResearchRunOption[];
  selectedRunId: string | null;
  onSelect: (id: string | null) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const historical = selectedRunId !== null;
  const selectedIndex = runs.findIndex((run) => run.id === selectedRunId);
  const selectedRun = runs[selectedIndex];
  const newestRunId = runs[0]?.id;
  useEffect(() => {
    if (selectedRunId === "history" && newestRunId) onSelect(newestRunId);
  }, [selectedRunId, newestRunId, onSelect]);
  return (
    <section className="research-run-history" aria-label={`${label} research history`}>
      <div className="research-run-history__toolbar">
        <div className="research-run-history__modes" aria-label={`${label} view`}>
          <button type="button" aria-pressed={!historical} onClick={() => onSelect(null)}><Radio size={14} /> Current</button>
          <button type="button" aria-pressed={historical} onClick={() => { if (!historical) onSelect(newestRunId ?? "history"); }}><History size={14} /> History <span>{runs.length}</span></button>
        </div>
        <small>{historical ? "Loaded research runs" : "Latest published results"}</small>
      </div>
      {historical && (
        <div className="research-run-history__archive">
          {loading && <p role="status">Loading saved runs…</p>}
          {error && <p role="alert">{error} {onRetry && <button type="button" onClick={onRetry}>Try again</button>}</p>}
          {runs.length === 0 ? !loading && !error && <p>No saved runs yet. Completed research will appear here.</p> : <>
            <div className="research-run-history__selection">
              <label><span>Saved run</span><select aria-label={`${label} saved run`} value={selectedRunId ?? ""} onChange={(event) => onSelect(event.target.value)}>
                {selectedIndex === -1 && <option value={selectedRunId ?? ""}>Run unavailable</option>}
                {runs.map((run) => <option value={run.id} key={run.id}>{formatRunDate(run.generatedAt)} · {run.title} · {run.detail}</option>)}
              </select></label>
              <div className="research-run-history__arrows">
                <button type="button" aria-label={`Newer ${label.toLowerCase()} run`} disabled={selectedIndex <= 0} onClick={() => onSelect(runs[selectedIndex - 1].id)}><ChevronLeft size={16} /></button>
                <button type="button" aria-label={`Older ${label.toLowerCase()} run`} disabled={selectedIndex < 0 || selectedIndex >= runs.length - 1} onClick={() => onSelect(runs[selectedIndex + 1].id)}><ChevronRight size={16} /></button>
              </div>
            </div>
            {selectedRun ? <div className="research-run-history__receipt"><Clock3 size={16} /><div><strong>{selectedRun.title}</strong><span>{formatRunDate(selectedRun.generatedAt)} · {selectedRun.detail}</span></div><span className="research-run-history__badge">Historical</span></div> : <p role="status">This run could not be found. Choose a saved run or return to Current.</p>}
            <p className="research-run-history__note">Viewing a saved run. New research stays in Current while you browse.</p>
            {selectedRun?.researchJobId && <Link className="research-run-history__log-link" to={`/agents?job=${encodeURIComponent(selectedRun.researchJobId)}`}>View agent run log <ChevronRight size={14} /></Link>}
          </>}
        </div>
      )}
    </section>
  );
}
