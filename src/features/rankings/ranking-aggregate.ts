import type { AgentRankingEntry, AgentRankingSnapshot } from "./agent-api";

export type RankingScope = Pick<AgentRankingSnapshot, "scoringFormat" | "rankingType" | "season" | "week"> & {
  positionScope: string;
};

export type AggregateSourceRank = {
  sourceId: string;
  canonicalKey: string;
  sourceName: string;
  attributionUrl: string | null;
  snapshotId: string;
  generatedAt: string;
  rank: number;
  insight: string | null;
};

export type AggregatedRankingEntry = AgentRankingEntry & {
  displayRank: number;
  averageRank: number;
  coverage: number;
  sourceCount: number;
  sourceRanks: AggregateSourceRank[];
};

export type RankingAggregate = {
  mode: "expert" | "all_available";
  usesAllAvailableSources: boolean;
  label: "Expert Aggregate" | "All Available Sources Aggregate";
  scope: RankingScope;
  sourceSnapshots: AgentRankingSnapshot[];
  entries: AggregatedRankingEntry[];
  snapshot: AgentRankingSnapshot;
};

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareNewest(left: AgentRankingSnapshot, right: AgentRankingSnapshot): number {
  const leftSavedAt = left.savedAt ?? left.createdAt ?? left.generatedAt;
  const rightSavedAt = right.savedAt ?? right.createdAt ?? right.generatedAt;
  return timestamp(rightSavedAt) - timestamp(leftSavedAt)
    || rightSavedAt.localeCompare(leftSavedAt)
    || right.id.localeCompare(left.id);
}

export function selectLatestSnapshotPerSource(snapshots: AgentRankingSnapshot[]): AgentRankingSnapshot[] {
  const latest = new Map<string, AgentRankingSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.source.canonicalKey);
    if (!current || compareNewest(snapshot, current) < 0) latest.set(snapshot.source.canonicalKey, snapshot);
  }
  return [...latest.values()].sort(compareNewest);
}

export function rankingScopeOf(snapshot: AgentRankingSnapshot): RankingScope {
  const entryPositions = [...new Set(snapshot.entries.map((entry) => entry.position).filter(Boolean))];
  return {
    scoringFormat: snapshot.scoringFormat,
    rankingType: snapshot.rankingType,
    season: snapshot.season,
    week: snapshot.week,
    positionScope: snapshot.positionScope ?? (entryPositions.length === 1 ? entryPositions[0]! : "ALL"),
  };
}

export function isSnapshotInScope(snapshot: AgentRankingSnapshot, scope: RankingScope): boolean {
  return snapshot.scoringFormat === scope.scoringFormat
    && snapshot.rankingType === scope.rankingType
    && snapshot.season === scope.season
    && snapshot.week === scope.week
    && rankingScopeOf(snapshot).positionScope === scope.positionScope;
}

