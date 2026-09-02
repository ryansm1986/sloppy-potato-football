export type CanonicalFantasyPlayer = {
  id: string;
  sport: string;
  fullName: string;
  searchName: string;
  position: string | null;
  fantasyPositions: string[];
  nflTeam: string | null;
  status: string | null;
  injuryStatus: string | null;
  isTeamDefense: boolean;
  updatedAt?: string | number;
};

type PlayerCatalogPage = {
  players?: CanonicalFantasyPlayer[];
  nextCursor?: string | null;
  pagination?: { hasMore?: boolean; nextCursor?: string | null };
};

export async function fetchFantasyPlayerCatalog(signal?: AbortSignal): Promise<CanonicalFantasyPlayer[]> {
  const players: CanonicalFantasyPlayer[] = [];
  const seenPlayers = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ fantasy: "true", limit: "500" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/players?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`Player catalog returned ${response.status}`);
    const page = await response.json() as PlayerCatalogPage;
    if (!Array.isArray(page.players)) throw new Error("Player catalog returned an invalid response");
    for (const player of page.players) {
      if (!player?.id || !player.fullName || seenPlayers.has(player.id)) continue;
      seenPlayers.add(player.id);
      players.push(player);
    }

    cursor = page.nextCursor ?? page.pagination?.nextCursor ?? null;
    if (cursor && seenCursors.has(cursor)) throw new Error("Player catalog returned a repeated pagination cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return players;
}
