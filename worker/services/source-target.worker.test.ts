import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { defaultResearchSettings, getResearchSettings, researchSettingsInput, saveResearchSettings } from "./agent-settings";
import { claimResearchJob, completeResearchJob, completeResearchJobInput, createResearchJob, createResearchJobInput, heartbeatRunner, retryResearchJob } from "./research-bridge";
import { createResearchSchedule, createResearchScheduleInput, runResearchScheduleNow } from "./research-schedules";
import { safeResearchEventDetails } from "./research-event-details";

const db = () => drizzle(env.DB, { schema });
async function queue(input: Record<string, unknown>, owner = crypto.randomUUID()) {
  return createResearchJob(db(), createResearchJobInput.parse(input), crypto.randomUUID(), owner);
}
async function claim(id: string) {
  const runnerId = `sources-${crypto.randomUUID()}`;
  await heartbeatRunner(db(), { runnerId, provider: "codex", status: "idle", capabilities: [] });
  await env.DB.prepare("UPDATE research_jobs SET priority = 999 WHERE id = ?").bind(id).run();
  const job = await claimResearchJob(db(), runnerId);
  expect(job?.id).toBe(id);
  return { runnerId, job: job! };
}

describe("configurable research source targets", () => {
  it.each([0, 2, 11, 3.5])("rejects invalid source target %s in jobs, playbooks, and schedules", (sourceTarget) => {
    const job = { type: "rankings_research", sourceTarget };
    expect(createResearchJobInput.safeParse(job).success).toBe(false);
    expect(researchSettingsInput.safeParse({ ...defaultResearchSettings, sourceTarget }).success).toBe(false);
    expect(createResearchScheduleInput.safeParse({ name: "Research", timeZone: "UTC", localTime: "08:00", job }).success).toBe(false);
  });

  it("snapshots per-job overrides without changing owner defaults and retains targets on retry", async () => {
    const owner = crypto.randomUUID();
    await saveResearchSettings(db(), { ...defaultResearchSettings, sourceTarget: 7 }, owner);
    const inherited = await queue({ type: "rankings_research" }, owner);
    expect(inherited.job.sourceTarget).toBe(7);
    const overridden = await queue({ type: "rankings_research", sourceTarget: 10 }, owner);
    expect(overridden.job).toMatchObject({ sourceTarget: 10, researchSettings: { sourceTarget: 10 } });
    expect((await getResearchSettings(db(), owner)).sourceTarget).toBe(7);
    await saveResearchSettings(db(), { ...defaultResearchSettings, sourceTarget: 4 }, owner);
    await env.DB.prepare("UPDATE research_jobs SET status = 'failed' WHERE id = ?").bind(overridden.job.id).run();
    const retried = await retryResearchJob(db(), overridden.job.id, owner);
    expect(retried).toMatchObject({ status: "queued", sourceTarget: 10, researchSettings: { sourceTarget: 10 } });
  });

  it.each(["rankings_research", "sleepers_research", "player_research"])("passes %s target through legacy execution context only", async (type) => {
    const created = await queue({ type, subject: "Bijan Robinson", sourceTarget: 8 });
    const { runnerId, job } = await claim(created.job.id);
    const resumed = await claimResearchJob(db(), runnerId);
    for (const assignment of [job, resumed!]) {
      expect(assignment.input).not.toHaveProperty("sourceTarget");
      expect(assignment.input).not.toHaveProperty("researchSettings");
      expect(assignment.executionContext).toContain("Target 8 independent reputable publishers for this research");
      expect(assignment.executionContext.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("keeps named source refreshes single-source even with an override", async () => {
    const created = await queue({ type: "source_refresh", sourceName: "FantasyPros", sourceTarget: 10 });
    expect(created.job.sourceTarget).toBeNull();
    const { job } = await claim(created.job.id);
    expect(job.input).not.toHaveProperty("sourceTarget");
    expect(job.executionContext).toContain("Refresh only the named publisher");
    expect(job.executionContext).not.toMatch(/Target \d+ independent/);
  });

  it("preserves explicit schedule targets and resolves inherited settings at each enqueue", async () => {
    const owner = crypto.randomUUID();
    await saveResearchSettings(db(), { ...defaultResearchSettings, sourceTarget: 5 }, owner);
    const input = { name: "Rankings", timeZone: "UTC", localTime: "08:00", job: { type: "rankings_research" } };
    const inherited = await createResearchSchedule(db(), createResearchScheduleInput.parse(input), owner);
    const explicit = await createResearchSchedule(db(), createResearchScheduleInput.parse({ ...input, job: { ...input.job, sourceTarget: 9 } }), owner);
    await saveResearchSettings(db(), { ...defaultResearchSettings, sourceTarget: 7 }, owner);
    expect((await runResearchScheduleNow(db(), inherited.id, owner)).job.sourceTarget).toBe(7);
    expect((await runResearchScheduleNow(db(), explicit.id, owner)).job.sourceTarget).toBe(9);
    await saveResearchSettings(db(), { ...defaultResearchSettings, sourceTarget: 4 }, owner);
    expect((await runResearchScheduleNow(db(), inherited.id, owner)).job.sourceTarget).toBe(4);
  });

  it("accepts ten independent ranking boards, rejects eleven or duplicated domains, and retains all event IDs", async () => {
    const created = await queue({ type: "rankings_research", position: "RB", sourceTarget: 10, season: "2026" });
    const { runnerId, job } = await claim(created.job.id);
    const rankingSnapshots = Array.from({ length: 11 }, (_, index) => ({
      sourceName: `Source ${index + 1}`, sourceUrl: `https://publisher-${index + 1}.example/rankings`,
      title: `RB board ${index + 1}`, scoringFormat: "ppr", rankingType: "redraft", season: "2026",
      entries: [{ playerName: "Bijan Robinson", position: "RB", team: "ATL", rank: 1 }],
    }));
    const completion = completeResearchJobInput.parse({ runnerId, leaseToken: job.leaseToken, resultId: crypto.randomUUID(),
      result: { summary: "Verified independent publisher boards.", rankingSnapshots } });
    await expect(completeResearchJob(db(), job.id, completion)).rejects.toThrow();
    const ten = rankingSnapshots.slice(0, 10);
    await expect(completeResearchJob(db(), job.id, { ...completion, result: { ...completion.result, rankingSnapshots: [...ten.slice(0, 9), { ...ten[9], sourceUrl: ten[0]!.sourceUrl }] } })).rejects.toThrow();
    const completed = await completeResearchJob(db(), job.id, { ...completion, result: { ...completion.result, rankingSnapshots: ten } });
    expect(completed.rankingSnapshotIds).toHaveLength(10);
    expect(safeResearchEventDetails(JSON.stringify({ rankingSnapshotIds: completed.rankingSnapshotIds })).rankingSnapshotIds).toEqual(completed.rankingSnapshotIds);
  });
});
