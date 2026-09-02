import {
  AlertCircle,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileSearch,
  KeyRound,
  ListOrdered,
  LoaderCircle,
  Newspaper,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Telescope,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { fetchAgentRankings, type AgentRankingSnapshot } from "../rankings/agent-api";
import {
  DEFAULT_LEAGUE_SIZE,
  LEAGUE_SIZE_OPTIONS,
  loadLeagueSize,
  normalizeLeagueSize,
  saveLeagueSize,
  type LeagueSize,
} from "../league-size";
import {
  createResearchJob,
  createResearchSchedule,
  deleteResearchSchedule,
  fetchResearchJobs,
  fetchResearchSchedules,
  fetchRunnerStatus,
  isLocalDevelopment,
  RESEARCH_OWNER_TOKEN_KEY,
  ResearchApiError,
  retryResearchJob,
  runResearchScheduleNow,
  runnerDisplayState,
  updateResearchSchedule,
  type CreateResearchJob,
  type ResearchJob,
  type ResearchSchedule,
  type ResearchJobStatus,
  type ResearchJobType,
  type RunnerState,
  type RunnerStatus,
} from "./research-api";
import DesktopRunnerControls from "./DesktopRunnerControls";

type BridgeAccessState = "locked" | "checking" | "authorized" | "denied";
type RunnerDisplayState = RunnerState | "locked";

const JOB_TYPE_LABELS: Record<ResearchJobType, string> = {
  source_refresh: "Source refresh",
  player_research: "Player research",
  rankings_research: "Rankings research",
  sleepers_research: "Sleeper research",
};

const JOB_STATUS_LABELS: Record<ResearchJobStatus, string> = {
  queued: "Queued",
  running: "Researching",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SCHEDULE_TIMES = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
});

