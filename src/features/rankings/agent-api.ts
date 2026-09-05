import { apiFetch } from "../auth/auth-api";
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
  source: { id: string; canonicalKey: string; name: string; slug: string; kind: "agent" | "import" | "derived" | "external" | "custom"; provider: string | null; attributionUrl?: string | null; publisherId?: string | null; blocked?: boolean; archived?: boolean; favorite?: boolean; excluded?: boolean };
  title: string;
  scoringFormat: string;
  rankingType: string;
  season: string;
  week: number | null;
  leagueSize?: number;
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

export async function fetchAgentRankings(signal?: AbortSignal, leagueSize?: number, researchJobId?: string): Promise<AgentRankingSnapshot[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (leagueSize !== undefined) params.set("leagueSize", String(leagueSize));
  if (researchJobId) params.set("researchJobId", researchJobId);
  const response = await apiFetch(`/api/rankings/snapshots?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Ranking snapshots returned ${response.status}`);
  const payload = await response.json() as { snapshots?: AgentRankingSnapshot[] };
  return payload.snapshots ?? [];
}
