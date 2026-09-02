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
  CircleMinus,
  CirclePlus,
  Clock3,
  Columns2,
  ExternalLink,
  FileSpreadsheet,
  GripVertical,
  Hash,
  List,
  Newspaper,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  SwitchCamera,
  Telescope,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { NavLink } from "react-router";
import {
  DEFAULT_LEAGUE_SIZE,
  LEAGUE_SIZE_OPTIONS,
  loadLeagueSize,
  normalizeLeagueSize,
  saveLeagueSize,
  type LeagueSize,
} from "../league-size";
import {
  fetchResearchJobs,
  RESEARCH_OWNER_TOKEN_KEY,
  type ResearchJob,
} from "../research/research-api";
import { fetchAgentRankings, type AgentRankingSnapshot } from "./agent-api";
import { fetchFantasyPlayerCatalog, type CanonicalFantasyPlayer } from "./player-api";
import {
  fetchCloudPersonalRankings,
  saveCloudPersonalRankings,
  type CloudPersonalRankingBoard,
} from "./personal-rankings-api";
import {
  aggregateRankingSnapshots,
  isSnapshotInScope,
  normalizePlayerName,
  selectLatestSnapshotPerSource,
  type AggregatedRankingEntry,
} from "./ranking-aggregate";
import {
  clampRankingsSplitRatio,
  DEFAULT_RANKINGS_SPLIT_RATIO,
  MAX_RANKINGS_SPLIT_RATIO,
  MIN_RANKINGS_SPLIT_RATIO,
  loadRankingsPreferences,
  saveRankingsPreferences,
  toggleAggregateSource,
  toggleFavoriteSource,
  type RankingsPreferences,
} from "./ranking-preferences";
import { derivePositionRanks, type PositionRank } from "./ranking-position";
import { exportRankingsToExcel } from "./rankings-export";
import {
  applyAgentOrder,
  hydratePersonalRankings,
  loadSavedPersonalRankings,
  moveRanking,
  moveRankingTo,
  reorderRankings,
  resetPersonalRankings,
  savePersonalRankings,
  starterRankings,
  type RankingPlayer,
} from "./ranking-store";

const positions = ["ALL", "QB", "RB", "WR", "TE", "K", "DST"] as const;

type WorkspaceDividerProps = {
  leftWorkspaceName: string;
  ratio: number;
  onRatioChange: (ratio: number) => void;
};

