export type PositionRank = {
  position: string;
  rank: number;
};

/**
 * Index position ranks from the complete board order. Consumers should build
 * this index before applying position, name, or display-limit filters.
 */
export function derivePositionRanks<T>(
  entries: readonly T[],
  getKey: (entry: T) => string,
  getPosition: (entry: T) => string | null | undefined,
): Map<string, PositionRank> {
  const counts = new Map<string, number>();
  const ranks = new Map<string, PositionRank>();

  for (const entry of entries) {
    const position = getPosition(entry)?.trim().toUpperCase();
    if (!position) continue;
    const rank = (counts.get(position) ?? 0) + 1;
    counts.set(position, rank);
    ranks.set(getKey(entry), { position, rank });
  }

  return ranks;
}
