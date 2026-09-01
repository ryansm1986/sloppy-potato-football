import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import {
  createRankingSnapshot,
  getRankingSnapshots,
  rankingSnapshotInput,
} from "./ranking-snapshots";
import { getRankingSourceCatalog } from "./ranking-sources";

const snapshotInput = {
  source: { slug: "codex-rank-agent", name: "Codex Rank Agent", kind: "agent" as const, provider: "codex" },
  externalRunId: "run-2026-09-01-001",
  title: "PPR board refresh",
  scoringFormat: "ppr" as const,
  rankingType: "redraft" as const,
  season: "2026",
  generatedAt: "2026-09-01T18:00:00.000Z",
  summary: "Two first-round players changed after injury and role research.",
  entries: [
    { playerName: "Bijan Robinson", position: "RB", team: "ATL", rank: 1, previousRank: 2, insight: "Receiving role remains elite." },
    { playerName: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 2, previousRank: 1 },
  ],
};

describe("agent ranking snapshots", () => {
  it("persists immutable snapshots and treats runner retries idempotently", async () => {
    const db = drizzle(env.DB, { schema });
    const input = rankingSnapshotInput.parse(snapshotInput);
    const first = await createRankingSnapshot(db, input);
    const retry = await createRankingSnapshot(db, input);
    expect(first.created).toBe(true);
    expect(retry).toEqual({ id: first.id, created: false });

    const snapshots = await getRankingSnapshots(db, 5);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].source.name).toBe("Codex Rank Agent");
    expect(snapshots[0].entries.map((entry) => entry.playerName)).toEqual(["Bijan Robinson", "Ja'Marr Chase"]);
    expect(snapshots[0].entries[0].team).toBe("ATL");
  });

  it("rejects duplicate or non-contiguous ranks", () => {
    const result = rankingSnapshotInput.safeParse({
      ...snapshotInput,
      externalRunId: "bad-run",
      entries: snapshotInput.entries.map((entry) => ({ ...entry, rank: 2 })),
    });
    expect(result.success).toBe(false);
  });

  it("deduplicates source aliases and runner retries by canonical source key", async () => {
    const db = drizzle(env.DB, { schema });
    const firstInput = rankingSnapshotInput.parse({
      ...snapshotInput,
      source: {
        ...snapshotInput.source,
        canonicalKey: "agent:codex-rank-agent",
        aliases: [{ type: "external", value: "codex-cli-rankings" }],
      },
      externalRunId: "alias-retry-run",
    });
    const first = await createRankingSnapshot(db, firstInput);
    const retry = await createRankingSnapshot(db, rankingSnapshotInput.parse({
      ...snapshotInput,
      source: {
        ...snapshotInput.source,
        canonicalKey: "agent:codex-rank-agent",
        slug: "codex-rank-agent-v2",
        name: "Sloppy Potato Rank Agent",
      },
      externalRunId: "alias-retry-run",
    }));

    expect(retry).toEqual({ id: first.id, created: false });
    const sourceCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ranking_sources WHERE canonical_key = ?",
    ).bind("agent:codex-rank-agent").first<{ count: number }>();
    const snapshotCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ranking_snapshots WHERE external_run_id = ?",
    ).bind("alias-retry-run").first<{ count: number }>();
    expect(sourceCount?.count).toBe(1);
    expect(snapshotCount?.count).toBe(1);

    const catalog = await getRankingSourceCatalog(db, { limit: 100 });
    const source = catalog.sources.find((candidate) => candidate.canonicalKey === "agent:codex-rank-agent");
    expect(source?.aliases.map((alias) => alias.value)).toContain("codex-rank-agent-v2");
    expect(source?.snapshotCount).toBeGreaterThanOrEqual(1);
  });
});