export function normalizePlayerName(playerName: string): string {
  return playerName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function scopeKey(scope: RankingScope): string {
  return [scope.scoringFormat, scope.rankingType, scope.season, scope.week ?? "season", scope.positionScope].join(":");
}

type MutableAggregate = {
  playerId: string | null;
  playerName: string;
  position: string | null;
  team: string | null;
  sourceRanks: AggregateSourceRank[];
};

export function aggregateRankingSnapshots(
  snapshots: AgentRankingSnapshot[],
  excludedSourceKeys: readonly string[] = [],
): RankingAggregate | null {
  const anchor = [...snapshots].sort(compareNewest)[0];
  if (!anchor) return null;

  const scope = rankingScopeOf(anchor);
  const compatible = selectLatestSnapshotPerSource(snapshots.filter((snapshot) => isSnapshotInScope(snapshot, scope)));
  const external = compatible.filter((snapshot) => snapshot.source.kind === "external");
  const usesAllAvailableSources = external.length < 2;
  const excluded = new Set(excludedSourceKeys);
  const sourceSnapshots = (usesAllAvailableSources ? compatible : external)
    .filter((snapshot) => !excluded.has(snapshot.source.canonicalKey))
    .sort(compareNewest);
  const mode = usesAllAvailableSources ? "all_available" : "expert";
  const label = usesAllAvailableSources ? "All Available Sources Aggregate" : "Expert Aggregate";

  // If one source knows a canonical ID, merge same-named ID-less entries into it.
  const playerIdsByName = new Map<string, string>();
  for (const snapshot of sourceSnapshots) {
    for (const entry of snapshot.entries) {
      if (entry.playerId) playerIdsByName.set(normalizePlayerName(entry.playerName), entry.playerId);
    }
  }

  const players = new Map<string, MutableAggregate>();
  for (const snapshot of sourceSnapshots) {
    const entriesForSource = new Map<string, AgentRankingEntry>();
    for (const entry of snapshot.entries) {
      const normalizedName = normalizePlayerName(entry.playerName);
      const canonicalId = entry.playerId ?? playerIdsByName.get(normalizedName) ?? null;
      const playerKey = canonicalId ? `id:${canonicalId}` : `name:${normalizedName}`;
      const existing = entriesForSource.get(playerKey);
      if (!existing || entry.rank < existing.rank) entriesForSource.set(playerKey, entry);
    }

    for (const [playerKey, entry] of entriesForSource) {
      const existing = players.get(playerKey);
      const aggregate = existing ?? {
        playerId: entry.playerId ?? playerIdsByName.get(normalizePlayerName(entry.playerName)) ?? null,
        playerName: entry.playerName,
        position: entry.position,
        team: entry.team,
        sourceRanks: [],
      };
      if (entry.playerId) {
        aggregate.playerId = entry.playerId;
        aggregate.playerName = entry.playerName;
        aggregate.position = entry.position ?? aggregate.position;
        aggregate.team = entry.team ?? aggregate.team;
      }
      aggregate.position ??= entry.position;
      aggregate.team ??= entry.team;
      aggregate.sourceRanks.push({
        sourceId: snapshot.source.id,
        canonicalKey: snapshot.source.canonicalKey,
        sourceName: snapshot.source.name,
        attributionUrl: snapshot.sourceUrl ?? snapshot.source.attributionUrl ?? null,
        snapshotId: snapshot.id,
        generatedAt: snapshot.generatedAt,
        rank: entry.rank,
        insight: entry.insight,
      });
      players.set(playerKey, aggregate);
    }
  }

  const identity = `${scopeKey(scope)}|${mode}|${sourceSnapshots.map((item) => `${item.source.canonicalKey}:${item.id}`).sort().join("|")}`;
  const entries = [...players.entries()]
    .map(([playerKey, player]) => {
      const averageRank = player.sourceRanks.reduce((sum, source) => sum + source.rank, 0) / player.sourceRanks.length;
      return { playerKey, player, averageRank };
    })
    .sort((left, right) => left.averageRank - right.averageRank
      || right.player.sourceRanks.length - left.player.sourceRanks.length
      || left.player.playerName.localeCompare(right.player.playerName, "en-US"))
    .map(({ playerKey, player, averageRank }, index): AggregatedRankingEntry => {
      const displayRank = index + 1;
      return {
        id: `aggregate-entry-${stableHash(`${identity}|${playerKey}`)}`,
        playerId: player.playerId,
        playerName: player.playerName,
        position: player.position,
        team: player.team,
        rank: displayRank,
        displayRank,
        averageRank,
        coverage: player.sourceRanks.length,
        sourceCount: sourceSnapshots.length,
        previousRank: null,
        tier: null,
        insight: null,
        sourceRanks: [...player.sourceRanks].sort((left, right) => left.rank - right.rank || left.sourceName.localeCompare(right.sourceName, "en-US")),
      };
    });

  const aggregateId = `aggregate-${stableHash(identity)}`;
  const snapshot: AgentRankingSnapshot = {
    id: aggregateId,
    source: {
      id: `aggregate-source-${mode}`,
      canonicalKey: `derived:${mode}-aggregate:${scopeKey(scope)}`,
      name: label,
      slug: `${mode.replace("_", "-")}-aggregate`,
      kind: "derived",
      provider: null,
    },
    title: `${label} — ${scope.scoringFormat.toUpperCase()} ${scope.rankingType.replaceAll("_", " ")}`,
    scoringFormat: scope.scoringFormat,
    rankingType: scope.rankingType,
    season: scope.season,
    week: scope.week,
    positionScope: scope.positionScope,
    generatedAt: anchor.generatedAt,
    summary: `Arithmetic mean of ${sourceSnapshots.length} unique ranking source${sourceSnapshots.length === 1 ? "" : "s"}.`,
    methodology: "Players are ordered by mean rank, then source coverage, then name. Display ranks are contiguous.",
    entries: entries.map(({ displayRank: _displayRank, averageRank: _averageRank, coverage: _coverage, sourceCount: _sourceCount, sourceRanks: _sourceRanks, ...entry }) => entry),
  };

  return { mode, usesAllAvailableSources, label, scope, sourceSnapshots, entries, snapshot };
}