function nextQuarterHour(): string {
  const value = new Date(Date.now() + 15 * 60_000);
  value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15, 0, 0);
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

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
          <span>{normalizeLeagueSize(snapshot.leagueSize)}-team league</span>
          {snapshot.discoverNewSources && (
            <span className="ranking-discovery-count"><Telescope size={13} /> Latest scout: {snapshot.newPublisherCount ? `${snapshot.newPublisherCount} new ${snapshot.newPublisherCount === 1 ? "publisher" : "publishers"}` : "no new publishers"}</span>
          )}
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
  const requestedPlayer = searchParams.get("subject") ?? "";
  const localDevelopment = localDevelopmentOverride ?? isLocalDevelopment();
  const [ownerToken, setOwnerToken] = useState(loadToken);
  const [tokenDraft, setTokenDraft] = useState(loadToken);
  const [accessState, setAccessState] = useState<BridgeAccessState>(() => localDevelopment || Boolean(ownerToken) ? "checking" : "locked");
  const [tokenRevision, setTokenRevision] = useState(0);
  const [jobType, setJobType] = useState<ResearchJobType>(favoriteSource ? "source_refresh" : "player_research");
  const [subject, setSubject] = useState(requestedPlayer);
  const [source, setSource] = useState(favoriteSource);
  const [position, setPosition] = useState<"ALL" | "QB" | "RB" | "WR" | "TE">("ALL");
  const [rankingLimit, setRankingLimit] = useState(100);
  const [leagueSize, setLeagueSize] = useState<LeagueSize>(() =>
    typeof window === "undefined" ? DEFAULT_LEAGUE_SIZE : loadLeagueSize(window.localStorage));
  const [discoverNewSources, setDiscoverNewSources] = useState(true);
  const [sleepersPerPosition, setSleepersPerPosition] = useState(8);
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [schedules, setSchedules] = useState<ResearchSchedule[]>([]);
  const [scheduleName, setScheduleName] = useState("Weekly rankings refresh");
  const [scheduleTime, setScheduleTime] = useState(nextQuarterHour);
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
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
    const validRankingLimit = Number.isInteger(rankingLimit) && rankingLimit >= 1 && rankingLimit <= 500;
    if (jobType === "source_refresh") return Boolean(source.trim()) && validRankingLimit;
    if (jobType === "player_research") return Boolean(subject.trim());
    if (jobType === "sleepers_research") return Number.isInteger(sleepersPerPosition) && sleepersPerPosition >= 1 && sleepersPerPosition <= 20;
    return validRankingLimit;
  }, [authorized, isSubmitting, jobType, rankingLimit, sleepersPerPosition, source, subject]);

  const canSchedule = canSubmit && Boolean(scheduleName.trim()) && scheduleDays.length > 0 && scheduleBusy === null;

  const refreshBridge = useCallback(async (signal?: AbortSignal) => {
    if (!canAttemptAccess) return;
    setIsLoading(true);
    try {
      const [nextJobs, nextRunner, nextSchedules] = await Promise.all([
        fetchResearchJobs(ownerToken, signal),
        fetchRunnerStatus(ownerToken, signal),
        fetchResearchSchedules(ownerToken, signal).catch(() => []),
      ]);
      setJobs(nextJobs);
      setRunner(nextRunner);
      setSchedules(nextSchedules);
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
    setSnapshots([]);
    fetchAgentRankings(controller.signal, leagueSize)
      .then((nextSnapshots) => setSnapshots(nextSnapshots.filter((snapshot) => normalizeLeagueSize(snapshot.leagueSize) === leagueSize)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [leagueSize]);

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

  function currentJobInput(): CreateResearchJob {
    return {
      type: jobType,
      scoringFormat: "ppr",
      rankingType: "redraft",
      leagueSize,
      ...(jobType === "player_research" ? { subject: subject.trim() } : {}),
      ...(jobType === "source_refresh" ? { sourceName: source.trim(), rankingLimit } : {}),
      ...(jobType === "rankings_research" ? { position, rankingLimit, discoverNewSources } : {}),
      ...(jobType === "sleepers_research" ? { sleepersPerPosition, discoverNewSources } : {}),
    };
  }

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
      const job = await createResearchJob(ownerToken, currentJobInput());
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (jobType === "player_research") setSubject("");
      setNotice("Research job queued. Your local runner will claim it when connected.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not queue this research job.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function addSchedule() {
    if (!canSchedule) return;
    setScheduleBusy("create");
    setNotice(null);
    try {
      const schedule = await createResearchSchedule(ownerToken, {
        name: scheduleName.trim(),
        enabled: true,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
        localTime: scheduleTime,
        daysOfWeek: scheduleDays,
        job: currentJobInput(),
      });
      setSchedules((current) => [...current, schedule]);
      setNotice(`Scheduled ${schedule.name}. Jobs will wait safely if your desktop runner is offline.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create this research schedule.");
    } finally {
      setScheduleBusy(null);
    }
  }

  async function toggleSchedule(schedule: ResearchSchedule) {
    setScheduleBusy(schedule.id);
    try {
      const updated = await updateResearchSchedule(ownerToken, schedule.id, { enabled: !schedule.enabled });
      setSchedules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update this schedule.");
    } finally {
      setScheduleBusy(null);
    }
  }

  async function runSchedule(schedule: ResearchSchedule) {
    setScheduleBusy(schedule.id);
    try {
      const job = await runResearchScheduleNow(ownerToken, schedule.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setNotice(`${schedule.name} was queued to run now.`);
      await refreshBridge();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not run this schedule.");
    } finally {
      setScheduleBusy(null);
    }
  }

  async function removeSchedule(schedule: ResearchSchedule) {
    if (!window.confirm(`Delete the schedule “${schedule.name}”?`)) return;
    setScheduleBusy(schedule.id);
    try {
      await deleteResearchSchedule(ownerToken, schedule.id);
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      setNotice(`Deleted ${schedule.name}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete this schedule.");
    } finally {
      setScheduleBusy(null);
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
                {(["player_research", "rankings_research", "sleepers_research", "source_refresh"] as ResearchJobType[]).map((type) => (
                  <label key={type} className={jobType === type ? "is-selected" : ""}>
                    <input type="radio" name="jobType" value={type} checked={jobType === type} onChange={() => setJobType(type)} />
                    {type === "source_refresh" ? <Newspaper size={14} /> : type === "rankings_research" ? <ListOrdered size={14} /> : type === "sleepers_research" ? <Telescope size={14} /> : <FileSearch size={14} />}
                    <span>{JOB_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </fieldset>

              <label className="research-field research-field--compact research-league-size">
                <span>League size</span>
                <select
                  aria-label="League size"
                  value={leagueSize}
                  onChange={(event) => {
                    const next = normalizeLeagueSize(event.target.value);
                    setLeagueSize(next);
                    saveLeagueSize(window.localStorage, next);
                  }}
                >
                  {LEAGUE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} teams</option>)}
                </select>
                <small>Shared with Rankings Center. Research is scoped to this league size.</small>
              </label>

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
              {(jobType === "source_refresh" || jobType === "rankings_research") && (
                <label className="research-field research-field--compact">
                  <span>Number of players</span>
                  <input
                    aria-label="Number of players"
                    type="number"
                    min={1}
                    max={500}
                    step={1}
                    value={rankingLimit}
                    onChange={(event) => setRankingLimit(Number(event.target.value))}
                  />
                  <small>Request a Top N list from 1–500. Larger lists take longer and depend on how much of the named source is publicly verifiable.</small>
                </label>
              )}
              {jobType === "sleepers_research" && (
                <label className="research-field research-field--compact">
                  <span>Sleepers per position</span>
                  <input aria-label="Sleepers per position" type="number" min={1} max={20} step={1} value={sleepersPerPosition} onChange={(event) => setSleepersPerPosition(Number(event.target.value))} />
                  <small>Collect separate QB, RB, WR, and TE recommendations with direct source evidence.</small>
                </label>
              )}
              {(jobType === "rankings_research" || jobType === "sleepers_research") && (
                <label className="source-scout-toggle">
                  <input type="checkbox" checked={discoverNewSources} onChange={(event) => setDiscoverNewSources(event.target.checked)} />
                  <span className="source-scout-toggle__control" aria-hidden="true"><i /></span>
                  <span>
                    <strong>Scout new publishers</strong>
                    <small>Try reputable publishers outside prior reports while retaining strong known sources.</small>
                  </span>
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

          <section className="panel research-schedules" aria-label="Research schedules" id="research-schedules">
            <header className="panel-header">
              <div><p className="eyebrow">Cloud scheduler</p><h2>Automatic Updates</h2></div>
              <span className="status-pill"><CalendarClock size={12} /> {schedules.length} saved</span>
            </header>
            <div className="schedule-composer">
              <label><span>Schedule name</span><input aria-label="Schedule name" value={scheduleName} maxLength={100} onChange={(event) => setScheduleName(event.target.value)} /></label>
              <label><span>Local time</span><select aria-label="Schedule time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)}>{SCHEDULE_TIMES.map((time) => <option key={time} value={time}>{new Date(`2000-01-01T${time}:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</option>)}</select></label>
              <div className="schedule-days" role="group" aria-label="Schedule days">
                {DAY_LABELS.map((label, day) => <button className={scheduleDays.includes(day) ? "is-active" : ""} aria-pressed={scheduleDays.includes(day)} key={label} type="button" onClick={() => setScheduleDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort())}>{label}</button>)}
              </div>
              <button className="button button--primary" type="button" disabled={!canSchedule} onClick={() => { void addSchedule(); }}><CalendarClock size={13} /> {scheduleBusy === "create" ? "Scheduling…" : "Schedule current assignment"}</button>
              <small>Uses your current assignment settings and local timezone. Cloudflare queues due work every 15 minutes; an offline runner processes it when it reconnects.</small>
            </div>
            <div className="schedule-list">
              {schedules.length === 0 ? <p>No automatic research schedules yet.</p> : schedules.map((schedule) => (
                <article key={schedule.id} className={!schedule.enabled ? "is-disabled" : ""}>
                  <div><strong>{schedule.name}</strong><span>{DAY_LABELS.filter((_, day) => schedule.daysOfWeek.includes(day)).join(" · ")} at {new Date(`2000-01-01T${schedule.localTime}:00`).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><small>{JOB_TYPE_LABELS[schedule.job.type]} · {schedule.job.leagueSize ?? 12} teams · Next {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "when enabled"}</small></div>
                  <div>
                    <button type="button" disabled={scheduleBusy === schedule.id} onClick={() => { void toggleSchedule(schedule); }}>{schedule.enabled ? "Pause" : "Enable"}</button>
                    <button type="button" disabled={scheduleBusy === schedule.id} onClick={() => { void runSchedule(schedule); }}><Play size={12} /> Run now</button>
                    <button type="button" disabled={scheduleBusy === schedule.id} aria-label={`Delete ${schedule.name}`} onClick={() => { void removeSchedule(schedule); }}><Trash2 size={12} /></button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="research-side">
          <DesktopRunnerControls />
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
                  <span>{JOB_TYPE_LABELS[job.type]}{job.rankingLimit ? ` · Top ${job.rankingLimit}` : ""} · {normalizeLeagueSize(job.leagueSize)} teams · {JOB_STATUS_LABELS[job.status]} · {formatRelativeDate(job.updatedAt || job.createdAt)}</span>
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
