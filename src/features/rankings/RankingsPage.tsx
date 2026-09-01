import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Columns2,
  ExternalLink,
  GripVertical,
  List,
  Newspaper,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  SwitchCamera,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router";
import {
  fetchResearchJobs,
  RESEARCH_OWNER_TOKEN_KEY,
  type ResearchJob,
} from "../research/research-api";
import { fetchAgentRankings, type AgentRankingSnapshot } from "./agent-api";
import {
  aggregateRankingSnapshots,
  normalizePlayerName,
  selectLatestSnapshotPerSource,
  type AggregatedRankingEntry,
} from "./ranking-aggregate";
import {
  loadRankingsPreferences,
  saveRankingsPreferences,
  toggleFavoriteSource,
  type RankingsPreferences,
} from "./ranking-preferences";
import {
  applyAgentOrder,
  loadPersonalRankings,
  moveRanking,
  reorderRankings,
  savePersonalRankings,
  starterRankings,
  type RankingPlayer,
} from "./ranking-store";

const positions = ["ALL", "QB", "RB", "WR", "TE"] as const;

function relativeTime(value: string): string {
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "just now";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SortableRankingRow({
  player,
  rank,
  total,
  onMove,
}: {
  player: RankingPlayer;
  rank: number;
  total: number;
  onMove: (playerId: string, direction: "up" | "down") => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
  });
  const difference = player.consensusRank - rank;

  return (
    <li
      className={`ranking-row${isDragging ? " is-dragging" : ""}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        className="drag-handle"
        type="button"
        aria-label={`Reorder ${player.name}, currently rank ${rank}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} />
      </button>
      <strong className="ranking-number">{rank}</strong>
      <span className="position-orb">{player.position}</span>
      <div className="ranking-player">
        <strong>{player.name}</strong>
        <span>{player.team} · PPR redraft</span>
      </div>
      <div className="ranking-comparison">
        <span>Consensus</span>
        <strong>#{player.consensusRank}</strong>
      </div>
      <span className={`rank-delta${difference > 0 ? " is-positive" : difference < 0 ? " is-negative" : ""}`}>
        {difference === 0 ? "EVEN" : difference > 0 ? `MY +${difference}` : `MY ${difference}`}
      </span>
      <div className="ranking-row__actions" aria-label={`Move ${player.name}`}>
        <button
          type="button"
          aria-label={`Move ${player.name} up`}
          disabled={rank === 1}
          onClick={() => onMove(player.id, "up")}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          aria-label={`Move ${player.name} down`}
          disabled={rank === total}
          onClick={() => onMove(player.id, "down")}
        >
          <ArrowDown size={14} />
        </button>
      </div>
    </li>
  );
}

type DisplayRankingEntry = AgentRankingSnapshot["entries"][number] | AggregatedRankingEntry;

function isAggregateEntry(entry: DisplayRankingEntry): entry is AggregatedRankingEntry {
  return "sourceRanks" in entry;
}

