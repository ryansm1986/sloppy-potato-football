import {
  AlertCircle,
  Bot,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileSearch,
  KeyRound,
  ListOrdered,
  LoaderCircle,
  Newspaper,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { fetchAgentRankings, type AgentRankingSnapshot } from "../rankings/agent-api";
import {
  createResearchJob,
  fetchResearchJobs,
  fetchRunnerStatus,
  isLocalDevelopment,
  RESEARCH_OWNER_TOKEN_KEY,
  ResearchApiError,
  retryResearchJob,
  runnerDisplayState,
  type ResearchJob,
  type ResearchJobStatus,
  type ResearchJobType,
  type RunnerState,
  type RunnerStatus,
} from "./research-api";

type BridgeAccessState = "locked" | "checking" | "authorized" | "denied";
type RunnerDisplayState = RunnerState | "locked";

const JOB_TYPE_LABELS: Record<ResearchJobType, string> = {
  source_refresh: "Source refresh",
  player_research: "Player research",
  rankings_research: "Rankings research",
};

const JOB_STATUS_LABELS: Record<ResearchJobStatus, string> = {
  queued: "Queued",
  running: "Researching",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

function loadToken(): string {
  return window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY) ?? "";
}

function formatRelativeDate(value: string | null): string {
  if (!value) return "Never";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

function JobStatusIcon({ status }: { status: ResearchJobStatus }) {
  if (status === "completed") return <CheckCircle2 size={15} />;
  if (status === "failed" || status === "cancelled") return <AlertCircle size={15} />;
  if (status === "running") return <LoaderCircle className="spin" size={15} />;
  return <CircleDashed size={15} />;
}

function RunnerIcon({ state }: { state: RunnerDisplayState }) {
  if (state === "online" || state === "busy") return <Wifi size={12} />;
  if (state === "stale") return <Clock3 size={12} />;
  if (state === "locked") return <KeyRound size={12} />;
  return <WifiOff size={12} />;
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

export default function ResearchDeskPage({ localDevelopmentOverride }: { localDevelopmentOverride?: boolean } = {}) {
  const [searchParams] = useSearchParams();
  const favoriteSource = searchParams.get("sourceName") ?? "";
  const localDevelopment = localDevelopmentOverride ?? isLocalDevelopment();
  const [ownerToken, setOwnerToken] = useState(loadToken);
  const [tokenDraft, setTokenDraft] = useState(loadToken);
  const [accessState, setAccessState] = useState<BridgeAccessState>(() => localDevelopment || Boolean(ownerToken) ? "checking" : "locked");
  const [tokenRevision, setTokenRevision] = useState(0);
  const [jobType, setJobType] = useState<ResearchJobType>(favoriteSource ? "source_refresh" : "player_research");
  const [subject, setSubject] = useState("");
  const [source, setSource] = useState(favoriteSource);
  const [position, setPosition] = useState<"ALL" | "QB" | "RB" | "WR" | "TE">("ALL");
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const [snapshots, setSnapshots] = useState<AgentRankingSnapshot[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const canAttemptAccess = localDevelopment || Boolean(ownerToken);
  const authorized = accessState === "authorized";
  const runnerState: RunnerDisplayState = authorized ? runnerDisplayState(runner) : "locked";

  const canSubmit = useMemo(() => {
    if (!authorized || isSubmitting) return false;
    if (jobType === "source_refresh") return Boolean(source.trim());
    if (jobType === "player_research") return Boolean(subject.trim());
    return true;
  }, [authorized, isSubmitting, jobType, source, subject]);

  const refreshBridge = useCallback(async (signal?: AbortSignal) => {
    if (!canAttemptAccess) return;
    setIsLoading(true);
    try {
      const [nextJobs, nextRunner] = await Promise.all([
        fetchResearchJobs(ownerToken, signal),
        fetchRunnerStatus(ownerToken, signal),
      ]);
      setJobs(nextJobs);
      setRunner(nextRunner);
      setAccessState("authorized");
      setPollError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ResearchApiError && (error.status === 401 || error.status === 403)) {
        setAccessState("denied");
        setJobs([]);
        setRunner(null);
        setPollError("Owner token rejected. Replace it below and save again.");
      } else {
        setPollError(error instanceof Error ? error.message : "Could not reach the research bridge.");
      }
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [canAttemptAccess, ownerToken]);

  useEffect(() => {
    const controller = new AbortController();
    fetchAgentRankings(controller.signal).then(setSnapshots).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!canAttemptAccess) return;
    const controller = new AbortController();
    void refreshBridge(controller.signal);
    const timer = window.setInterval(() => void refreshBridge(controller.signal), 10_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [canAttemptAccess, refreshBridge, tokenRevision]);

  function saveToken() {
    const cleanToken = tokenDraft.trim();
    if (cleanToken) window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, cleanToken);
    else window.localStorage.removeItem(RESEARCH_OWNER_TOKEN_KEY);
    setOwnerToken(cleanToken);
    setAccessState(localDevelopment || cleanToken ? "checking" : "locked");
    setJobs([]);
    setRunner(null);
    setPollError(null);
    setTokenRevision((current) => current + 1);
    setNotice(cleanToken ? "Owner token saved only in this browser." : "Owner token removed from this browser.");
  }

  function removeToken() {
    window.localStorage.removeItem(RESEARCH_OWNER_TOKEN_KEY);
    setTokenDraft("");
    setOwnerToken("");
    setJobs([]);
    setRunner(null);
    setAccessState(localDevelopment ? "checking" : "locked");
    setPollError(null);
    setTokenRevision((current) => current + 1);
    setNotice("Owner token removed from this browser.");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    setNotice(null);
    try {
      const job = await createResearchJob(ownerToken, {
        type: jobType,
        scoringFormat: "ppr",
        rankingType: "redraft",
        ...(jobType === "player_research" ? { subject: subject.trim() } : {}),
        ...(jobType === "source_refresh" ? { sourceName: source.trim() } : {}),
        ...(jobType === "rankings_research" ? { position } : {}),
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (jobType === "player_research") setSubject("");
      setNotice("Research job queued. Your local runner will claim it when connected.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not queue this research job.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retry(jobId: string) {
    setRetryingId(jobId);
    setNotice(null);
    try {
      const job = await retryResearchJob(ownerToken, jobId);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
      setNotice("Research job returned to the queue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not retry this job.");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="page research-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Human-directed agents</p>
          <h1>Research Desk</h1>
          <p className="page-header__copy">Queue focused football research, follow the local runner, and keep every sourced result.</p>
        </div>
        <div className="page-header__actions">
          <span className={`status-pill status-pill--${runnerState}`}><RunnerIcon state={runnerState} /> Runner {runnerState}</span>
          {authorized && <button className="button button--secondary" type="button" onClick={() => void refreshBridge()} disabled={isLoading}><RefreshCw className={isLoading ? "spin" : ""} size={13} /> Refresh</button>}
        </div>
      </header>

      <div className="research-layout">
        <div className="research-main">
          <section className="panel research-composer">
            <div className="research-composer__heading">
              <div className="research-callout__icon"><Sparkles size={20} /></div>
              <div><p className="eyebrow">New assignment</p><h2>Dispatch bounded research</h2></div>
            </div>
            {favoriteSource && <p className="research-source-target"><Star size={12} /> Favorite source refresh: <strong>{favoriteSource}</strong></p>}
            <form onSubmit={submit}>
              <fieldset className="research-job-types">
                <legend>Assignment type</legend>
                {(["player_research", "rankings_research", "source_refresh"] as ResearchJobType[]).map((type) => (
                  <label key={type} className={jobType === type ? "is-selected" : ""}>
                    <input type="radio" name="jobType" value={type} checked={jobType === type} onChange={() => setJobType(type)} />
                    {type === "source_refresh" ? <Newspaper size={14} /> : type === "rankings_research" ? <ListOrdered size={14} /> : <FileSearch size={14} />}
                    <span>{JOB_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </fieldset>

              {jobType === "player_research" && (
                <label className="research-field">
                  <span>Player name</span>
                  <input aria-label="Player name" value={subject} maxLength={100} onChange={(event) => setSubject(event.target.value)} placeholder="e.g. Bijan Robinson" autoComplete="off" />
                  <small>The runner uses the fixed PPR redraft player-research template—this is not a freeform agent prompt.</small>
                </label>
              )}
              {jobType === "source_refresh" && (
                <label className="research-field">
                  <span>Ranking source</span>
                  <input aria-label="Ranking source" value={source} maxLength={160} onChange={(event) => setSource(event.target.value)} placeholder="e.g. FantasyPros Pat Fitzmaurice" autoComplete="off" />
                  <small>The runner finds the newest published PPR redraft rankings and preserves source provenance.</small>
                </label>
              )}
              {jobType === "rankings_research" && (
                <label className="research-field research-field--compact">
                  <span>Position scope</span>
                  <select aria-label="Position scope" value={position} onChange={(event) => setPosition(event.target.value as typeof position)}>
                    <option value="ALL">All positions</option><option value="QB">Quarterbacks</option><option value="RB">Running backs</option><option value="WR">Wide receivers</option><option value="TE">Tight ends</option>
                  </select>
                  <small>Creates a sourced PPR redraft ranking snapshot for the selected scope.</small>
                </label>
              )}

              <div className="research-guardrails">
                <span><ShieldCheck size={14} /> PPR · redraft · fixed runner template</span>
                <span>No shell commands or unrestricted prompts</span>
              </div>
              <div className="research-submit-row">
                <span>{authorized ? <><CheckCircle2 size={14} /> Owner access ready</> : <><KeyRound size={14} /> Save the owner token to dispatch</>}</span>
                <button className="button button--primary" type="submit" disabled={!canSubmit}>{isSubmitting ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />} Queue research</button>
              </div>
            </form>
            {notice && <p className="research-notice" role="status">{notice}</p>}
            {pollError && <p className="research-error" role="alert"><AlertCircle size={13} /> {pollError}</p>}
          </section>

          {snapshots[0] ? <SnapshotResult snapshot={snapshots[0]} /> : (
            <section className="panel latest-result latest-result--empty">
              <FileSearch size={25} />
              <div><p className="eyebrow">Latest result</p><h2>No completed ranking research yet</h2><p>A completed ranking job will publish a structured snapshot here and in the Rankings Center.</p></div>
            </section>
          )}
        </div>

        <aside className="research-side">
          <section className="panel job-queue" aria-label="Research job queue">
            <header><div><p className="eyebrow">Cloud queue</p><h2>Job Queue</h2></div><span>{jobs.length}</span></header>
            {!authorized ? (
              <div className="queue-empty"><KeyRound size={20} /><p>Save your owner token to load the private queue.</p></div>
            ) : jobs.length === 0 ? (
              <div className="queue-empty"><CircleDashed size={20} /><p>{isLoading ? "Loading jobs…" : "No assignments yet."}</p></div>
            ) : jobs.slice(0, 10).map((job) => (
              <article key={job.id} className={`job-queue__item job-queue__item--${job.status}`}>
                <JobStatusIcon status={job.status} />
                <div>
                  <strong>{job.sourceName || job.subject || `${job.position ?? "ALL"} PPR rankings`}</strong>
                  <span>{JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]} · {formatRelativeDate(job.updatedAt || job.createdAt)}</span>
                  {job.error && <small>{job.error}</small>}
                </div>
                {job.status === "failed" && <button type="button" onClick={() => void retry(job.id)} disabled={retryingId === job.id} aria-label={`Retry ${job.sourceName || job.subject || "research job"}`}><RefreshCw className={retryingId === job.id ? "spin" : ""} size={13} /></button>}
              </article>
            ))}
          </section>

          <section className={`panel runner-card runner-card--${runnerState}`}>
            <header><div className="research-callout__icon"><Bot size={18} /></div><div><p className="eyebrow">Local runner</p><h2>{runnerState}</h2></div></header>
            <dl>
              <div><dt>Provider</dt><dd>{runner?.provider ?? "Not reported"}</dd></div>
              <div><dt>Last heartbeat</dt><dd>{formatRelativeDate(runner?.lastSeenAt ?? null)}</dd></div>
              <div><dt>Jobs today</dt><dd>{runner?.jobsToday ?? 0}</dd></div>
              <div><dt>Auto-run</dt><dd>{runner?.autoRun ? "On" : "Off"}</dd></div>
            </dl>
            <p>{runnerState === "busy" ? "The runner is processing a claimed assignment." : runnerState === "online" ? "The runner is ready to claim the next queued assignment." : runnerState === "stale" ? "The last heartbeat is over a minute old. Check the local runner process." : runnerState === "offline" ? "The bridge is authorized, but the local runner is offline. Start it to process queued work." : accessState === "denied" ? "This owner token was rejected. Replace it below and save again to unlock runner status." : ownerToken ? "Verifying the saved owner token. Replace it below if access stays locked." : "Save your owner token below to unlock runner status and the private queue."}</p>
          </section>

          <section className="panel owner-token-card">
            <header><KeyRound size={16} /><div><p className="eyebrow">Private bridge access</p><h2>Owner token</h2></div></header>
            <label>
              <span className="sr-only">Research owner token</span>
              <input type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste owner token" autoComplete="off" />
            </label>
            <p>Stored only in localStorage on this browser and sent only as a bearer credential to the app API. It is never bundled into the site.</p>
            <div>
              <button className="button button--primary" type="button" onClick={saveToken} disabled={!tokenDraft.trim() && !ownerToken}><Save size={13} /> Save locally</button>
              {ownerToken && <button className="button button--secondary" type="button" onClick={removeToken}><Trash2 size={13} /> Remove</button>}
            </div>
            {localDevelopment && <small><ShieldCheck size={12} /> Localhost development can connect without a token.</small>}
          </section>
        </aside>
      </div>
    </div>
  );
}
