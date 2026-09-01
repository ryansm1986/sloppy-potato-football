import { describe, expect, it } from "vitest";
import {
  RANKINGS_PREFERENCES_STORAGE_KEY,
  clampRankingsSplitRatio,
  defaultRankingsPreferences,
  loadRankingsPreferences,
  saveRankingsPreferences,
  toggleFavoriteSource,
} from "./ranking-preferences";

describe("rankings view preferences", () => {
  it("falls back safely for corrupt data", () => {
    expect(loadRankingsPreferences({ getItem: () => "not-json" })).toEqual(defaultRankingsPreferences);
  });

  it("persists layout, section order, collapse, and unique favorite source slugs", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    saveRankingsPreferences(storage, {
      layout: "split",
      sectionOrder: "agent-first",
      splitRatio: 42,
      agentCollapsed: true,
      favoriteSourceKeys: ["agent:codex-rank-agent", "agent:codex-rank-agent"],
    });

    expect(values.has(RANKINGS_PREFERENCES_STORAGE_KEY)).toBe(true);
    expect(loadRankingsPreferences(storage)).toEqual({
      layout: "split",
      sectionOrder: "agent-first",
      splitRatio: 42,
      agentCollapsed: true,
      favoriteSourceKeys: ["agent:codex-rank-agent"],
    });
  });

  it("defaults and clamps persisted split ratios to keep both workspaces usable", () => {
    expect(clampRankingsSplitRatio(Number.NaN)).toBe(65);
    expect(clampRankingsSplitRatio(12)).toBe(30);
    expect(clampRankingsSplitRatio(87)).toBe(70);
    expect(loadRankingsPreferences({
      getItem: () => JSON.stringify({ layout: "split", splitRatio: 99 }),
    }).splitRatio).toBe(70);
  });

  it("toggles favorite sources by stable slug", () => {
    expect(toggleFavoriteSource([], "fantasypros")).toEqual(["fantasypros"]);
    expect(toggleFavoriteSource(["fantasypros"], "fantasypros")).toEqual([]);
  });
});
