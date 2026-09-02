import { describe, expect, it } from "vitest";
import type { AgentRankingSnapshot } from "./agent-api";
import { aggregateRankingSnapshots, selectLatestSnapshotPerSource } from "./ranking-aggregate";

type SnapshotOverrides = Partial<Omit<AgentRankingSnapshot, "source" | "entries">> & {
  source?: Partial<AgentRankingSnapshot["source"]>;
  entries?: Partial<AgentRankingSnapshot["entries"][number]>[];
};

function makeSnapshot(id: string, overrides: SnapshotOverrides = {}): AgentRankingSnapshot {
  const canonicalKey = overrides.source?.canonicalKey ?? `expert:${id}`;
  return {
    id,
    source: {
      id: overrides.source?.id ?? `source-${id}`,
      canonicalKey,
      name: overrides.source?.name ?? canonicalKey,
      slug: overrides.source?.slug ?? canonicalKey.replaceAll(":", "-"),
      kind: overrides.source?.kind ?? "external",
      provider: overrides.source?.provider ?? null,
    },
    title: overrides.title ?? `${id} rankings`,
    scoringFormat: overrides.scoringFormat ?? "ppr",
    rankingType: overrides.rankingType ?? "redraft",
    season: overrides.season ?? "2026",
    week: overrides.week === undefined ? null : overrides.week,
    positionScope: overrides.positionScope,
    generatedAt: overrides.generatedAt ?? "2026-09-01T12:00:00.000Z",
    createdAt: overrides.createdAt,
    savedAt: overrides.savedAt,
    summary: overrides.summary ?? null,
    methodology: overrides.methodology ?? null,
    entries: (overrides.entries ?? []).map((entry, index) => ({
      id: entry.id ?? `${id}-entry-${index}`,
      playerId: entry.playerId ?? null,
      playerName: entry.playerName ?? `Player ${index}`,
      position: entry.position ?? "WR",
      team: entry.team ?? "TST",
      rank: entry.rank ?? index + 1,
      previousRank: entry.previousRank ?? null,
      tier: entry.tier ?? null,
      insight: entry.insight ?? null,
    })),
  };
}

