import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import app from "../index";
import * as schema from "../db/schema";
import { createRankingSnapshot, publishRankingSnapshots, rankingSnapshotInput } from "./ranking-snapshots";
import { createResearchJob, createResearchJobInput } from "./research-bridge";
import { persistSleeperReport, publishSleeperReport, sleeperPositions, type SleeperReportInput } from "./sleeper-reports";

const db = () => drizzle(env.DB, { schema });
const get = (path: string) => app.request(`https://potato.example${path}`, undefined, { DB: env.DB });

describe("historical research outputs", () => {
  it("loads every published board for an exact run regardless of the current scope and limit", async () => {
    const jobId = crypto.randomUUID();
    const snapshotIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const snapshot = await createRankingSnapshot(db(), rankingSnapshotInput.parse({
        source: { slug: `history-${jobId}-${index}`, name: `History source ${index}`, kind: "external", attributionUrl: `https://source${index}.example/rankings` },
        title: "Historical rankings", scoringFormat: "ppr", rankingType: "redraft", season: "2025", leagueSize: 10,
        generatedAt: "2025-09-01T12:00:00.000Z", entries: [{ playerName: "Bijan Robinson", rank: 1, position: "RB" }],
      }), { researchJobId: jobId, discoverNewSources: false, isNewDiscovery: false, newPublisherCount: 0 });
      snapshotIds.push(snapshot.id);
    }
    const pending = await get(`/api/rankings/snapshots?researchJobId=${jobId}`);
    expect(await pending.json()).toEqual({ snapshots: [] });
    await publishRankingSnapshots(db(), jobId);
    const response = await get(`/api/rankings/snapshots?researchJobId=${jobId}&season=2026&leagueSize=12&position=QB&limit=1&latestPerSource=true`);
    expect(response.status).toBe(200);
    const body = await response.json<{ snapshots: Array<{ id: string; researchJobId: string; entries: unknown[]; sourceUrl: string }> }>();
    expect(body.snapshots.map((snapshot) => snapshot.id).sort()).toEqual(snapshotIds.sort());
    expect(body.snapshots.every((snapshot) => snapshot.researchJobId === jobId && snapshot.entries.length === 1 && snapshot.sourceUrl.startsWith("https://"))).toBe(true);
    expect((await get("/api/rankings/snapshots?researchJobId=not-an-id")).status).toBe(400);
  });

  it("keeps published sleeper runs separate, includes full source links, and supports league history plus exact runs", async () => {
    const saved: Array<{ jobId: string; reportId: string; leagueSize: number }> = [];
    for (const [index, leagueSize] of [10, 12, 12].entries()) {
      const job = await createResearchJob(db(), createResearchJobInput.parse({ type: "sleepers_research", leagueSize }), crypto.randomUUID());
      const report: SleeperReportInput = {
        summary: `Report ${index}`, positionSummaries: { QB: "QB context", RB: "RB context", WR: "WR context", TE: "TE context" },
        candidates: sleeperPositions.map((position) => ({
          playerName: `${position} Candidate ${index}`, position, team: null,
          recommendedPickStart: 100, recommendedPickEnd: 110, summary: "An evidence-backed value", upside: null, risk: null,
          sources: [{ publisher: `Example ${position}`, title: `Run ${index} evidence`, url: `https://${position === "QB" ? "example.com" : `${position.toLowerCase()}-example.com`}/run-${index}/${position}`, publishedAt: null, recommendation: "Late-round value" }],
        })),
      };
      const reportId = await persistSleeperReport(db(), {
        jobId: job.job.id, leagueSize, season: "2026", scoringFormat: "ppr", rankingType: "redraft", sleepersPerPosition: 1,
        discoverNewSources: false, knownSourceDomains: [], generatedAt: new Date().toISOString(), report,
      });
      if (index !== 2) await publishSleeperReport(db(), reportId);
      saved.push({ jobId: job.job.id, reportId, leagueSize });
    }
    const history = await get("/api/sleepers/reports?limit=50&leagueSize=12");
    const historyBody = await history.json<{ reports: Array<{ id: string; researchJobId: string }> }>();
    expect(historyBody.reports.map((report) => report.id)).toEqual([saved[1].reportId]);
    const exact = await get(`/api/sleepers/reports?researchJobId=${saved[0].jobId}&leagueSize=12`);
    const exactBody = await exact.json<{ reports: Array<{ id: string; researchJobId: string; leagueSize: number; positions: Record<string, Array<{ playerName: string; recommendedRoundStart: number; sources: Array<{ url: string }> }>> }> }>();
    expect(exactBody.reports).toHaveLength(1);
    expect(exactBody.reports[0]).toMatchObject({ id: saved[0].reportId, researchJobId: saved[0].jobId, leagueSize: 10 });
    expect(exactBody.reports[0].positions.QB[0]).toMatchObject({ playerName: "QB Candidate 0", recommendedRoundStart: 10, sources: [{ url: "https://example.com/run-0/QB" }] });
    const latest = await get("/api/sleepers/latest?leagueSize=10");
    expect(await latest.json()).toMatchObject({ report: { id: saved[0].reportId } });
    const unpublished = await get(`/api/sleepers/reports?researchJobId=${saved[2].jobId}`);
    expect(await unpublished.json()).toEqual({ reports: [] });
    expect((await get("/api/sleepers/reports?leagueSize=11")).status).toBe(400);
  });
});
