export type AgentRankingEntry = {
  id: string;
  playerId: string | null;
  externalPlayerId?: string | null;
  playerName: string;
  position: string | null;
  team: string | null;
  rank: number;
  previousRank: number | null;
  tier: number | null;
  insight: string | null;
  createdAt?: string;
};

export type AgentRankingSnapshot = {
  id: string;
  source: { id: string; canonicalKey: string; name: string; slug: string; kind: "agent" | "import" | "derived" | "external" | "custom"; provider: string | null; attributionUrl?: string | null };
  title: string;
  scoringFormat: string;
  rankingType: string;
  season: string;
  week: number | null;
  positionScope?: string;
  sourceUrl?: string | null;
  generatedAt: string;
  createdAt?: string;
  savedAt?: string;
  summary: string | null;
  methodology: string | null;
  researchJobId?: string | null;
  isNewDiscovery?: boolean;
  discoverNewSources?: boolean;
  newPublisherCount?: number;
  entries: AgentRankingEntry[];
};

export async function fetchAgentRankings(signal?: AbortSignal): Promise<AgentRankingSnapshot[]> {
  const response = await fetch("/api/rankings/snapshots?limit=100", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Ranking snapshots returned ${response.status}`);
  const payload = await response.json() as { snapshots?: AgentRankingSnapshot[] };
  return payload.snapshots ?? [];
}
