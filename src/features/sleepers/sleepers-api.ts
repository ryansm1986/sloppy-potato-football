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
  season: string;
  scoringFormat: string;
  rankingType: string;
  leagueSize: number;
  summary: string;
  generatedAt: string;
  createdAt?: string;
  positionSummaries?: Record<SleeperPosition, string>;
  positions: Record<SleeperPosition, SleeperCandidate[]>;
};

export async function fetchLatestSleeperReport(signal?: AbortSignal): Promise<SleeperReport | null> {
  const response = await fetch("/api/sleepers/latest", {
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
): Promise<ResearchJob> {
  return createResearchJob(token, {
    type: "sleepers_research",
    scoringFormat: "ppr",
    rankingType: "redraft",
    leagueSize,
    sleepersPerPosition,
  });
}
