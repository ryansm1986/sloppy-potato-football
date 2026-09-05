import { Activity, ArrowUpRight, Bot, CheckCircle2, Clock3, Download, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router";
import { useResearchOwnerAccess } from "./useResearchOwnerAccess";
import { isLocalDevelopment, ResearchApiError, retryResearchJob } from "./research-api";
import { DEFAULT_AGENT_SETTINGS, fetchAgentDashboard, fetchAgentEvents, fetchAgentJob, saveAgentSettings, type AgentDashboard, type AgentEvent, type AgentJob, type AgentResearchSettings } from "./agent-dashboard-api";
import ResearchInsights from "./ResearchInsights";
import { SOURCE_TARGET_OPTIONS } from "./SourceTargetField";
import "./agent-dashboard.css";

const titles = { player_research: "Player research", rankings_research: "Rankings", sleepers_research: "Sleepers", source_refresh: "Source refresh" };
const focusLabels = { balanced: "Balanced", injuries: "Injuries & availability", usage: "Role & usage", draft_value: "Draft value & risk" };
function jobTitle(job: AgentJob) { return job.subject || job.sourceName || `${titles[job.type]} · ${job.position || "ALL"}`; }
function date(value?: string | null) { return value ? new Date(value).toLocaleString() : "Not reported"; }
function elapsed(job: AgentJob, now: number) {
  if (!job.startedAt) return "Not started";
  const end = job.completedAt ? Date.parse(job.completedAt) : job.status === "running" ? now : Date.parse(job.updatedAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s${job.attempts > 1 ? " across attempts" : ""}`;
}
function outputLink(job: AgentJob) {
  if (job.type === "rankings_research" || job.type === "source_refresh") return `/rankings?run=${encodeURIComponent(job.id)}&leagueSize=${job.leagueSize ?? 12}`;
  if (job.type === "sleepers_research") return `/sleepers?run=${encodeURIComponent(job.id)}&leagueSize=${job.leagueSize ?? 12}`;
  return null;
}

export default function AgentDashboardPage({ localDevelopmentOverride }: { localDevelopmentOverride?: boolean } = {}) {
  const { ownerToken } = useResearchOwnerAccess();
  const [params, setParams] = useSearchParams();
  const allowed = (localDevelopmentOverride ?? isLocalDevelopment()) || !!ownerToken;
  const [data, setData] = useState<AgentDashboard | null>(null);
  const [draft, setDraft] = useState<AgentResearchSettings | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [limit, setLimit] = useState(15);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<AgentJob | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<AgentEvent[] | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef<AbortController | null>(null);
  const selectedId = params.get("job");
  const selected = data?.jobs.find((job) => job.id === selectedId);
  const latestEventId = data?.events.find((event) => event.jobId === selectedId)?.id;

  const refresh = useCallback(async () => {
    if (!allowed || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    try {
      const next = await fetchAgentDashboard(ownerToken, controller.signal);
      if (controller.signal.aborted) return;
      setData(next); setError(null); setLastUpdated(Date.now());
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ResearchApiError && [401, 403].includes(cause.status)) setData(null);
      setError(cause instanceof Error ? cause.message : "Could not refresh agent activity.");
    } finally {
      if (inFlight.current === controller) { inFlight.current = null; setRefreshing(false); }
    }
  }, [allowed, ownerToken]);

  useEffect(() => {
    setData(null); setDraft(null); setSelectedDetail(null); setError(null);
    void refresh();
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, 15_000);
    const clock = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { inFlight.current?.abort(); inFlight.current = null; clearInterval(timer); clearInterval(clock); document.removeEventListener("visibilitychange", visibleRefresh); };
  }, [refresh]);

  useEffect(() => {
    setSelectedDetail(null); setDetailError(null);
    if (!selectedId || !data) return;
    const controller = new AbortController();
    fetchAgentJob(ownerToken, selectedId, controller.signal).then((job) => { if (!controller.signal.aborted) setSelectedDetail(job); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : "Could not load report."); });
    return () => controller.abort();
  }, [selectedId, selected?.updatedAt, ownerToken, !!data]);

  useEffect(() => {
    setRunEvents(null); setEventError(null);
    if (!selectedId || !data) return;
    const controller = new AbortController();
    fetchAgentEvents(ownerToken, selectedId, controller.signal).then((response) => { if (!controller.signal.aborted) setRunEvents(response.events); })
      .catch(() => { if (!controller.signal.aborted) setEventError("Full timeline could not load. Showing events from recent activity."); });
    return () => controller.abort();
  }, [selectedId, ownerToken, latestEventId, !!data]);

  const filtered = useMemo(() => (data?.jobs ?? []).filter((job) => (statusFilter === "all" || (statusFilter === "active" ? ["queued", "running"].includes(job.status) : job.status === statusFilter))
    && (deviceFilter === "all" || job.runnerId === deviceFilter)
    && `${jobTitle(job)} ${titles[job.type]} ${job.id}`.toLowerCase().includes(query.trim().toLowerCase())), [data, statusFilter, deviceFilter, query]);
  const settings = draft ?? data?.settings ?? DEFAULT_AGENT_SETTINGS;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(data?.settings);
  const job = selectedDetail ?? selected;
  const events = (runEvents ?? data?.events ?? []).filter((event) => event.jobId === selectedId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const patch = (value: Partial<AgentResearchSettings>) => setDraft({ ...settings, ...value });
  async function save() {
    setSaving(true); setNotice(null);
    try { const response = await saveAgentSettings(ownerToken, settings); setData((current) => current ? { ...current, settings: response.settings } : current); setDraft(null); setNotice("Research settings saved. Newly queued jobs will use these preferences."); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not save settings."); }
    finally { setSaving(false); }
  }
  async function retry() {
    if (!job || retrying) return;
    setRetrying(true);
    try { await retryResearchJob(ownerToken, job.id); setNotice("Job requeued with its original research settings."); await refresh(); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not retry job."); }
    finally { setRetrying(false); }
  }
  function exportLog() {
    if (!job) return;
    const blob = new Blob([JSON.stringify({ job, events }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `agent-run-${job.id.replace(/[^a-z0-9_-]/gi, "-")}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="page agent-dashboard">
    <header className="page-header"><div><p className="eyebrow">Your research operation</p><h1>Agent Dashboard</h1><p className="page-header__copy">See who is working, inspect past runs, and shape the next assignment.</p></div><div className="page-header__actions"><NavLink className="button button--primary" to="/research">New research <ArrowUpRight size={15} /></NavLink><button className="button button--secondary" disabled={!allowed || refreshing} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? "spin" : undefined} /> Refresh activity</button></div></header>
    {!allowed && <section className="panel agent-empty"><Bot size={28} /><h2>Connect your research workspace</h2><p><NavLink to="/settings">Open Settings</NavLink> to unlock your agents and private run history.</p></section>}
    {error && <p className="research-error" role="alert">{error}</p>}
    {eventError && <p className="research-error" role="alert">{eventError}</p>}
    {notice && <p className="research-notice" role="status">{notice}</p>}
    {allowed && !data && !error && <p role="status">Loading agent activity…</p>}
    {data && <>
      <div className="agent-metrics" aria-label="Loaded job totals">{[["Running", data.jobs.filter((j) => j.status === "running").length], ["Queued", data.jobs.filter((j) => j.status === "queued").length], ["Completed", data.jobs.filter((j) => j.status === "completed").length], ["Needs attention", data.jobs.filter((j) => j.status === "failed").length]].map(([label, count]) => <div className="panel" key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>
      <p className="agent-caption">Latest {data.jobs.length} runs · Updated {lastUpdated ? date(new Date(lastUpdated).toISOString()) : "just now"} · Refreshes every 15 seconds while visible</p>
      <div className="agent-devices" aria-label="Agent computers">{data.runners.length === 0 ? <div className="panel agent-empty">No runner has checked in. <NavLink to="/settings">Set up a computer</NavLink>.</div> : data.runners.map((runner) => <article className="panel agent-device" key={runner.id}><header><Bot size={20} /><h2>{runner.name}</h2><span className={`status-pill status-pill--${runner.state}`}>{runner.state}</span></header><p>{runner.provider} · {runner.version ? `Runner ${runner.version}` : "Version not reported"}</p><p className="agent-caption">Last contact: {date(runner.lastSeenAt)}</p>{runner.currentJobId ? <button className="text-button" onClick={() => setParams({ job: runner.currentJobId! })}>Inspect assigned job <ArrowUpRight size={13} /></button> : <span className="agent-caption">No assigned job reported</span>}</article>)}</div>
      <div className="agent-workspace">
        <section className="panel agent-runs" aria-label="Agent run history"><header className="panel-header"><div><p className="eyebrow">Current & past work</p><h2>Run history</h2></div><Activity size={20} /></header><div className="agent-filters"><label>Search runs<input type="search" value={query} placeholder="Player, source, or job ID" onChange={(e) => { setQuery(e.target.value); setLimit(15); }} /></label><label>Job status<select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setLimit(15); }}><option value="all">All runs</option><option value="active">Active</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label><label>Computer<select value={deviceFilter} onChange={(e) => { setDeviceFilter(e.target.value); setLimit(15); }}><option value="all">All computers</option>{data.runners.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label></div><div className="agent-run-list">{filtered.slice(0, limit).map((item) => <button className={`agent-run ${selectedId === item.id ? "is-selected" : ""}`} key={item.id} onClick={() => setParams({ job: item.id })} aria-pressed={selectedId === item.id}><span><strong>{jobTitle(item)}</strong><small>{date(item.createdAt)} · {item.leagueSize ?? 12} teams</small></span><span><b className={`status-pill status-pill--${item.status}`}>{item.status}</b><small>{item.citationCount ?? 0} citations · {item.insightCount ?? 0} insights</small></span></button>)}</div>{filtered.length === 0 && <p className="agent-empty">No runs match these filters.</p>}{limit < filtered.length && <button className="button agent-more" onClick={() => setLimit(limit + 15)}>Show more runs</button>}</section>
        <section className="panel agent-run-detail" aria-label="Selected run"><header className="panel-header"><div><p className="eyebrow">Activity & evidence</p><h2>{job ? jobTitle(job) : "Inspect a run"}</h2></div><Clock3 size={20} /></header>{!selectedId ? <p className="agent-empty">Choose a run to see its timeline, research settings, and results.</p> : <div className="agent-detail-body">{detailError && <p role="alert">{detailError}</p>}{job && <><div className="agent-detail-actions"><span className={`status-pill status-pill--${job.status}`}>{job.status}</span><button className="text-button" onClick={exportLog}><Download size={14} /> Export run log</button>{job.status === "failed" && <button className="button" disabled={retrying} onClick={() => void retry()}>Retry run</button>}{job.status === "completed" && outputLink(job) && <NavLink className="button button--primary" to={outputLink(job)!}>Open {job.type === "sleepers_research" ? "sleeper" : "ranking"} run <ArrowUpRight size={14} /></NavLink>}</div><dl className="agent-run-facts"><div><dt>Duration</dt><dd>{elapsed(job, now)}</dd></div><div><dt>Attempts</dt><dd>{job.attempts} / {job.maxAttempts ?? 3}</dd></div><div><dt>Computer</dt><dd>{data.runners.find((r) => r.id === job.runnerId)?.name ?? job.runnerId ?? "Not assigned"}</dd></div><div><dt>Research settings</dt><dd>{job.researchSettings ? `${focusLabels[job.researchSettings.focus]} · ${job.researchSettings.detail} · ${job.researchSettings.recencyDays} days · ${job.type === "source_refresh" ? "Named publisher only" : `target ${job.researchSettings.sourceTarget} sources`}` : "Legacy defaults (not recorded)"}</dd></div></dl>{job.error && <p className="research-error">{job.errorCode && <strong>{job.errorCode}: </strong>}{job.error}</p>}</>}
          <h3>Run timeline</h3><p className="agent-caption">Recorded lifecycle stages and outcomes. Older runners report claim and completion only. Timestamps show events received by the app.</p><ol className="agent-timeline">{events.map((event) => <li key={event.id}><CheckCircle2 size={15} /><div><strong>{typeof event.details.message === "string" ? event.details.message : event.type.replaceAll("_", " ")}</strong><time dateTime={event.createdAt}>{date(event.createdAt)}</time><small>{event.actorType}{event.actorId ? ` · ${data.runners.find((r) => r.id === event.actorId)?.name ?? event.actorId}` : ""}</small></div></li>)}</ol>{events.length === 0 && <p className="agent-caption">No recorded events are available for this run.</p>}{selectedDetail?.result && <ResearchInsights jobs={[selectedDetail]} leagueSize={selectedDetail.leagueSize ?? 12} />}</div>}</section>
      </div>
      <section className="panel agent-tuning" aria-label="Research tuning"><header className="panel-header"><div><p className="eyebrow">Shape future research</p><h2>Agent playbook</h2></div><SlidersHorizontal size={22} /></header><p>These preferences are saved with each newly queued job, including scheduled jobs. Per-run source targets override this default. Queued, running, and historical jobs keep their original settings. Source counts and recency are research targets; evidence may be unavailable. Targets above five ranking sources require desktop 0.1.11 or newer and can take more time and subscription usage.</p><fieldset disabled={saving}><div className="agent-tuning-grid"><label>Research focus<select value={settings.focus} onChange={(e) => patch({ focus: e.target.value as AgentResearchSettings["focus"] })}>{Object.entries(focusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Analysis detail<select value={settings.detail} onChange={(e) => patch({ detail: e.target.value as AgentResearchSettings["detail"] })}><option value="concise">Concise — key decisions</option><option value="standard">Standard — balanced detail</option><option value="thorough">Thorough — evidence & disagreements</option></select></label><label>Preferred evidence age<select value={settings.recencyDays} onChange={(e) => patch({ recencyDays: Number(e.target.value) as AgentResearchSettings["recencyDays"] })}><option value={7}>Past 7 days</option><option value={30}>Past 30 days</option><option value={90}>Past 90 days</option></select></label><label>Independent source target<select value={settings.sourceTarget} onChange={(e) => patch({ sourceTarget: Number(e.target.value) as AgentResearchSettings["sourceTarget"] })}>{SOURCE_TARGET_OPTIONS.map((count) => <option key={count} value={count}>{count} sources</option>)}</select></label></div><div className="agent-detail-actions"><button className="button button--primary" disabled={!dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save playbook"}</button><button className="button" onClick={() => setDraft({ ...DEFAULT_AGENT_SETTINGS })}>Use defaults</button>{dirty && <span className="agent-caption">Unsaved changes</span>}<NavLink className="text-button" to="/research/schedules">Manage schedules</NavLink><NavLink className="text-button" to="/settings">Computer controls</NavLink></div></fieldset></section>
    </>}
  </div>;
}
