import {
  createResearchJob,
  type ResearchJob,
} from "../research/research-api";

export const SLEEPER_POSITIONS = ["QB", "RB", "WR", "TE"] as const;

export type SleeperPosition = (typeof SLEEPER_POSITIONS)[number];

export type SleeperSource = {
  publisher: string;
  title: string;
  url: string;
  publishedAt: string | null;
  recommendation: string | null;
  isNewDiscovery?: boolean;
};

export type SleeperCandidate = {
  id: string;
  playerName: string;
  team: string | null;
  position: SleeperPosition;
  sourceCount: number;
  recommendedPickStart: number;
  recommendedPickEnd: number;
  recommendedRoundStart: number;
  recommendedRoundEnd: number;
  summary: string;
  upside: string | null;
  risk: string | null;
  sources: SleeperSource[];
};

export type SleeperReport = {
  id: string;
  researchJobId?: string;
  season: string;
  scoringFormat: string;
  rankingType: string;
  leagueSize: number;
  summary: string;
  generatedAt: string;
  createdAt?: string;
  discoverNewSources?: boolean;
  newPublisherCount?: number;
  positionSummaries?: Record<SleeperPosition, string>;
  positions: Record<SleeperPosition, SleeperCandidate[]>;
};

export async function fetchSleeperReports(signal?: AbortSignal, researchJobId?: string, leagueSize?: number): Promise<SleeperReport[]> {
  const params = new URLSearchParams({ limit: "50" });
  if (researchJobId) params.set("researchJobId", researchJobId);
  if (leagueSize !== undefined) params.set("leagueSize", String(leagueSize));
  const response = await fetch(`/api/sleepers/reports?${params}`, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Sleeper history returned ${response.status}`);
  const payload = await response.json() as { reports?: SleeperReport[] };
  return payload.reports ?? [];
}

export async function fetchLatestSleeperReport(signal?: AbortSignal, leagueSize?: number): Promise<SleeperReport | null> {
  const response = await fetch(`/api/sleepers/latest${leagueSize === undefined ? "" : `?leagueSize=${leagueSize}`}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Sleeper research returned ${response.status}`);
  const payload = await response.json() as { report?: SleeperReport | null } | SleeperReport;
  if ("report" in payload) return payload.report ?? null;
  return payload as SleeperReport;
}

export function requestSleeperResearch(
  token: string,
  leagueSize: number,
  sleepersPerPosition: number,
  discoverNewSources: boolean,
  sourceTarget?: number,
): Promise<ResearchJob> {
  return createResearchJob(token, {
    type: "sleepers_research",
    scoringFormat: "ppr",
    rankingType: "redraft",
    leagueSize,
    sleepersPerPosition,
    discoverNewSources,
    ...(sourceTarget !== undefined ? { sourceTarget } : {}),
  });
}
