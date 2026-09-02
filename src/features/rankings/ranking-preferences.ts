export type RankingsLayout = "split" | "stacked";
export type RankingsSectionOrder = "personal-first" | "agent-first";

export type RankingsPreferences = {
  layout: RankingsLayout;
  sectionOrder: RankingsSectionOrder;
  splitRatio: number;
  agentCollapsed: boolean;
  favoriteSourceKeys: string[];
  excludedAggregateSourceKeys: string[];
};

export const RANKINGS_PREFERENCES_STORAGE_KEY = "spff:rankings:preferences:v1";
export const MIN_RANKINGS_SPLIT_RATIO = 30;
export const MAX_RANKINGS_SPLIT_RATIO = 70;
export const DEFAULT_RANKINGS_SPLIT_RATIO = 65;

export function clampRankingsSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RANKINGS_SPLIT_RATIO;
  return Math.min(MAX_RANKINGS_SPLIT_RATIO, Math.max(MIN_RANKINGS_SPLIT_RATIO, Math.round(value)));
}

export const defaultRankingsPreferences: RankingsPreferences = {
  layout: "stacked",
  sectionOrder: "personal-first",
  splitRatio: DEFAULT_RANKINGS_SPLIT_RATIO,
  agentCollapsed: false,
  favoriteSourceKeys: [],
  excludedAggregateSourceKeys: [],
};

function uniqueSourceKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0))]
    : [];
}

export function loadRankingsPreferences(
  storage: Pick<Storage, "getItem">,
): RankingsPreferences {
  try {
    const saved = JSON.parse(storage.getItem(RANKINGS_PREFERENCES_STORAGE_KEY) ?? "null") as Partial<RankingsPreferences> | null;
    if (!saved || typeof saved !== "object") return defaultRankingsPreferences;
    const legacyFavorites = (saved as Partial<RankingsPreferences> & { favoriteSourceSlugs?: unknown }).favoriteSourceSlugs;
    const favoriteSourceKeys: unknown = saved.favoriteSourceKeys ?? legacyFavorites;
    return {
      layout: saved.layout === "split" ? "split" : "stacked",
      sectionOrder: saved.sectionOrder === "agent-first" ? "agent-first" : "personal-first",
      splitRatio: clampRankingsSplitRatio(typeof saved.splitRatio === "number" ? saved.splitRatio : DEFAULT_RANKINGS_SPLIT_RATIO),
      agentCollapsed: saved.agentCollapsed === true,
      favoriteSourceKeys: uniqueSourceKeys(favoriteSourceKeys),
      excludedAggregateSourceKeys: uniqueSourceKeys(saved.excludedAggregateSourceKeys),
    };
  } catch {
    return defaultRankingsPreferences;
  }
}

export function saveRankingsPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: RankingsPreferences,
): void {
  storage.setItem(RANKINGS_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
}

export function toggleFavoriteSource(
  favorites: string[],
  sourceKey: string,
): string[] {
  return favorites.includes(sourceKey)
    ? favorites.filter((key) => key !== sourceKey)
    : [...favorites, sourceKey];
}

export function toggleAggregateSource(
  excludedSourceKeys: string[],
  sourceKey: string,
): string[] {
  return excludedSourceKeys.includes(sourceKey)
    ? excludedSourceKeys.filter((key) => key !== sourceKey)
    : [...excludedSourceKeys, sourceKey];
}