function WorkspaceDivider({ leftWorkspaceName, ratio, onRatioChange }: WorkspaceDividerProps) {
  const draggingRef = useRef(false);

  function updateFromPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    onRatioChange(clampRankingsSplitRatio(((event.clientX - bounds.left) / bounds.width) * 100));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (draggingRef.current) updateFromPointer(event);
  }

  function stopDragging(event: PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 5 : 2;
    let nextRatio: number | null = null;
    if (event.key === "ArrowLeft") nextRatio = ratio - step;
    if (event.key === "ArrowRight") nextRatio = ratio + step;
    if (event.key === "Home") nextRatio = MIN_RANKINGS_SPLIT_RATIO;
    if (event.key === "End") nextRatio = MAX_RANKINGS_SPLIT_RATIO;
    if (nextRatio === null) return;
    event.preventDefault();
    onRatioChange(clampRankingsSplitRatio(nextRatio));
  }

  return (
    <div
      aria-label="Resize rankings workspaces"
      aria-orientation="vertical"
      aria-valuemax={MAX_RANKINGS_SPLIT_RATIO}
      aria-valuemin={MIN_RANKINGS_SPLIT_RATIO}
      aria-valuenow={ratio}
      aria-valuetext={`${leftWorkspaceName} uses ${ratio}% of the workspace`}
      className="workspace-divider"
      onDoubleClick={() => onRatioChange(DEFAULT_RANKINGS_SPLIT_RATIO)}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={() => { draggingRef.current = false; }}
      onPointerCancel={stopDragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      role="separator"
      tabIndex={0}
      title="Drag to resize. Use arrow keys for precise control; double-click to reset."
    >
      <span aria-hidden="true"><GripVertical size={13} /></span>
      <small aria-hidden="true">Separate workspace</small>
    </div>
  );
}

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
  positionRank,
  total,
  onMove,
  onMoveToRank,
}: {
  player: RankingPlayer;
  rank: number;
  positionRank: PositionRank;
  total: number;
  onMove: (playerId: string, direction: "up" | "down") => void;
  onMoveToRank: (playerId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
  });
  const difference = player.consensusRank === null ? null : player.consensusRank - rank;

  return (
    <li
      className={`ranking-row${isDragging ? " is-dragging" : ""}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        className="drag-handle"
        type="button"
        aria-label={`Reorder ${player.name}, currently overall rank ${rank} and ${positionRank.position} rank ${positionRank.rank}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} />
      </button>
      <span className="ranking-rank-pair" aria-label={`Overall rank ${rank}; ${positionRank.position} rank ${positionRank.rank}`}>
        <span><small>OVR</small><button className="ranking-number-button" type="button" aria-label={`Change ${player.name} overall rank`} onClick={() => onMoveToRank(player.id)}><strong className="ranking-number">{rank}</strong></button></span>
        <span><small>{positionRank.position}</small><strong className="ranking-position-number">#{positionRank.rank}</strong></span>
      </span>
      <span className="position-orb">{player.position}</span>
      <div className="ranking-player">
        <strong>{player.name}</strong>
        <span>{player.team} · PPR redraft</span>
      </div>
      <div className="ranking-comparison">
        <span>Consensus</span>
        <strong>{player.consensusRank === null ? "Unranked" : `#${player.consensusRank}`}</strong>
      </div>
      <span className={`rank-delta${difference !== null && difference > 0 ? " is-positive" : difference !== null && difference < 0 ? " is-negative" : ""}`}>
        {difference === null ? "NO MARKET" : difference === 0 ? "EVEN" : difference > 0 ? `MY +${difference}` : `MY ${difference}`}
      </span>
      <div className="ranking-row__actions" aria-label={`Move ${player.name}`}>
        <button
          type="button"
          aria-label={`Move ${player.name} to an exact rank`}
          onClick={() => onMoveToRank(player.id)}
          title="Move to rank"
        >
          <Hash size={14} />
        </button>
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
  positionRank,
  hasOverallRank,
  snapshot,
  researchJob,
  hasOwnerToken,
}: {
  entry: DisplayRankingEntry;
  positionRank?: PositionRank;
  hasOverallRank: boolean;
  snapshot: AgentRankingSnapshot;
  researchJob?: ResearchJob;
  hasOwnerToken: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const movement = entry.previousRank === null ? null : entry.previousRank - entry.rank;
  const research = researchJob?.result;
  const aggregateEntry = isAggregateEntry(entry) ? entry : null;
  const rankLabel = positionRank
    ? `${hasOverallRank ? `Overall rank ${entry.rank}` : "Overall rank unavailable"}; ${positionRank.position} rank ${positionRank.rank}`
    : hasOverallRank ? `Overall rank ${entry.rank}` : "Overall rank unavailable";

  return (
    <li className={`agent-ranking-row${expanded ? " is-expanded" : ""}`}>
      <button
        className="agent-ranking-row__toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className="agent-ranking-rank-pair"
          aria-label={rankLabel}
        >
          <span><small>OVR</small><strong className="agent-ranking-number">{hasOverallRank ? entry.rank : "—"}</strong></span>
          {positionRank && <span><small>{positionRank.position}</small><strong className="agent-position-rank">#{positionRank.rank}</strong></span>}
        </span>
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
  excludedAggregateSourceKeys,
  researchByPlayer,
  hasOwnerToken,
  onCollapsedChange,
  onRefresh,
  onToggleFavorite,
  onToggleAggregateSource,
  onRestoreAggregateSources,
  onApply,
  leagueSize,
}: {
  snapshots: AgentRankingSnapshot[];
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  favoriteSourceKeys: string[];
  excludedAggregateSourceKeys: string[];
  researchByPlayer: Map<string, ResearchJob>;
  hasOwnerToken: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onRefresh: () => void;
  onToggleFavorite: (sourceSlug: string) => void;
  onToggleAggregateSource: (sourceKey: string) => void;
  onRestoreAggregateSources: (sourceKeys: string[]) => void;
  onApply: (snapshot: AgentRankingSnapshot, position: string) => void;
  leagueSize: LeagueSize;
}) {
  const [selectedSourceKey, setSelectedSourceKey] = useState("aggregate");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyScope, setCopyScope] = useState("ALL");
  const [listPosition, setListPosition] = useState("ALL");
  const [playerNameFilter, setPlayerNameFilter] = useState("");
  const [displayCount, setDisplayCount] = useState("50");
  const fullAggregate = useMemo(() => aggregateRankingSnapshots(snapshots), [snapshots]);
  const aggregate = useMemo(
    () => aggregateRankingSnapshots(snapshots, excludedAggregateSourceKeys),
    [excludedAggregateSourceKeys, snapshots],
  );
  const scopedSnapshots = useMemo(
    () => fullAggregate ? snapshots.filter((snapshot) => isSnapshotInScope(snapshot, fullAggregate.scope)) : snapshots,
    [fullAggregate, snapshots],
  );
  const latestBySource = useMemo(() => selectLatestSnapshotPerSource(scopedSnapshots), [scopedSnapshots]);
  const selectedSource = latestBySource.find((snapshot) => snapshot.source.canonicalKey === selectedSourceKey);
  const sourceHistory = selectedSourceKey === "aggregate"
    ? []
    : scopedSnapshots.filter((snapshot) => snapshot.source.canonicalKey === selectedSourceKey);
  const selected = selectedSourceKey === "aggregate"
    ? aggregate?.snapshot
    : scopedSnapshots.find((snapshot) => snapshot.id === selectedId && snapshot.source.canonicalKey === selectedSourceKey) ?? selectedSource;
  const displayEntries: DisplayRankingEntry[] = selectedSourceKey === "aggregate"
    ? aggregate?.entries ?? []
    : selected?.entries ?? [];
  const positionRanks = useMemo(
    () => derivePositionRanks(displayEntries, (entry) => entry.id, (entry) => entry.position),
    [displayEntries],
  );
  const selectedPositionScope = selected?.positionScope ?? (() => {
    const entryPositions = [...new Set(displayEntries.map((entry) => entry.position).filter(Boolean))];
    return entryPositions.length === 1 ? entryPositions[0] : "ALL";
  })();
  const availablePositions = useMemo(() => {
    const found = new Set(displayEntries.map((entry) => entry.position).filter((value): value is string => Boolean(value)));
    const preferredOrder = ["QB", "RB", "WR", "TE", "K", "DST"];
    return [...found].sort((left, right) => {
      const leftIndex = preferredOrder.indexOf(left);
      const rightIndex = preferredOrder.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  }, [displayEntries]);
  const matchingEntries = useMemo(() => {
    const normalizedFilter = normalizePlayerName(playerNameFilter);
    return displayEntries.filter((entry) =>
      (listPosition === "ALL" || entry.position === listPosition)
      && (!normalizedFilter || normalizePlayerName(entry.playerName).includes(normalizedFilter)));
  }, [displayEntries, listPosition, playerNameFilter]);
  const visibleEntries = displayCount === "ALL"
    ? matchingEntries
    : matchingEntries.slice(0, Number(displayCount));
  const discoverySnapshot = useMemo(
    () => scopedSnapshots
      .filter((snapshot) => snapshot.discoverNewSources)
      .sort((left, right) => {
        const leftSavedAt = left.savedAt ?? left.createdAt ?? left.generatedAt;
        const rightSavedAt = right.savedAt ?? right.createdAt ?? right.generatedAt;
        return Date.parse(rightSavedAt) - Date.parse(leftSavedAt)
          || rightSavedAt.localeCompare(leftSavedAt)
          || right.id.localeCompare(left.id);
      })[0],
    [scopedSnapshots],
  );
  const discoveryRunSnapshots = discoverySnapshot?.researchJobId
    ? scopedSnapshots.filter((snapshot) => snapshot.researchJobId === discoverySnapshot.researchJobId)
    : discoverySnapshot ? [discoverySnapshot] : [];
  const newPublisherCount = discoveryRunSnapshots.find((snapshot) => typeof snapshot.newPublisherCount === "number")?.newPublisherCount ?? 0;
  const isLatestRunDiscovery = (snapshot: AgentRankingSnapshot) => Boolean(
    discoverySnapshot?.researchJobId
    && snapshot.researchJobId === discoverySnapshot.researchJobId
    && snapshot.isNewDiscovery,
  );
  const aggregateSourceKeys = useMemo(
    () => new Set(fullAggregate?.sourceSnapshots.map((snapshot) => snapshot.source.canonicalKey) ?? []),
    [fullAggregate],
  );
  const includedSourceCount = aggregate?.sourceSnapshots.length ?? 0;
  const totalSourceCount = fullAggregate?.sourceSnapshots.length ?? 0;
  const aggregateHasNoIncludedSources = selectedSourceKey === "aggregate" && totalSourceCount > 0 && includedSourceCount === 0;

  useEffect(() => {
    setSelectedId(null);
  }, [snapshots[0]?.id]);

  useEffect(() => {
    if (selectedSourceKey !== "aggregate" && !latestBySource.some((snapshot) => snapshot.source.canonicalKey === selectedSourceKey)) {
      setSelectedSourceKey("aggregate");
      setSelectedId(null);
    }
  }, [latestBySource, selectedSourceKey]);

  useEffect(() => {
    if (listPosition !== "ALL" && !availablePositions.includes(listPosition)) setListPosition("ALL");
  }, [availablePositions, listPosition]);

  function selectSource(snapshot: AgentRankingSnapshot) {
    setSelectedSourceKey(snapshot.source.canonicalKey);
    setSelectedId(snapshot.id);
  }

  function selectSourceKey(sourceKey: string) {
    if (sourceKey === "aggregate") {
      setSelectedSourceKey("aggregate");
      setSelectedId(null);
      return;
    }
    const snapshot = latestBySource.find((item) => item.source.canonicalKey === sourceKey);
    if (snapshot) selectSource(snapshot);
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
          <span>{snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"} · {leagueSize} teams</span>
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
          <p>No {leagueSize}-team snapshots yet. Completed ranking research will appear here without changing your board.</p>
          <NavLink className="button button--secondary" to="/research">Open Research Desk</NavLink>
        </div>
      )}

      {selected && (
        <>
          <div className="agent-source-toolbar">
            <label>
              <span>Ranking source</span>
              <select value={selectedSourceKey} onChange={(event) => selectSourceKey(event.target.value)}>
                {aggregate && <option value="aggregate">Aggregate · {includedSourceCount}/{totalSourceCount} source{totalSourceCount === 1 ? "" : "s"}</option>}
                {[...latestBySource]
                  .sort((left, right) => left.source.name.localeCompare(right.source.name))
                  .map((snapshot) => (
                    <option key={snapshot.source.canonicalKey} value={snapshot.source.canonicalKey}>{snapshot.source.name}{isLatestRunDiscovery(snapshot) ? " · New source" : ""}</option>
                  ))}
              </select>
            </label>
            <div className="agent-source-toolbar__context">
              <small>Select a source name to view it. The circle controls aggregate membership; the star saves a favorite.</small>
              {discoverySnapshot && (
                <span className="ranking-discovery-count"><Telescope size={11} /> Latest scout: {newPublisherCount ? `${newPublisherCount} new ${newPublisherCount === 1 ? "publisher" : "publishers"}` : "no new publishers"}</span>
              )}
            </div>
          </div>
          <div className="agent-source-strip" aria-label="Ranking sources">
            {aggregate && (
              <button
                className={`aggregate-source-chip${selectedSourceKey === "aggregate" ? " is-active" : ""}`}
                type="button"
                aria-pressed={selectedSourceKey === "aggregate"}
                onClick={() => { setSelectedSourceKey("aggregate"); setSelectedId(null); }}
              >
                <Sparkles size={12} /> Aggregate {includedSourceCount}/{totalSourceCount}
              </button>
            )}
            {[...latestBySource]
              .sort((left, right) => Number(favoriteSourceKeys.includes(right.source.canonicalKey)) - Number(favoriteSourceKeys.includes(left.source.canonicalKey)))
              .map((snapshot) => {
                const favorite = favoriteSourceKeys.includes(snapshot.source.canonicalKey);
                const active = snapshot.source.canonicalKey === selectedSourceKey;
                const aggregateEligible = aggregateSourceKeys.has(snapshot.source.canonicalKey);
                const includedInAggregate = aggregateEligible && !excludedAggregateSourceKeys.includes(snapshot.source.canonicalKey);
                return (
                  <div className={`source-chip${active ? " is-active" : ""}`} key={snapshot.source.canonicalKey}>
                    <button type="button" aria-pressed={active} onClick={() => selectSource(snapshot)}>
                      {snapshot.source.name}
                      {isLatestRunDiscovery(snapshot) && <span className="ranking-new-source-badge">New source</span>}
                      {!aggregateEligible && <span className="ranking-individual-only-badge">Individual only</span>}
                    </button>
                    {aggregateEligible && (
                      <button
                        className={`source-chip__aggregate-toggle${includedInAggregate ? " is-included" : ""}`}
                        type="button"
                        aria-label={`${includedInAggregate ? "Remove" : "Include"} ${snapshot.source.name} ${includedInAggregate ? "from" : "in"} aggregate`}
                        aria-pressed={includedInAggregate}
                        title={includedInAggregate ? "Included in aggregate" : "Excluded from aggregate"}
                        onClick={() => onToggleAggregateSource(snapshot.source.canonicalKey)}
                      >
                        {includedInAggregate ? <CircleMinus size={12} /> : <CirclePlus size={12} />}
                      </button>
                    )}
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
              <span>{selectedSourceKey === "aggregate" ? `${includedSourceCount} of ${totalSourceCount} latest compatible source${totalSourceCount === 1 ? "" : "s"} included` : `${selected.source.name} · ${(selected.source.kind ?? "agent").toUpperCase()} ${selected.source.provider ? `via ${selected.source.provider}` : ""}`}</span>
              <code title="Stable source key">{selectedSourceKey === "aggregate" ? "Unweighted arithmetic mean" : `Source key · ${selected.source.canonicalKey}`}</code>
              {selectedSourceKey !== "aggregate" && (selected.sourceUrl || selected.source.attributionUrl) && <a className="snapshot-source-link" href={selected.sourceUrl ?? selected.source.attributionUrl ?? undefined} target="_blank" rel="noreferrer">View original source <ExternalLink size={10} /></a>}
            </div>
            <div className="snapshot-scope">
              <span><Clock3 size={13} /> {relativeTime(selected.generatedAt)}</span>
              <span>{normalizeLeagueSize(selected.leagueSize)} teams · {selected.scoringFormat.toUpperCase()} · {selected.rankingType.replaceAll("_", " ")} · {selected.season}</span>
            </div>
          </div>
          {selected.summary && !aggregateHasNoIncludedSources && <p className="snapshot-summary">{selected.summary}</p>}
          {aggregateHasNoIncludedSources ? (
            <div className="aggregate-sources-empty" role="status">
              <Sparkles size={20} />
              <h3>No sources are included in this aggregate</h3>
              <p>Individual source boards are still available. Include a source below or restore every compatible source.</p>
              <div>
                <button type="button" onClick={() => onRestoreAggregateSources([...aggregateSourceKeys])}>Restore all sources</button>
                {fullAggregate?.sourceSnapshots.map((snapshot) => (
                  <button key={snapshot.source.canonicalKey} type="button" onClick={() => onToggleAggregateSource(snapshot.source.canonicalKey)}>
                    <CirclePlus size={11} /> Include {snapshot.source.name}
                  </button>
                ))}
              </div>
            </div>
          ) : <>
          <div className="agent-list-controls" aria-label="Agent ranking list controls">
            <label>
              <span>Position</span>
              <select value={listPosition} onChange={(event) => setListPosition(event.target.value)}>
                <option value="ALL">All positions</option>
                {availablePositions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="agent-player-filter">
              <span>Player name</span>
              <span className="agent-player-filter__input"><Search size={13} aria-hidden="true" /><input value={playerNameFilter} onChange={(event) => setPlayerNameFilter(event.target.value)} placeholder="Find a player" type="search" /></span>
            </label>
            <label>
              <span>Show</span>
              <select value={displayCount} onChange={(event) => setDisplayCount(event.target.value)}>
                {[10, 25, 50, 100, 200, 500].map((value) => <option key={value} value={String(value)}>{value} players</option>)}
                <option value="ALL">All players</option>
              </select>
            </label>
            <p aria-live="polite">Showing <strong>{visibleEntries.length}</strong> of <strong>{matchingEntries.length}</strong> matching player{matchingEntries.length === 1 ? "" : "s"}</p>
          </div>
          <div className="agent-ranking-list-heading" aria-hidden="true"><span>OVR / POS</span><span>Player</span><span>Source context</span><span>Move</span></div>
          <ol className="agent-ranking-list" aria-label="Displayed agent rankings">
            {visibleEntries.map((entry) => (
              <AgentRankingRow
                entry={entry}
                hasOwnerToken={hasOwnerToken}
                hasOverallRank={selectedPositionScope === "ALL"}
                key={entry.id}
                positionRank={positionRanks.get(entry.id)}
                researchJob={researchByPlayer.get(normalizePlayerName(entry.playerName))}
                snapshot={selected}
              />
            ))}
          </ol>
          {matchingEntries.length === 0 && (
            <div className="agent-list-empty">
              <Search size={18} />
              <p>No players match this position and name filter.</p>
              <button type="button" onClick={() => { setListPosition("ALL"); setPlayerNameFilter(""); }}>Clear filters</button>
            </div>
          )}
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
          </>}
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
  const initialSavedRankings = useRef<RankingPlayer[] | null>(
    typeof window === "undefined" ? null : loadSavedPersonalRankings(window.localStorage),
  );
  const [rankings, setRankings] = useState<RankingPlayer[]>(() => initialSavedRankings.current ?? starterRankings);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<(typeof positions)[number]>("ALL");
  const [announcement, setAnnouncement] = useState("");
  const [leagueSize, setLeagueSize] = useState<LeagueSize>(() =>
    typeof window === "undefined" ? DEFAULT_LEAGUE_SIZE : loadLeagueSize(window.localStorage));
  const [snapshots, setSnapshots] = useState<AgentRankingSnapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [playerCatalog, setPlayerCatalog] = useState<CanonicalFantasyPlayer[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalogHydrated, setCatalogHydrated] = useState(false);
  const [researchJobs, setResearchJobs] = useState<ResearchJob[]>([]);
  const ownerToken = typeof window === "undefined" ? "" : window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)?.trim() ?? "";
  const [pendingCopy, setPendingCopy] = useState<{ snapshot: AgentRankingSnapshot; position: string } | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [cloudBoard, setCloudBoard] = useState<CloudPersonalRankingBoard | null>(null);
  const [cloudBoardLoaded, setCloudBoardLoaded] = useState(!ownerToken);
  const [cloudBoardError, setCloudBoardError] = useState<string | null>(null);
  const [cloudSaving, setCloudSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [pendingRankMove, setPendingRankMove] = useState<{ playerId: string; rank: string } | null>(null);
  const [preferences, setPreferences] = useState<RankingsPreferences>(() =>
    typeof window === "undefined" ? loadRankingsPreferences({ getItem: () => null }) : loadRankingsPreferences(window.localStorage));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const confirmationRef = useRef<HTMLDivElement>(null);
  const copyTriggerRef = useRef<HTMLElement | null>(null);
  const rankMoveTriggerRef = useRef<HTMLElement | null>(null);
  const rankMoveInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!catalogHydrated) return;
    savePersonalRankings(window.localStorage, rankings);
    setSavedAt(new Date());
  }, [catalogHydrated, rankings]);

  useEffect(() => {
    saveRankingsPreferences(window.localStorage, preferences);
  }, [preferences]);

  useEffect(() => {
    if (pendingCopy) confirmationRef.current?.focus();
  }, [pendingCopy]);

  useEffect(() => {
    if (pendingRankMove) rankMoveInputRef.current?.focus();
  }, [pendingRankMove]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    void fetchFantasyPlayerCatalog(controller.signal)
      .then((players) => {
        if (players.length === 0) throw new Error("Player catalog is empty. Sync the Sleeper player catalog and try again.");
        setPlayerCatalog(players);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogError(error instanceof Error ? error.message : "Unknown player catalog error");
      })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [catalogReload]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshots([]);
    void loadAgentSnapshots(controller.signal);
    return () => controller.abort();
  }, [leagueSize]);

  useEffect(() => {
    if (!ownerToken) return;
    const controller = new AbortController();
    void fetchResearchJobs(ownerToken, controller.signal, 100)
      .then(setResearchJobs)
      .catch(() => setResearchJobs([]));
    return () => controller.abort();
  }, [ownerToken]);

  useEffect(() => {
    if (!ownerToken) {
      setCloudBoard(null);
      setCloudBoardLoaded(true);
      setCloudBoardError(null);
      return;
    }
    const controller = new AbortController();
    setCloudBoardLoaded(false);
    setCloudBoardError(null);
    void fetchCloudPersonalRankings(ownerToken, String(new Date().getUTCFullYear()), controller.signal)
      .then(setCloudBoard)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCloudBoardError(error instanceof Error ? error.message : "Could not load your cloud rankings.");
      })
      .finally(() => { if (!controller.signal.aborted) setCloudBoardLoaded(true); });
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

  const currentAggregateEntries = useMemo(
    () => aggregateRankingSnapshots(snapshots, preferences.excludedAggregateSourceKeys)?.entries ?? [],
    [preferences.excludedAggregateSourceKeys, snapshots],
  );

  useEffect(() => {
    if (catalogLoading || snapshotsLoading || !cloudBoardLoaded || catalogError || playerCatalog.length === 0) return;
    setRankings((current) => hydratePersonalRankings(
      catalogHydrated ? current : cloudBoard?.entries ?? initialSavedRankings.current,
      playerCatalog,
      currentAggregateEntries,
    ));
    setCatalogHydrated(true);
  }, [catalogError, catalogHydrated, catalogLoading, cloudBoard, cloudBoardLoaded, currentAggregateEntries, playerCatalog, snapshotsLoading]);

  async function loadAgentSnapshots(signal?: AbortSignal) {
    setSnapshotsLoading(true);
    setSnapshotError(null);
    try {
      const nextSnapshots = await fetchAgentRankings(signal, leagueSize);
      setSnapshots(nextSnapshots.filter((snapshot) => normalizeLeagueSize(snapshot.leagueSize) === leagueSize));
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
  const personalPositionRanks = useMemo(
    () => derivePositionRanks(rankings, (player) => player.id, (player) => player.position),
    [rankings],
  );
  const overallRankById = useMemo(
    () => new Map(rankings.map((player, index) => [player.id, index + 1])),
    [rankings],
  );
  const biggestReach = useMemo(() => Math.max(
    0,
    ...rankings.flatMap((player, index) => player.consensusRank === null ? [] : [player.consensusRank - index - 1]),
  ), [rankings]);

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

  function requestMoveToRank(playerId: string) {
    const currentRank = rankings.findIndex((player) => player.id === playerId) + 1;
    if (currentRank < 1) return;
    rankMoveTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingRankMove({ playerId, rank: String(currentRank) });
  }

  function cancelMoveToRank() {
    setPendingRankMove(null);
    queueMicrotask(() => rankMoveTriggerRef.current?.focus());
  }

  function confirmMoveToRank() {
    if (!pendingRankMove) return;
    const requestedRank = Number(pendingRankMove.rank);
    if (!Number.isFinite(requestedRank)) return;
    const next = moveRankingTo(rankings, pendingRankMove.playerId, requestedRank);
    announceMove(pendingRankMove.playerId, rankings, next);
    setRankings(next);
    setPendingRankMove(null);
    queueMicrotask(() => rankMoveTriggerRef.current?.focus());
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

  async function saveBoard() {
    savePersonalRankings(window.localStorage, rankings);
    setSavedAt(new Date());
    if (!ownerToken) {
      setAnnouncement("Saved your personal rankings on this device. Add owner access in Research Desk to sync them across devices.");
      return;
    }
    setCloudSaving(true);
    setCloudBoardError(null);
    try {
      const result = await saveCloudPersonalRankings(ownerToken, rankings.map((player) => player.id), {
        revision: cloudBoard?.revision,
        season: String(new Date().getUTCFullYear()),
        leagueSize,
      });
      setCloudBoard(result.board);
      setSavedAt(new Date());
      setAnnouncement(result.ignoredPlayerIds.length > 0
        ? `Saved ${result.savedCount} canonical players to your private cloud board; ${result.ignoredPlayerIds.length} custom entries remain saved only on this device.`
        : `Saved ${result.savedCount} players to your private cloud board and this device.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save your cloud rankings.";
      setCloudBoardError(message);
      setAnnouncement(`Saved on this device, but cloud sync failed: ${message}`);
    } finally {
      setCloudSaving(false);
    }
  }

  async function exportWorkbook() {
    setExporting(true);
    setExportStatus(null);
    try {
      const filename = await exportRankingsToExcel({
        rankings,
        snapshots,
        leagueSize,
        favoriteSourceKeys: preferences.favoriteSourceKeys,
        excludedAggregateSourceKeys: preferences.excludedAggregateSourceKeys,
      });
      setExportStatus({ message: `Exported ${filename}`, error: false });
    } catch (error: unknown) {
      setExportStatus({
        message: error instanceof Error ? `Export failed: ${error.message}` : "Export failed. Please try again.",
        error: true,
      });
    } finally {
      setExporting(false);
    }
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

  function toggleSourceInAggregate(sourceKey: string) {
    setPreferences((current) => ({
      ...current,
      excludedAggregateSourceKeys: toggleAggregateSource(current.excludedAggregateSourceKeys, sourceKey),
    }));
  }

  function restoreAggregateSources(sourceKeys: string[]) {
    const currentScopeKeys = new Set(sourceKeys);
    setPreferences((current) => ({
      ...current,
      excludedAggregateSourceKeys: current.excludedAggregateSourceKeys.filter((key) => !currentScopeKeys.has(key)),
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
          <button
            className="reset-board"
            disabled={!catalogHydrated}
            type="button"
            onClick={() => {
              setRankings(resetPersonalRankings(playerCatalog, currentAggregateEntries));
              setAnnouncement(`Reset your board to the current ${currentAggregateEntries.length > 0 ? "aggregate and player catalog" : "player catalog"} baseline`);
            }}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>
        <div className={`catalog-status${catalogError ? " is-error" : ""}`} role="status">
          {catalogLoading ? "Loading the complete NFL fantasy player catalog…" : catalogError ? (
            <><span>{catalogError}</span><button type="button" onClick={() => setCatalogReload((value) => value + 1)}>Try again</button></>
          ) : `Loaded ${playerCatalog.length} active NFL fantasy players into your board.`}
        </div>
        <div className="ranking-column-labels" aria-hidden="true">
          <span>OVR / POS · Player</span><span>Market</span><span>Difference</span><span>Move</span>
        </div>
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} sensors={sensors}>
          <SortableContext items={visibleRankings.map((player) => player.id)} strategy={verticalListSortingStrategy}>
            <ol className="ranking-list">
              {visibleRankings.map((player) => (
                <SortableRankingRow
                  key={player.id}
                  player={player}
                  rank={overallRankById.get(player.id)!}
                  positionRank={personalPositionRanks.get(player.id)!}
                  total={rankings.length}
                  onMove={handleMove}
                  onMoveToRank={requestMoveToRank}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        {visibleRankings.length === 0 && <div className="board-empty"><SlidersHorizontal size={20} /><p>No players match these filters.</p></div>}
        <footer className="board-methodology">Your board combines the canonical NFL fantasy-player catalog with current aggregate ranks when available. Players without aggregate coverage remain clearly marked as unranked. Your ordering is private to this browser until account sync is added.</footer>
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
        excludedAggregateSourceKeys={preferences.excludedAggregateSourceKeys}
        researchByPlayer={researchByPlayer}
        hasOwnerToken={Boolean(ownerToken)}
        onCollapsedChange={(agentCollapsed) => updatePreferences({ agentCollapsed })}
        onRefresh={() => { void loadAgentSnapshots(); }}
        onToggleFavorite={toggleSource}
        onToggleAggregateSource={toggleSourceInAggregate}
        onRestoreAggregateSources={restoreAggregateSources}
        onApply={requestAgentOrder}
        leagueSize={leagueSize}
      />
    </section>
  );

  const personalFirst = preferences.sectionOrder === "personal-first";
  const leftWorkspace = personalFirst ? personalWorkspace : agentWorkspace;
  const rightWorkspace = personalFirst ? agentWorkspace : personalWorkspace;
  const workspaceStyle = {
    "--workspace-leading-size": `${preferences.splitRatio}fr`,
    "--workspace-trailing-size": `${100 - preferences.splitRatio}fr`,
  } as CSSProperties;

  return (
    <div className="page rankings-page">
      <header className="page-header rankings-header">
        <div>
          <h1>Rankings Center</h1>
          <p className="page-header__copy">Build your private board and review agent-found rankings without mixing the two.</p>
        </div>
        <div className="page-header__actions">
          <label className="league-size-control">
            <span>League size</span>
            <select
              aria-label="Rankings league size"
              value={leagueSize}
              onChange={(event) => {
                const next = normalizeLeagueSize(event.target.value);
                setLeagueSize(next);
                saveLeagueSize(window.localStorage, next);
              }}
            >
              {LEAGUE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} teams</option>)}
            </select>
          </label>
          <span className="badge badge--amber">{leagueSize}-team PPR Redraft</span>
          <button className="button button--secondary export-rankings" disabled={exporting} type="button" onClick={() => { void exportWorkbook(); }}>
            <FileSpreadsheet size={14} /> {exporting ? "Exporting…" : "Export Excel"}
          </button>
          <button className="button button--secondary save-board" disabled={cloudSaving} type="button" onClick={() => { void saveBoard(); }}><Check size={14} /> {cloudSaving ? "Saving…" : "Save my rankings"}</button>
          <span className="autosave-state">{savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not saved"}</span>
          {cloudBoardError && <span className="rankings-export-status is-error" role="alert">Cloud sync: {cloudBoardError}</span>}
          {exportStatus && <span className={`rankings-export-status${exportStatus.error ? " is-error" : ""}`} role="status">{exportStatus.message}</span>}
        </div>
      </header>

      <section className="ranking-stats" aria-label="Ranking board summary">
        <div><span>Players ranked</span><strong>{rankings.length}</strong></div>
        <div><span>Your biggest reach</span><strong>{biggestReach} spots</strong></div>
        <div><span>Agent snapshots</span><strong>{snapshots.length}</strong></div>
        <div><span>Board scope</span><strong>{leagueSize}-team · Overall · Draft</strong></div>
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

      <div className={`rankings-workspace rankings-workspace--${preferences.layout}`} style={workspaceStyle}>
        {leftWorkspace}
        {preferences.layout === "split" && (
          <WorkspaceDivider
            leftWorkspaceName={personalFirst ? "My Rankings" : "Agent Rankings"}
            ratio={preferences.splitRatio}
            onRatioChange={(splitRatio) => updatePreferences({ splitRatio })}
          />
        )}
        {rightWorkspace}
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
      {pendingRankMove && (() => {
        const player = rankings.find((item) => item.id === pendingRankMove.playerId);
        const currentRank = overallRankById.get(pendingRankMove.playerId) ?? 0;
        if (!player) return null;
        return (
          <div className="rank-move-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelMoveToRank(); }}>
            <form
              aria-labelledby="move-to-rank-title"
              aria-modal="true"
              className="rank-move-dialog"
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelMoveToRank(); } }}
              onSubmit={(event) => { event.preventDefault(); confirmMoveToRank(); }}
              role="dialog"
            >
              <div className="rank-move-dialog__heading"><Hash size={17} /><div><span>Quick move</span><strong id="move-to-rank-title">Move {player.name}</strong></div></div>
              <p>Currently overall rank {currentRank}. Choose any rank from 1 to {rankings.length}.</p>
              <label htmlFor="exact-rank-input">Move to rank</label>
              <input
                id="exact-rank-input"
                inputMode="numeric"
                max={rankings.length}
                min={1}
                onChange={(event) => setPendingRankMove({ ...pendingRankMove, rank: event.target.value })}
                ref={rankMoveInputRef}
                required
                type="number"
                value={pendingRankMove.rank}
              />
              <div className="rank-move-dialog__actions"><button type="button" onClick={cancelMoveToRank}>Cancel</button><button className="button button--primary" type="submit">Move player</button></div>
            </form>
          </div>
        );
      })()}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
