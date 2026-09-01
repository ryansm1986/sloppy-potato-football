import { describe, expect, it } from "vitest";
import {
  RANKINGS_PREFERENCES_STORAGE_KEY,
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
      agentCollapsed: true,
      favoriteSourceKeys: ["agent:codex-rank-agent", "agent:codex-rank-agent"],
    });

    expect(values.has(RANKINGS_PREFERENCES_STORAGE_KEY)).toBe(true);
    expect(loadRankingsPreferences(storage)).toEqual({
      layout: "split",
      sectionOrder: "agent-first",
      agentCollapsed: true,
      favoriteSourceKeys: ["agent:codex-rank-agent"],
    });
  });

  it("toggles favorite sources by stable slug", () => {
    expect(toggleFavoriteSource([], "fantasypros")).toEqual(["fantasypros"]);
    expect(toggleFavoriteSource(["fantasypros"], "fantasypros")).toEqual([]);
  });
});
