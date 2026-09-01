import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import app from "../index";
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
    expect(input.positionScope).toBe("ALL");
    const first = await createRankingSnapshot(db, input);
    const retry = await createRankingSnapshot(db, input);
    expect(first.created).toBe(true);
    expect(retry).toEqual({ id: first.id, created: false });

    const snapshots = await getRankingSnapshots(db, 5);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].source.name).toBe("Codex Rank Agent");
    expect(snapshots[0].source.attributionUrl).toBeNull();
    expect(snapshots[0].positionScope).toBe("ALL");
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

  it("returns exact-scope latest snapshots per source without older history", async () => {
    const db = drizzle(env.DB, { schema });
    const suffix = crypto.randomUUID().slice(0, 8);
    const sourceA = {
      canonicalKey: `external:alpha-${suffix}`,
      slug: `alpha-${suffix}`,
      name: `Alpha Expert ${suffix}`,
      kind: "external" as const,
      attributionUrl: "https://alpha.example/football-rankings",
    };
    const sourceB = {
      canonicalKey: `external:beta-${suffix}`,
      slug: `beta-${suffix}`,
      name: `Beta Expert ${suffix}`,
      kind: "external" as const,
      attributionUrl: "https://beta.example/football-rankings",
    };
    const create = async (
      source: typeof sourceA,
      externalRunId: string,
      generatedAt: string,
      positionScope: "ALL" | "RB",
      title: string,
    ) => createRankingSnapshot(db, rankingSnapshotInput.parse({
      ...snapshotInput,
      source,
      externalRunId,
      generatedAt,
      positionScope,
      title,
      season: "2099",
    }));

    const oldAlpha = await create(sourceA, `old-alpha-${suffix}`, "2026-08-20T12:00:00.000Z", "ALL", "Old Alpha board");
    const latestAlpha = await create(sourceA, `latest-alpha-${suffix}`, "2026-08-30T12:00:00.000Z", "ALL", "Latest Alpha board");
    const rbAlpha = await create(sourceA, `rb-alpha-${suffix}`, "2026-09-01T12:00:00.000Z", "RB", "Alpha running backs");
    const latestBeta = await create(sourceB, `latest-beta-${suffix}`, "2026-08-29T12:00:00.000Z", "ALL", "Latest Beta board");
    // A publisher may report an old or timezone-shifted generatedAt. The most
    // recently saved matching board must still win latest-per-source selection.
    const savedLaterAlpha = await create(sourceA, `saved-later-alpha-${suffix}`, "2026-08-01T05:00:00.000Z", "ALL", "Saved later Alpha board");
    await env.DB.prepare("UPDATE ranking_snapshots SET created_at = ? WHERE id = ?")
      .bind(Date.UTC(2100, 0, 1), savedLaterAlpha.id).run();

    const latest = await getRankingSnapshots(db, 100, {
      scoringFormat: "ppr",
      rankingType: "redraft",
      season: "2099",
      week: null,
      position: "ALL",
      latestPerSource: true,
    });
    expect(latest.map((snapshot) => snapshot.id)).toEqual([savedLaterAlpha.id, latestBeta.id]);
    expect(latest.map((snapshot) => snapshot.id)).not.toContain(oldAlpha.id);
    expect(latest.map((snapshot) => snapshot.id)).not.toContain(latestAlpha.id);
    expect(latest.map((snapshot) => snapshot.id)).not.toContain(rbAlpha.id);
    expect(latest[0]).toMatchObject({
      positionScope: "ALL",
      generatedAt: new Date("2026-08-01T05:00:00.000Z"),
      savedAt: new Date(Date.UTC(2100, 0, 1)),
      source: {
        canonicalKey: sourceA.canonicalKey,
        attributionUrl: sourceA.attributionUrl,
      },
    });

    const alphaOnly = await getRankingSnapshots(db, 100, {
      scoringFormat: "ppr",
      rankingType: "redraft",
      season: "2099",
      week: null,
      position: "ALL",
      source: sourceA.canonicalKey,
      latestPerSource: true,
    });
    expect(alphaOnly.map((snapshot) => snapshot.id)).toEqual([savedLaterAlpha.id]);

    const endpoint = await app.request(
      `https://potato.example/api/rankings/snapshots?scoringFormat=ppr&rankingType=redraft&season=2099&week=null&position=ALL&source=${encodeURIComponent(sourceA.canonicalKey)}&latestPerSource=true&limit=100`,
      undefined,
      { DB: env.DB },
    );
    expect(endpoint.status).toBe(200);
    const response = await endpoint.json<{ snapshots: Array<{ id: string; positionScope: string; source: { attributionUrl: string } }> }>();
    expect(response.snapshots).toEqual([
      expect.objectContaining({
        id: savedLaterAlpha.id,
        positionScope: "ALL",
        source: expect.objectContaining({ attributionUrl: sourceA.attributionUrl }),
      }),
    ]);
  });

  it("rejects invalid exact-scope snapshot filters", async () => {
    const response = await app.request(
      "https://potato.example/api/rankings/snapshots?position=FLEX&latestPerSource=sometimes",
      undefined,
      { DB: env.DB },
    );
    expect(response.status).toBe(400);
  });
});
