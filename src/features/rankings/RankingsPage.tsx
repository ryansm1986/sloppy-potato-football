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
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Columns2,
  GripVertical,
  List,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router";
import { fetchAgentRankings, type AgentRankingSnapshot } from "./agent-api";
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

function AgentSnapshotPanel({
  snapshots,
  loading,
  error,
  collapsed,
  favoriteSourceKeys,
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
  onCollapsedChange: (collapsed: boolean) => void;
  onRefresh: () => void;
  onToggleFavorite: (sourceSlug: string) => void;
  onApply: (snapshot: AgentRankingSnapshot, position: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyScope, setCopyScope] = useState("ALL");
  const selected = snapshots.find((snapshot) => snapshot.id === selectedId)
    ?? snapshots.find((snapshot) => favoriteSourceKeys.includes(snapshot.source.canonicalKey))
    ?? snapshots[0];

  useEffect(() => {
    setSelectedId(null);
  }, [snapshots[0]?.id]);

  return (
    <aside className={`agent-rankings panel${collapsed ? " is-collapsed" : ""}`} aria-label="Agent ranking updates">
      <header className="agent-rankings__header">
        <div className="research-callout__icon"><Bot size={19} /></div>
        <div>
          <p className="eyebrow">Agent workspace · Read only</p>
          <h2>Latest Snapshot</h2>
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
            {[...new Map(snapshots.map((snapshot) => [snapshot.source.canonicalKey, snapshot])).values()]
              .sort((left, right) => Number(favoriteSourceKeys.includes(right.source.canonicalKey)) - Number(favoriteSourceKeys.includes(left.source.canonicalKey)))
              .map((snapshot) => {
                const favorite = favoriteSourceKeys.includes(snapshot.source.canonicalKey);
                const active = snapshot.source.canonicalKey === selected.source.canonicalKey;
                return (
                  <div className={`source-chip${active ? " is-active" : ""}`} key={snapshot.source.canonicalKey}>
                    <button type="button" onClick={() => setSelectedId(snapshot.id)}>{snapshot.source.name}</button>
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
              <span>{selected.source.name} · {(selected.source.kind ?? "agent").toUpperCase()} {selected.source.provider ? `via ${selected.source.provider}` : ""}</span>
              <code title="Stable source key">Source key · {selected.source.canonicalKey}</code>
            </div>
            <div className="snapshot-scope">
              <span><Clock3 size={13} /> {relativeTime(selected.generatedAt)}</span>
              <span>{selected.scoringFormat.toUpperCase()} · {selected.rankingType.replaceAll("_", " ")} · {selected.season}</span>
            </div>
          </div>
          {selected.summary && <p className="snapshot-summary">{selected.summary}</p>}
          <div className="agent-moves">
            {selected.entries.slice(0, 8).map((entry) => {
              const movement = entry.previousRank === null ? null : entry.previousRank - entry.rank;
              return (
                <article key={entry.id}>
                  <span className="position-orb">{entry.position ?? "?"}</span>
                  <div>
                    <strong>{entry.playerName}</strong>
                    <span>{entry.team ?? "FA"} · Agent #{entry.rank}</span>
                  </div>
                  {movement !== null && movement !== 0 ? (
                    <b className={movement > 0 ? "positive" : "negative"}>
                      {movement > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      {movement > 0 ? `+${movement}` : movement}
                    </b>
                  ) : <b className="muted-rank">NEW</b>}
                  {entry.insight && <p>{entry.insight}</p>}
                </article>
              );
            })}
          </div>
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
            <NavLink
              className="button button--secondary agent-rankings__refresh"
              to={`/research?source=${encodeURIComponent(selected.source.slug)}&sourceName=${encodeURIComponent(selected.source.name)}`}
            >
              <RefreshCw size={13} /> Research an update
            </NavLink>
          </div>
          {snapshots.length > 1 && (
            <label className="snapshot-select">
              Snapshot
              <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.title}</option>)}
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