describe("ranking aggregation", () => {
  it("selects only the latest snapshot for each canonical source key", () => {
    const old = makeSnapshot("old", { source: { canonicalKey: "expert:a" }, generatedAt: "2026-08-01T00:00:00Z" });
    const latest = makeSnapshot("latest", { source: { canonicalKey: "expert:a" }, generatedAt: "2026-09-01T00:00:00Z" });
    const other = makeSnapshot("other", { source: { canonicalKey: "expert:b" }, generatedAt: "2026-08-15T00:00:00Z" });

    expect(selectLatestSnapshotPerSource([old, other, latest]).map((snapshot) => snapshot.id)).toEqual(["latest", "other"]);
  });

  it("prefers the most recently saved revision even when its publisher timestamp is older", () => {
    const quarterback = makeSnapshot("quarterback", {
      source: { canonicalKey: "agent:codex-research" },
      generatedAt: "2026-09-01T17:00:00Z",
      createdAt: "2026-09-01T21:06:58Z",
    });
    const overall = makeSnapshot("overall", {
      source: { canonicalKey: "agent:codex-research" },
      generatedAt: "2026-09-01T05:00:00Z",
      createdAt: "2026-09-01T22:40:26Z",
      positionScope: "ALL",
    });

    expect(selectLatestSnapshotPerSource([quarterback, overall]).map((snapshot) => snapshot.id)).toEqual(["overall"]);
  });

  it("anchors scope to the newest snapshot and excludes incompatible scoring, type, season, and week", () => {
    const anchor = makeSnapshot("anchor", { source: { canonicalKey: "expert:a" }, week: 2, generatedAt: "2026-09-02T00:00:00Z" });
    const compatible = makeSnapshot("compatible", { source: { canonicalKey: "expert:b" }, week: 2, generatedAt: "2026-09-01T00:00:00Z" });
    const wrongScoring = makeSnapshot("scoring", { source: { canonicalKey: "expert:c" }, scoringFormat: "half_ppr", week: 2 });
    const wrongType = makeSnapshot("type", { source: { canonicalKey: "expert:d" }, rankingType: "weekly", week: 2 });
    const wrongSeason = makeSnapshot("season", { source: { canonicalKey: "expert:e" }, season: "2025", week: 2 });
    const wrongWeek = makeSnapshot("week", { source: { canonicalKey: "expert:f" }, week: 1 });

    const result = aggregateRankingSnapshots([wrongScoring, wrongType, wrongSeason, wrongWeek, compatible, anchor]);
    expect(result?.sourceSnapshots.map((snapshot) => snapshot.id)).toEqual(["anchor", "compatible"]);
    expect(result?.scope).toEqual({ scoringFormat: "ppr", rankingType: "redraft", season: "2026", week: 2, positionScope: "ALL" });
  });

  it("keeps a source's compatible overall board when it also has a newer position-only board", () => {
    const sourceAOverall = makeSnapshot("a-overall", {
      source: { canonicalKey: "expert:a" },
      generatedAt: "2026-09-01T12:00:00Z",
      positionScope: "ALL",
    });
    const sourceAQuarterbacks = makeSnapshot("a-qb", {
      source: { canonicalKey: "expert:a" },
      generatedAt: "2026-09-01T13:00:00Z",
      positionScope: "QB",
      entries: [{ playerName: "Quarterback", position: "QB" }],
    });
    const sourceBOverall = makeSnapshot("b-overall", {
      source: { canonicalKey: "expert:b" },
      generatedAt: "2026-09-01T14:00:00Z",
      positionScope: "ALL",
    });

    const result = aggregateRankingSnapshots([sourceAOverall, sourceAQuarterbacks, sourceBOverall]);

    expect(result?.scope.positionScope).toBe("ALL");
    expect(result?.sourceSnapshots.map((snapshot) => snapshot.id)).toEqual(["b-overall", "a-overall"]);
  });

  it("uses external expert sources without double-counting agent syntheses", () => {
    const expertA = makeSnapshot("a", { source: { canonicalKey: "expert:a" }, entries: [{ playerName: "Alpha", rank: 1 }] });
    const expertB = makeSnapshot("b", { source: { canonicalKey: "expert:b" }, entries: [{ playerName: "Alpha", rank: 3 }] });
    const synthesis = makeSnapshot("agent", {
      source: { canonicalKey: "agent:synthesis", kind: "agent" },
      entries: [{ playerName: "Alpha", rank: 100 }],
    });

    const result = aggregateRankingSnapshots([expertA, expertB, synthesis]);
    expect(result?.mode).toBe("expert");
    expect(result?.usesAllAvailableSources).toBe(false);
    expect(result?.sourceSnapshots.map((snapshot) => snapshot.id).sort()).toEqual(["a", "b"]);
    expect(result?.entries[0].averageRank).toBe(2);
  });

  it("falls back to all latest compatible unique sources when fewer than two external experts exist", () => {
    const external = makeSnapshot("external", { source: { canonicalKey: "expert:a" } });
    const agent = makeSnapshot("agent", { source: { canonicalKey: "agent:a", kind: "agent" } });
    const imported = makeSnapshot("import", { source: { canonicalKey: "import:a", kind: "import" } });

    const result = aggregateRankingSnapshots([external, agent, imported]);
    expect(result?.mode).toBe("all_available");
    expect(result?.usesAllAvailableSources).toBe(true);
    expect(result?.label).toBe("All Available Sources Aggregate");
    expect(result?.sourceSnapshots).toHaveLength(3);
  });

  it("orders by mean rank, then greater coverage, then player name", () => {
    const a = makeSnapshot("a", { source: { canonicalKey: "expert:a" }, entries: [
      { playerName: "Zulu", rank: 2 },
      { playerName: "Alpha", rank: 2 },
      { playerName: "Solo", rank: 2 },
    ] });
    const b = makeSnapshot("b", { source: { canonicalKey: "expert:b" }, entries: [
      { playerName: "Zulu", rank: 2 },
      { playerName: "Alpha", rank: 2 },
    ] });

    const result = aggregateRankingSnapshots([a, b]);
    expect(result?.entries.map((entry) => entry.playerName)).toEqual(["Alpha", "Zulu", "Solo"]);
    expect(result?.entries.map((entry) => entry.coverage)).toEqual([2, 2, 1]);
  });

  it("preserves canonical player fields and per-source ranks and insights", () => {
    const a = makeSnapshot("a", { source: { canonicalKey: "expert:a", name: "Expert A" }, entries: [
      { playerId: "player-1", playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, insight: "Elite volume" },
    ] });
    const b = makeSnapshot("b", { source: { canonicalKey: "expert:b", name: "Expert B" }, entries: [
      { playerName: "Ja Marr Chase", position: "WR", team: "CIN", rank: 3, insight: "High ceiling" },
    ] });

    const entry = aggregateRankingSnapshots([a, b])?.entries[0];
    expect(entry).toMatchObject({
      playerId: "player-1",
      playerName: "Ja'Marr Chase",
      position: "WR",
      team: "CIN",
      averageRank: 2,
      coverage: 2,
      sourceCount: 2,
    });
    expect(entry?.sourceRanks).toEqual([
      expect.objectContaining({ sourceName: "Expert A", rank: 1, insight: "Elite volume" }),
      expect.objectContaining({ sourceName: "Expert B", rank: 3, insight: "High ceiling" }),
    ]);
  });

  it("builds a deterministic copyable snapshot with contiguous ranks", () => {
    const a = makeSnapshot("a", { source: { canonicalKey: "expert:a" }, entries: [
      { playerId: "p1", playerName: "Alpha", rank: 1 },
      { playerId: "p2", playerName: "Beta", rank: 8 },
    ] });
    const b = makeSnapshot("b", { source: { canonicalKey: "expert:b" }, entries: [
      { playerId: "p1", playerName: "Alpha", rank: 1 },
      { playerId: "p2", playerName: "Beta", rank: 8 },
    ] });

    const first = aggregateRankingSnapshots([a, b]);
    const second = aggregateRankingSnapshots([b, a]);
    expect(first?.snapshot.id).toBe(second?.snapshot.id);
    expect(first?.snapshot.entries.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(first?.snapshot.entries.map((entry) => entry.id)).toEqual(second?.snapshot.entries.map((entry) => entry.id));
  });
});
