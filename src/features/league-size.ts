export const LEAGUE_SIZE_OPTIONS = [8, 10, 12, 14, 16] as const;

export type LeagueSize = (typeof LEAGUE_SIZE_OPTIONS)[number];

export const DEFAULT_LEAGUE_SIZE: LeagueSize = 12;
export const LEAGUE_SIZE_STORAGE_KEY = "spff:league-size:v1";

export function normalizeLeagueSize(value: unknown): LeagueSize {
  const numeric = typeof value === "number" ? value : Number(value);
  return LEAGUE_SIZE_OPTIONS.includes(numeric as LeagueSize)
    ? numeric as LeagueSize
    : DEFAULT_LEAGUE_SIZE;
}

export function loadLeagueSize(storage: Pick<Storage, "getItem">): LeagueSize {
  return normalizeLeagueSize(storage.getItem(LEAGUE_SIZE_STORAGE_KEY));
}

export function saveLeagueSize(storage: Pick<Storage, "setItem">, leagueSize: LeagueSize): void {
  storage.setItem(LEAGUE_SIZE_STORAGE_KEY, String(leagueSize));
}