function AgentRankingRow({
  entry,
  snapshot,
  researchJob,
  hasOwnerToken,
}: {
  entry: DisplayRankingEntry;
  snapshot: AgentRankingSnapshot;
  researchJob?: ResearchJob;
  hasOwnerToken: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const movement = entry.previousRank === null ? null : entry.previousRank - entry.rank;
  const research = researchJob?.result;
  const aggregateEntry = isAggregateEntry(entry) ? entry : null;

  return (
    <li className={`agent-ranking-row${expanded ? " is-expanded" : ""}`}>
      <button
        className="agent-ranking-row__toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <strong className="agent-ranking-number">{entry.rank}</strong>
        <span className="position-orb">{entry.position ?? "?"}</span>
        <span className="agent-ranking-player">
          <strong>{entry.playerName}</strong>
          <small>{entry.team ?? "FA"} · {aggregateEntry ? `Average ${aggregateEntry.averageRank.toFixed(1)}` : snapshot.source.name}</small>
        </span>
        <span className="agent-ranking-context">
          {aggregateEntry ? `${aggregateEntry.coverage}/${aggregateEntry.sourceCount} sources` : entry.tier ? `Tier ${entry.tier}` : "Details"}
        </span>
        {movement !== null && movement !== 0 ? (
          <span className={`agent-ranking-movement ${movement > 0 ? "positive" : "negative"}`}>
            {movement > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {movement > 0 ? `+${movement}` : movement}
          </span>
        ) : <span className="agent-ranking-movement is-muted">{entry.previousRank ? "Even" : "New"}</span>}
        <ChevronRight className="agent-ranking-chevron" size={16} />
      </button>

      {expanded && (
        <div className="agent-player-details" id={detailsId} role="region" aria-label={`${entry.playerName} details`}>
          <section>
            <header><Sparkles size={14} /><strong>Ranking insight</strong></header>
            {entry.insight ? <p>{entry.insight}</p> : aggregateEntry ? (
              <div className="expert-rank-grid">
                {aggregateEntry.sourceRanks.map((sourceRank) => (
                  <div key={`${sourceRank.snapshotId}:${sourceRank.sourceId}`}>
                    {sourceRank.attributionUrl
                      ? <a href={sourceRank.attributionUrl} target="_blank" rel="noreferrer">{sourceRank.sourceName}<ExternalLink size={10} /></a>
                      : <span>{sourceRank.sourceName}</span>}
                    <strong>#{sourceRank.rank}</strong>
                    {sourceRank.insight && <p>{sourceRank.insight}</p>}
                  </div>
                ))}
              </div>
            ) : <p>No player-specific note was included in this snapshot.</p>}
            <small>{snapshot.methodology ?? "Rankings are preserved exactly as returned by this source."}</small>
          </section>

          <section>
            <header><Newspaper size={14} /><strong>Latest player research</strong></header>
            {research ? (
              <>
                <p>{research.summary}</p>
                {research.insights.slice(0, 2).map((insight) => <p className="player-finding" key={`${insight.subject}:${insight.finding}`}>{insight.finding}</p>)}
                <div className="player-detail-links">
                  {research.citations.slice(0, 3).map((citation) => (
                    <a href={citation.url} key={citation.url} target="_blank" rel="noreferrer">{citation.publisher ?? citation.title}<ExternalLink size={11} /></a>
                  ))}
                </div>
                <small>Researched {relativeTime(research.generatedAt)}</small>
              </>
            ) : (
              <p>{hasOwnerToken ? "No completed player research is saved yet." : "Save the owner token to load private player research."}</p>
            )}
            <NavLink className="player-research-link" to={`/research?subject=${encodeURIComponent(entry.playerName)}`}>
              <Bot size={12} /> Research latest news
            </NavLink>
          </section>

          <section>
            <header><BarChart3 size={14} /><strong>Weekly & season stats</strong></header>
            <p>Historical box scores are ready for the next data connection. Yahoo league sync or the planned nflverse feed will populate weekly game logs and season totals here.</p>
            <small>No demonstration statistics are shown as live data.</small>
          </section>
        </div>
      )}
    </li>
  );
}

function AgentSnapshotPanel({
  snapshots,
  loading,
  error,
  collapsed,
  favoriteSourceKeys,
  researchByPlayer,
  hasOwnerToken,
  onCollapsedChange,
  onRefresh,
  onToggleFavorite,
  onApply,
}: {
  snapshots: AgentRankingSnapshot[];
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  favoriteSourceKeys: string[];
  researchByPlayer: Map<string, ResearchJob>;
  hasOwnerToken: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onRefresh: () => void;
  onToggleFavorite: (sourceSlug: string) => void;
  onApply: (snapshot: AgentRankingSnapshot, position: string) => void;
}) {
  const [selectedSourceKey, setSelectedSourceKey] = useState("aggregate");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyScope, setCopyScope] = useState("ALL");
  const latestBySource = useMemo(() => selectLatestSnapshotPerSource(snapshots), [snapshots]);
  const aggregate = useMemo(() => aggregateRankingSnapshots(snapshots), [snapshots]);
  const selectedSource = latestBySource.find((snapshot) => snapshot.source.canonicalKey === selectedSourceKey);
  const sourceHistory = selectedSourceKey === "aggregate"
    ? []
    : snapshots.filter((snapshot) => snapshot.source.canonicalKey === selectedSourceKey);
  const selected = selectedSourceKey === "aggregate"
    ? aggregate?.snapshot
    : snapshots.find((snapshot) => snapshot.id === selectedId && snapshot.source.canonicalKey === selectedSourceKey) ?? selectedSource;
  const displayEntries: DisplayRankingEntry[] = selectedSourceKey === "aggregate"
    ? aggregate?.entries ?? []
    : selected?.entries ?? [];

  useEffect(() => {
    setSelectedId(null);
  }, [snapshots[0]?.id]);

  useEffect(() => {
    if (selectedSourceKey !== "aggregate" && !latestBySource.some((snapshot) => snapshot.source.canonicalKey === selectedSourceKey)) {
      setSelectedSourceKey("aggregate");
      setSelectedId(null);
    }
  }, [latestBySource, selectedSourceKey]);

  function selectSource(snapshot: AgentRankingSnapshot) {
    setSelectedSourceKey(snapshot.source.canonicalKey);
    setSelectedId(snapshot.id);
  }

  return (
    <aside className={`agent-rankings panel${collapsed ? " is-collapsed" : ""}`} aria-label="Agent ranking updates">
      <header className="agent-rankings__header">
        <div className="research-callout__icon"><Bot size={19} /></div>
        <div>
          <p className="eyebrow">Agent workspace · Read only</p>
          <h2>Ranking Sources</h2>
        </div>
        <div className="agent-header-actions">
          {selected && <span className="status-pill status-pill--snapshot"><Clock3 size={11} /> Snapshot</span>}
          <button type="button" aria-label="Check agent rankings for updates" onClick={onRefresh}>
            <RefreshCw className={loading ? "spin" : ""} size={14} />
          </button>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand agent rankings" : "Collapse agent rankings"}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
        </div>
      </header>

      {collapsed ? (
        <div className="agent-collapsed-summary">
          <span>{snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}</span>
          <span>{favoriteSourceKeys.length} favorite source{favoriteSourceKeys.length === 1 ? "" : "s"}</span>
        </div>
      ) : <>

      {loading && <div className="agent-empty"><RefreshCw className="spin" size={20} /><p>Checking for new snapshots…</p></div>}
      {!loading && error && (
        <div className="agent-empty">
          <p>Agent rankings are temporarily unavailable.</p>
          <small>{error}</small>
        </div>
      )}
      {!loading && !error && snapshots.length === 0 && (
        <div className="agent-empty">
          <Sparkles size={22} />
          <h3>No agent snapshots yet</h3>
          <p>The ingestion endpoint is ready. Completed ranking research will appear here without changing your board.</p>
          <NavLink className="button button--secondary" to="/research">Open Research Desk</NavLink>
        </div>
      )}

      {selected && (
        <>
          <div className="agent-source-strip" aria-label="Ranking sources">
            {aggregate && (
              <button
                className={`aggregate-source-chip${selectedSourceKey === "aggregate" ? " is-active" : ""}`}
                type="button"
                aria-pressed={selectedSourceKey === "aggregate"}
                onClick={() => { setSelectedSourceKey("aggregate"); setSelectedId(null); }}
              >
                <Sparkles size={12} /> Aggregate
              </button>
            )}
            {[...latestBySource]
              .sort((left, right) => Number(favoriteSourceKeys.includes(right.source.canonicalKey)) - Number(favoriteSourceKeys.includes(left.source.canonicalKey)))
              .map((snapshot) => {
                const favorite = favoriteSourceKeys.includes(snapshot.source.canonicalKey);
                const active = snapshot.source.canonicalKey === selectedSourceKey;
                return (
                  <div className={`source-chip${active ? " is-active" : ""}`} key={snapshot.source.canonicalKey}>
                    <button type="button" aria-pressed={active} onClick={() => selectSource(snapshot)}>{snapshot.source.name}</button>
                    <button
                      className={favorite ? "is-favorite" : ""}
                      type="button"
                      aria-label={`${favorite ? "Remove" : "Add"} ${snapshot.source.name} ${favorite ? "from" : "to"} favorites`}
                      aria-pressed={favorite}
                      onClick={() => onToggleFavorite(snapshot.source.canonicalKey)}
                    >
                      <Star size={12} fill={favorite ? "currentColor" : "none"} />
                    </button>
                  </div>
                );
              })}
          </div>
          <div className="snapshot-meta">
            <div>
              <strong>{selected.title}</strong>
              <span>{selectedSourceKey === "aggregate" ? `${aggregate?.sourceSnapshots.length ?? 0} latest compatible source${aggregate?.sourceSnapshots.length === 1 ? "" : "s"}` : `${selected.source.name} · ${(selected.source.kind ?? "agent").toUpperCase()} ${selected.source.provider ? `via ${selected.source.provider}` : ""}`}</span>
              <code title="Stable source key">{selectedSourceKey === "aggregate" ? "Unweighted arithmetic mean" : `Source key · ${selected.source.canonicalKey}`}</code>
              {selectedSourceKey !== "aggregate" && selected.source.attributionUrl && <a className="snapshot-source-link" href={selected.source.attributionUrl} target="_blank" rel="noreferrer">View original source <ExternalLink size={10} /></a>}
            </div>
            <div className="snapshot-scope">
              <span><Clock3 size={13} /> {relativeTime(selected.generatedAt)}</span>
              <span>{selected.scoringFormat.toUpperCase()} · {selected.rankingType.replaceAll("_", " ")} · {selected.season}</span>
            </div>
          </div>
          {selected.summary && <p className="snapshot-summary">{selected.summary}</p>}
          <div className="agent-ranking-list-heading" aria-hidden="true"><span>Rank</span><span>Player</span><span>Source context</span><span>Move</span></div>
          <ol className="agent-ranking-list">
            {displayEntries.map((entry) => (
              <AgentRankingRow
                entry={entry}
                hasOwnerToken={hasOwnerToken}
                key={entry.id}
                researchJob={researchByPlayer.get(normalizePlayerName(entry.playerName))}
                snapshot={selected}
              />
            ))}
          </ol>
          <div className="agent-copy-controls">
            <label>
              Copy
              <select value={copyScope} onChange={(event) => setCopyScope(event.target.value)}>
                <option value="ALL">All positions</option>
                {[...new Set(selected.entries.map((entry) => entry.position).filter(Boolean))].map((value) => (
                  <option key={value} value={value!}>{value}</option>
                ))}
              </select>
            </label>
            <button className="button button--primary agent-rankings__apply" type="button" onClick={() => onApply(selected, copyScope)}>
              Copy into My Rankings
            </button>
            {selectedSourceKey !== "aggregate" && <NavLink
              className="button button--secondary agent-rankings__refresh"
              to={`/research?source=${encodeURIComponent(selected.source.slug)}&sourceName=${encodeURIComponent(selected.source.name)}`}
            >
              <RefreshCw size={13} /> Research an update
            </NavLink>}
          </div>
          {sourceHistory.length > 1 && (
            <label className="snapshot-select">
              Source history
              <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                {sourceHistory.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.title}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      </>}
    </aside>
  );
}

export default function RankingsPage() {
  const [rankings, setRankings] = useState<RankingPlayer[]>(() =>
    typeof window === "undefined" ? starterRankings : loadPersonalRankings(window.localStorage));
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<(typeof positions)[number]>("ALL");
  const [announcement, setAnnouncement] = useState("");
  const [snapshots, setSnapshots] = useState<AgentRankingSnapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [researchJobs, setResearchJobs] = useState<ResearchJob[]>([]);
  const ownerToken = typeof window === "undefined" ? "" : window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)?.trim() ?? "";
  const [pendingCopy, setPendingCopy] = useState<{ snapshot: AgentRankingSnapshot; position: string } | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [preferences, setPreferences] = useState<RankingsPreferences>(() =>
    typeof window === "undefined" ? loadRankingsPreferences({ getItem: () => null }) : loadRankingsPreferences(window.localStorage));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const confirmationRef = useRef<HTMLDivElement>(null);
  const copyTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    savePersonalRankings(window.localStorage, rankings);
    setSavedAt(new Date());
  }, [rankings]);

  useEffect(() => {
    saveRankingsPreferences(window.localStorage, preferences);
  }, [preferences]);

  useEffect(() => {
    if (pendingCopy) confirmationRef.current?.focus();
  }, [pendingCopy]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAgentSnapshots(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!ownerToken) return;
    const controller = new AbortController();
    void fetchResearchJobs(ownerToken, controller.signal, 100)
      .then(setResearchJobs)
      .catch(() => setResearchJobs([]));
    return () => controller.abort();
  }, [ownerToken]);

  const researchByPlayer = useMemo(() => {
    const byPlayer = new Map<string, ResearchJob>();
    for (const job of researchJobs) {
      if (job.type !== "player_research" || job.status !== "completed" || !job.subject || !job.result) continue;
      const key = normalizePlayerName(job.subject);
      if (!byPlayer.has(key)) byPlayer.set(key, job);
    }
    return byPlayer;
  }, [researchJobs]);

  async function loadAgentSnapshots(signal?: AbortSignal) {
    setSnapshotsLoading(true);
    setSnapshotError(null);
    try {
      setSnapshots(await fetchAgentRankings(signal));
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSnapshotError(error instanceof Error ? error.message : "Unknown ranking error");
    } finally {
      if (!signal?.aborted) setSnapshotsLoading(false);
    }
  }

  const visibleRankings = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rankings.filter((player) =>
      (position === "ALL" || player.position === position) &&
      (!normalizedQuery || `${player.name} ${player.team}`.toLowerCase().includes(normalizedQuery)));
  }, [position, query, rankings]);

  function announceMove(playerId: string, before: RankingPlayer[], after: RankingPlayer[]) {
    const player = before.find((item) => item.id === playerId);
    if (!player) return;
    const from = before.findIndex((item) => item.id === playerId) + 1;
    const to = after.findIndex((item) => item.id === playerId) + 1;
    if (from !== to) setAnnouncement(`Moved ${player.name} from rank ${from} to rank ${to}`);
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const next = reorderRankings(rankings, String(event.active.id), String(event.over.id));
    announceMove(String(event.active.id), rankings, next);
    setRankings(next);
  }

  function handleMove(playerId: string, direction: "up" | "down") {
    const next = moveRanking(rankings, playerId, direction);
    announceMove(playerId, rankings, next);
    setRankings(next);
  }

  function confirmAgentOrder() {
    if (!pendingCopy) return;
    const next = applyAgentOrder(rankings, pendingCopy.snapshot.entries, pendingCopy.position);
    setRankings(next);
    setAnnouncement(`Copied ${pendingCopy.position === "ALL" ? "all positions" : pendingCopy.position} from ${pendingCopy.snapshot.title} to your personal order`);
    setPendingCopy(null);
  }

  function cancelAgentOrder() {
    setPendingCopy(null);
    queueMicrotask(() => copyTriggerRef.current?.focus());
  }

  function requestAgentOrder(snapshot: AgentRankingSnapshot, copyPosition: string) {
    copyTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingCopy({ snapshot, position: copyPosition });
  }

  function saveBoard() {
    savePersonalRankings(window.localStorage, rankings);
    setSavedAt(new Date());
    setAnnouncement("Saved your personal rankings on this device");
  }

  function updatePreferences(update: Partial<RankingsPreferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  function toggleSource(sourceKey: string) {
    setPreferences((current) => ({
      ...current,
      favoriteSourceKeys: toggleFavoriteSource(current.favoriteSourceKeys, sourceKey),
    }));
  }

  const personalWorkspace = (
    <section className="workspace-section workspace-section--personal" aria-labelledby="personal-workspace-title">
      <header className="workspace-section__banner">
        <div>
          <span className="workspace-boundary workspace-boundary--private">Private · Editable</span>
          <h2 id="personal-workspace-title">My Rankings</h2>
          <p>Your saved order. Drag, filter, and edit without changing agent snapshots.</p>
        </div>
        <span className="workspace-owner">Owned by you</span>
      </header>
      <section className="panel personal-board">
        <div className="ranking-toolbar">
          <label className="ranking-search">
            <Search size={15} />
            <span className="sr-only">Search rankings</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or team" />
          </label>
          <div className="position-filters" aria-label="Filter by position">
            {positions.map((value) => (
              <button className={position === value ? "is-active" : ""} key={value} onClick={() => setPosition(value)} type="button">{value}</button>
            ))}
          </div>
          <button className="reset-board" type="button" onClick={() => setRankings(starterRankings)}>
            <RotateCcw size={14} /> Reset
          </button>
        </div>
        <div className="ranking-column-labels" aria-hidden="true">
          <span>Rank / player</span><span>Market</span><span>Difference</span><span>Move</span>
        </div>
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} sensors={sensors}>
          <SortableContext items={visibleRankings.map((player) => player.id)} strategy={verticalListSortingStrategy}>
            <ol className="ranking-list">
              {visibleRankings.map((player) => (
                <SortableRankingRow
                  key={player.id}
                  player={player}
                  rank={rankings.findIndex((item) => item.id === player.id) + 1}
                  total={rankings.length}
                  onMove={handleMove}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        {visibleRankings.length === 0 && <div className="board-empty"><SlidersHorizontal size={20} /><p>No players match these filters.</p></div>}
        <footer className="board-methodology">Starter names are demonstration data, not current expert advice. Your ordering is private to this browser until account sync is added.</footer>
      </section>
    </section>
  );

  const agentWorkspace = (
    <section className="workspace-section workspace-section--agent" aria-labelledby="agent-workspace-title">
      <header className="workspace-section__banner">
        <div>
          <span className="workspace-boundary workspace-boundary--agent">Agent-found · Read only</span>
          <h2 id="agent-workspace-title">Agent Rankings</h2>
          <p>Fresh snapshots and favorite sources. Nothing crosses into your board without confirmation.</p>
        </div>
        <span className="workspace-owner">External evidence</span>
      </header>
      <AgentSnapshotPanel
        snapshots={snapshots}
        loading={snapshotsLoading}
        error={snapshotError}
        collapsed={preferences.agentCollapsed}
        favoriteSourceKeys={preferences.favoriteSourceKeys}
        researchByPlayer={researchByPlayer}
        hasOwnerToken={Boolean(ownerToken)}
        onCollapsedChange={(agentCollapsed) => updatePreferences({ agentCollapsed })}
        onRefresh={() => { void loadAgentSnapshots(); }}
        onToggleFavorite={toggleSource}
        onApply={requestAgentOrder}
      />
    </section>
  );

  return (
    <div className="page rankings-page">
      <header className="page-header rankings-header">
        <div>
          <p className="eyebrow">Two independent workspaces</p>
          <h1>Rankings Center</h1>
          <p className="page-header__copy">Build your private board and review agent-found rankings without mixing the two.</p>
        </div>
        <div className="page-header__actions">
          <span className="badge badge--amber">PPR Redraft</span>
          <button className="button button--secondary save-board" type="button" onClick={saveBoard}><Check size={14} /> Save my rankings</button>
          <span className="autosave-state">{savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not saved"}</span>
        </div>
      </header>

      <section className="ranking-stats" aria-label="Ranking board summary">
        <div><span>Players ranked</span><strong>{rankings.length}</strong></div>
        <div><span>Your biggest reach</span><strong>{Math.max(...rankings.map((player, index) => player.consensusRank - index - 1), 0)} spots</strong></div>
        <div><span>Agent snapshots</span><strong>{snapshots.length}</strong></div>
        <div><span>Board scope</span><strong>Overall · Draft</strong></div>
      </section>

      <section className="workspace-controls panel" aria-label="Rankings workspace layout">
        <div><SlidersHorizontal size={15} /><span>Arrange workspace</span></div>
        <div className="workspace-control-group" aria-label="Layout">
          <button className={preferences.layout === "split" ? "is-active" : ""} type="button" onClick={() => updatePreferences({ layout: "split" })}><Columns2 size={13} /> Split</button>
          <button className={preferences.layout === "stacked" ? "is-active" : ""} type="button" onClick={() => updatePreferences({ layout: "stacked" })}><List size={13} /> Stacked</button>
        </div>
        <button className="workspace-order-button" type="button" onClick={() => updatePreferences({ sectionOrder: preferences.sectionOrder === "personal-first" ? "agent-first" : "personal-first" })}>
          <SwitchCamera size={13} /> {preferences.sectionOrder === "personal-first" ? "Show agents first" : "Show my board first"}
        </button>
      </section>

      <div className={`rankings-workspace rankings-workspace--${preferences.layout}`}>
        {preferences.sectionOrder === "personal-first" ? <>{personalWorkspace}{agentWorkspace}</> : <>{agentWorkspace}{personalWorkspace}</>}
      </div>

      {pendingCopy && (
        <div
          aria-labelledby="copy-rankings-title"
          className="confirmation-bar"
          onKeyDown={(event) => { if (event.key === "Escape") cancelAgentOrder(); }}
          ref={confirmationRef}
          role="alertdialog"
          tabIndex={-1}
        >
          <div><Sparkles size={17} /><span><strong id="copy-rankings-title">Copy {pendingCopy.position === "ALL" ? "all positions" : pendingCopy.position} from {pendingCopy.snapshot.title}?</strong> {pendingCopy.position === "ALL" ? "Your personal ordering will be replaced by this snapshot." : "Other positions stay in their current order."}</span></div>
          <div><button type="button" onClick={cancelAgentOrder}>Cancel</button><button className="button button--primary" type="button" onClick={confirmAgentOrder}>Copy rankings</button></div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
