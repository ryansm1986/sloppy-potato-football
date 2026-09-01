export type RankingPlayer = {
  id: string;
  name: string;
  position: string;
  team: string;
  consensusRank: number;
  trend: number;
};

export const starterRankings: RankingPlayer[] = [
  { id: "bijan-robinson", name: "Bijan Robinson", position: "RB", team: "ATL", consensusRank: 1, trend: 0 },
  { id: "jamar-chase", name: "Ja'Marr Chase", position: "WR", team: "CIN", consensusRank: 2, trend: 1 },
  { id: "justin-jefferson", name: "Justin Jefferson", position: "WR", team: "MIN", consensusRank: 3, trend: 0 },
  { id: "jahmyr-gibbs", name: "Jahmyr Gibbs", position: "RB", team: "DET", consensusRank: 4, trend: 2 },
  { id: "saquon-barkley", name: "Saquon Barkley", position: "RB", team: "PHI", consensusRank: 5, trend: -1 },
  { id: "ceedee-lamb", name: "CeeDee Lamb", position: "WR", team: "DAL", consensusRank: 6, trend: -2 },
  { id: "amon-ra-st-brown", name: "Amon-Ra St. Brown", position: "WR", team: "DET", consensusRank: 7, trend: 1 },
  { id: "puka-nacua", name: "Puka Nacua", position: "WR", team: "LAR", consensusRank: 8, trend: 3 },
  { id: "malik-nabers", name: "Malik Nabers", position: "WR", team: "NYG", consensusRank: 9, trend: 4 },
  { id: "breece-hall", name: "Breece Hall", position: "RB", team: "NYJ", consensusRank: 10, trend: -2 },
  { id: "josh-allen", name: "Josh Allen", position: "QB", team: "BUF", consensusRank: 11, trend: 0 },
  { id: "brock-bowers", name: "Brock Bowers", position: "TE", team: "LV", consensusRank: 12, trend: 2 },
];

export const PERSONAL_RANKINGS_STORAGE_KEY = "spff:rankings:ppr-redraft:v1";

export function reorderRankings(
  rankings: RankingPlayer[],
  activeId: string,
  overId: string,
): RankingPlayer[] {
  const from = rankings.findIndex((player) => player.id === activeId);
  const to = rankings.findIndex((player) => player.id === overId);
  if (from < 0 || to < 0 || from === to) return rankings;
  const next = [...rankings];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function moveRanking(
  rankings: RankingPlayer[],
  playerId: string,
  direction: "up" | "down",
): RankingPlayer[] {
  const index = rankings.findIndex((player) => player.id === playerId);
  if (index < 0) return rankings;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rankings.length) return rankings;
  return reorderRankings(rankings, playerId, rankings[target].id);
}

export function loadPersonalRankings(storage: Pick<Storage, "getItem">): RankingPlayer[] {
  try {
    const saved = JSON.parse(storage.getItem(PERSONAL_RANKINGS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(saved)) return starterRankings;
    const known = new Map(starterRankings.map((player) => [player.id, player]));
    const ordered = saved.flatMap((value): RankingPlayer[] => {
      if (typeof value === "string") return known.has(value) ? [known.get(value)!] : [];
      if (!isRankingPlayer(value)) return [];
      return [{
        id: value.id,
        name: value.name,
        position: value.position,
        team: value.team,
        consensusRank: value.consensusRank,
        trend: value.trend,
      }];
    }).filter((player, index, values) => values.findIndex((candidate) => candidate.id === player.id) === index);
    const used = new Set(ordered.map((player) => player.id));
    return [...ordered, ...starterRankings.filter((player) => !used.has(player.id))];
  } catch {
    return starterRankings;
  }
}

export function savePersonalRankings(
  storage: Pick<Storage, "setItem">,
  rankings: RankingPlayer[],
): void {
  storage.setItem(PERSONAL_RANKINGS_STORAGE_KEY, JSON.stringify(rankings));
}

function isRankingPlayer(value: unknown): value is RankingPlayer {
  if (!value || typeof value !== "object") return false;
  const player = value as Partial<RankingPlayer>;
  return typeof player.id === "string"
    && typeof player.name === "string"
    && typeof player.position === "string"
    && typeof player.team === "string"
    && typeof player.consensusRank === "number"
    && Number.isFinite(player.consensusRank)
    && typeof player.trend === "number"
    && Number.isFinite(player.trend);
}

export function applyAgentOrder(
  rankings: RankingPlayer[],
  agentEntries: Array<{
    playerId?: string | null;
    playerName: string;
    position?: string | null;
    team?: string | null;
    rank: number;
    previousRank?: number | null;
  }>,
  position = "ALL",
): RankingPlayer[] {
  const eligibleEntries = agentEntries
    .filter((entry) => position === "ALL" || entry.position === position)
    .sort((left, right) => left.rank - right.rank);
  const existingByName = new Map(rankings.map((player) => [player.name.toLowerCase(), player]));
  const copied = eligibleEntries.flatMap((entry) => {
    const existing = existingByName.get(entry.playerName.toLowerCase());
    if (existing) return [existing];
    if (!entry.position) return [];
    return [{
      id: entry.playerId ?? `agent:${entry.playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: entry.playerName,
      position: entry.position,
      team: entry.team ?? "FA",
      consensusRank: entry.rank,
      trend: entry.previousRank === null || entry.previousRank === undefined
        ? 0
        : entry.previousRank - entry.rank,
    }];
  });
  const copiedNames = new Set(copied.map((player) => player.name.toLowerCase()));

  if (position === "ALL") {
    return [...copied, ...rankings.filter((player) => !copiedNames.has(player.name.toLowerCase()))];
  }

  const next = [...rankings];
  const targetIndexes = next.flatMap((player, index) => player.position === position ? [index] : []);
  const remainingAtPosition = rankings.filter((player) =>
    player.position === position && !copiedNames.has(player.name.toLowerCase()));
  const positionOrder = [...copied, ...remainingAtPosition];
  for (const [offset, index] of targetIndexes.entries()) {
    const replacement = positionOrder[offset];
    if (replacement) next[index] = replacement;
  }
  if (positionOrder.length > targetIndexes.length) {
    const insertAt = targetIndexes.length > 0 ? targetIndexes[targetIndexes.length - 1] + 1 : next.length;
    next.splice(insertAt, 0, ...positionOrder.slice(targetIndexes.length));
  }
  return next.filter((player, index, values) => values.findIndex((candidate) => candidate.id === player.id) === index);
}
