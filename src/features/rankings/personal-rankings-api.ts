import { ResearchApiError } from "../research/research-api";
import type { RankingPlayer } from "./ranking-store";

export type CloudPersonalRankingBoard = {
  id: string;
  revision: number;
  name: string;
  season: string;
  updatedAt: string;
  entries: RankingPlayer[];
};

export type SavePersonalRankingBoardResult = {
  board: CloudPersonalRankingBoard;
  savedCount: number;
  ignoredPlayerIds: string[];
};

async function errorFrom(response: Response): Promise<ResearchApiError> {
  let message = `Personal rankings service returned ${response.status}`;
  try {
    const payload = await response.json() as { error?: string; message?: string };
    message = payload.message ?? payload.error ?? message;
  } catch {
    // Preserve the HTTP status fallback for an empty or non-JSON response.
  }
  return new ResearchApiError(message, response.status);
}

function headers(token: string, json = false): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

export async function fetchCloudPersonalRankings(
  token: string,
  season = String(new Date().getUTCFullYear()),
  signal?: AbortSignal,
): Promise<CloudPersonalRankingBoard | null> {
  const query = new URLSearchParams({ season, scoringFormat: "ppr", rankingType: "redraft" });
  const response = await fetch(`/api/research/personal-rankings?${query}`, {
    headers: headers(token),
    signal,
  });
  if (!response.ok) throw await errorFrom(response);
  const payload = await response.json() as { board: CloudPersonalRankingBoard | null };
  return payload.board ?? null;
}

export async function saveCloudPersonalRankings(
  token: string,
  playerIds: string[],
  options: { revision?: number | null; season?: string; leagueSize?: number } = {},
): Promise<SavePersonalRankingBoardResult> {
  const response = await fetch("/api/research/personal-rankings", {
    method: "PUT",
    headers: headers(token, true),
    body: JSON.stringify({
      playerIds,
      expectedRevision: options.revision ?? undefined,
      season: options.season ?? String(new Date().getUTCFullYear()),
      scoringFormat: "ppr",
      rankingType: "redraft",
      leagueSize: options.leagueSize,
    }),
  });
  if (!response.ok) throw await errorFrom(response);
  return response.json() as Promise<SavePersonalRankingBoardResult>;
}
