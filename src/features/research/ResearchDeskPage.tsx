import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileSearch,
  GitCompareArrows,
  ListOrdered,
  Newspaper,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { fetchAgentRankings, type AgentRankingSnapshot } from "../rankings/agent-api";

type LocalResearchJob = {
  id: string;
  prompt: string;
  createdAt: string;
  status: "queued";
};

const JOBS_KEY = "spff:research-jobs:v1";
const presets = [
  { icon: GitCompareArrows, label: "Compare two players", prompt: "Compare two players for my PPR redraft rankings: " },
  { icon: ListOrdered, label: "Investigate a rank disagreement", prompt: "Investigate why this player differs from consensus: " },
  { icon: Newspaper, label: "Summarize roster news", prompt: "Summarize today's roster news and identify ranking changes: " },
];

function loadJobs(): LocalResearchJob[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(JOBS_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is LocalResearchJob =>
      typeof item === "object" && item !== null && "id" in item && "prompt" in item) : [];
  } catch {
    return [];
  }
}

function SnapshotResult({ snapshot }: { snapshot: AgentRankingSnapshot }) {
  return (
    <section className="panel latest-result">
      <header className="panel-header">
        <div><p className="eyebrow">Latest completed ranking job</p><h2>{snapshot.title}</h2></div>
        <span className="status-pill status-pill--complete"><CheckCircle2 size={12} /> Complete</span>
      </header>
      <div className="latest-result__body">
        <p>{snapshot.summary ?? "The agent returned a new structured ranking snapshot."}</p>
        <div className="result-moves">
          {snapshot.entries.slice(0, 5).map((entry) => (
            <div key={entry.id}>
              <span>{entry.position ?? "?"}</span>
              <strong>{entry.playerName}</strong>
              <b>#{entry.rank}</b>
              <small>{entry.insight ?? "No short rationale supplied."}</small>
            </div>
          ))}
        </div>
        <footer>
          <span><Bot size={13} /> {snapshot.source.name}</span>
          <span><Clock3 size={13} /> {new Date(snapshot.generatedAt).toLocaleString()}</span>
          <a href="/rankings">Review rankings <ExternalLink size={13} /></a>
        </footer>
      </div>
    </section>
  );
}

export default function ResearchDeskPage() {
  const [searchParams] = useSearchParams();
  const sourceName = searchParams.get("sourceName");
  const [prompt, setPrompt] = useState(() => sourceName
    ? `Refresh ${sourceName}'s PPR redraft rankings. Report material player moves, source dates, and concise reasons for every change.`
    : "");
  const [jobs, setJobs] = useState<LocalResearchJob[]>(loadJobs);
  const [snapshots, setSnapshots] = useState<AgentRankingSnapshot[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  }, [jobs]);

  useEffect(() => {
    const controller = new AbortController();
    fetchAgentRankings(controller.signal).then(setSnapshots).catch(() => undefined);
    return () => controller.abort();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setJobs((current) => [{ id: crypto.randomUUID(), prompt: cleanPrompt, createdAt: new Date().toISOString(), status: "queued" }, ...current]);
    setPrompt("");
    setNotice("Saved to your local queue. It will dispatch after the runner bridge is connected.");
  }

  return (
    <div className="page research-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Human-directed agents</p>
          <h1>Research Desk</h1>
          <p className="page-header__copy">Ask focused football questions, review the exact task, and keep every sourced result.</p>
        </div>
        <div className="page-header__actions"><span className="status-pill status-pill--offline"><WifiOff size={12} /> Runner bridge pending</span></div>
      </header>

      <div className="research-layout">
        <div className="research-main">
          <section className="panel research-composer">
            <div className="research-composer__heading">
              <div className="research-callout__icon"><Sparkles size={20} /></div>
              <div><p className="eyebrow">New assignment</p><h2>Ask the Research Desk</h2></div>
            </div>
            {sourceName && <p className="research-source-target"><Star size={12} /> Favorite source refresh: <strong>{sourceName}</strong></p>}
            <form onSubmit={submit}>
              <label>
                <span className="sr-only">Research request</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="e.g. Compare Bijan Robinson and Jahmyr Gibbs for my PPR draft board…"
                  rows={4}
                />
              </label>
              <div className="research-presets">
                {presets.map(({ icon: PresetIcon, label, prompt: presetPrompt }) => (
                  <button key={label} type="button" onClick={() => setPrompt(presetPrompt)}><PresetIcon size={14} /> {label}</button>
                ))}
              </div>
              <div className="research-submit-row">
                <span><ShieldCheck size={14} /> Nothing runs without your confirmation</span>
                <button className="button button--primary" type="submit" disabled={!prompt.trim()}>Queue research <Send size={14} /></button>
              </div>
            </form>
            {notice && <p className="research-notice" role="status">{notice}</p>}
          </section>

          {snapshots[0] ? <SnapshotResult snapshot={snapshots[0]} /> : (
            <section className="panel latest-result latest-result--empty">
              <FileSearch size={25} />
              <div><p className="eyebrow">Latest result</p><h2>No completed research yet</h2><p>When a runner posts a ranking snapshot, its summary, movements, and provenance will appear here.</p></div>
            </section>
          )}
        </div>

        <aside className="research-side">
          <section className="panel job-queue">
            <header><div><p className="eyebrow">On this device</p><h2>Job Queue</h2></div><span>{jobs.length}</span></header>
            {jobs.length === 0 ? (
              <div className="queue-empty"><CircleDashed size={20} /><p>No queued assignments.</p></div>
            ) : jobs.slice(0, 6).map((job) => (
              <article key={job.id}>
                <CircleDashed size={15} />
                <div><strong>{job.prompt}</strong><span>Queued locally · waiting for bridge</span></div>
                <ChevronRight size={14} />
              </article>
            ))}
          </section>

          <section className="panel runner-card">
            <header><div className="research-callout__icon"><Bot size={18} /></div><div><p className="eyebrow">Local runner</p><h2>Not connected</h2></div></header>
            <dl>
              <div><dt>Transport</dt><dd>Tool bridge</dd></div>
              <div><dt>Jobs today</dt><dd>0</dd></div>
              <div><dt>Auto-run</dt><dd>Off</dd></div>
            </dl>
            <p>The page and result-ingestion contract are ready. Connecting Codex or Claude CLI is the next controlled step.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
