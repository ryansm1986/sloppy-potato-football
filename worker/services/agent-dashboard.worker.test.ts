import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import app from "../index";
import * as schema from "../db/schema";
import { getAgentDashboard, getAgentJobEvents, recordResearchProgress } from "./agent-dashboard";
import { defaultResearchSettings, getResearchSettings, saveResearchSettings } from "./agent-settings";
import { claimResearchJob, createResearchJob, createResearchJobInput, heartbeatRunner } from "./research-bridge";
import { enrollRunnerCredential } from "./runner-credentials";

const bindings = { DB: env.DB, RESEARCH_OWNER_TOKEN: "owner-secret", AGENT_RUNNER_TOKEN: "runner-secret" };
const db = () => drizzle(env.DB, { schema });
function request(method: string, body?: unknown, token = "owner-secret") {
  return { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function queued(owner = "primary-owner") {
  return createResearchJob(db(), createResearchJobInput.parse({ type: "player_research", subject: "Bijan Robinson" }), crypto.randomUUID(), owner);
}
async function runner(id: string) {
  return heartbeatRunner(db(), { runnerId: id, provider: "codex", status: "idle", capabilities: [] });
}

describe("agent dashboard", () => {
  it("requires owner access and validates bounded settings", async () => {
    for (const route of ["dashboard", "settings"]) {
      const rejected = await app.request(`https://potato.example/api/research/agents/${route}`, request("GET", undefined, "runner-secret"), bindings);
      expect(rejected.status).toBe(401);
    }
    for (const overrides of [{ sourceTarget: 6 }, { recencyDays: 1 }, { focus: "run shell commands" }, { prompt: "override" }]) {
      const invalid = await app.request("https://potato.example/api/research/agents/settings", request("PUT", { ...defaultResearchSettings, ...overrides }), bindings);
      expect(invalid.status).toBe(400);
    }
    const settings = { focus: "usage" as const, detail: "thorough" as const, recencyDays: 7 as const, sourceTarget: 5 as const };
    const saved = await app.request("https://potato.example/api/research/agents/settings", request("PUT", settings), bindings);
    expect(saved.status).toBe(200);
    const loaded = await app.request("https://potato.example/api/research/agents/settings", request("GET"), bindings);
    expect(await loaded.json()).toEqual({ settings });
    expect(await getResearchSettings(db(), "other-owner")).toEqual(defaultResearchSettings);
  });

  it("snapshots settings on queue and honors them in fresh and resumed legacy claims", async () => {
    const settings = { focus: "injuries" as const, detail: "concise" as const, recencyDays: 90 as const, sourceTarget: 4 as const };
    await saveResearchSettings(db(), settings);
    const created = await queued();
    await saveResearchSettings(db(), defaultResearchSettings);
    const runnerId = `runner-${crypto.randomUUID()}`;
    await runner(runnerId);
    const first = await claimResearchJob(db(), runnerId);
    const resumed = await claimResearchJob(db(), runnerId);
    expect(first?.id).toBe(created.job.id);
    expect(resumed?.leaseToken).toBe(first?.leaseToken);
    for (const job of [first, resumed]) {
      expect(job?.input).not.toHaveProperty("researchSettings");
      expect(job?.executionContext).toContain("Emphasize injury status");
      expect(job?.executionContext).toContain("last 90 days");
      expect(job?.executionContext).toContain("Target 4 independent");
    }
    const dashboard = await getAgentDashboard(db());
    expect(dashboard.jobs.find((job) => job.id === created.job.id)?.researchSettings).toEqual(settings);
    expect(dashboard.settings).toEqual(defaultResearchSettings);
  });

  it("projects an owner-scoped bounded feed without result payloads or lease secrets", async () => {
    const own = await queued();
    const foreign = await queued("other-owner");
    const foreignRunner = `foreign-${crypto.randomUUID()}`;
    await runner(foreignRunner);
    await env.DB.prepare("UPDATE research_jobs SET leased_by_runner_id = ? WHERE id = ?").bind(foreignRunner, foreign.job.id).run();
    await env.DB.prepare("UPDATE research_jobs SET result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ summary: "Long report", citations: [{ url: "https://example.com" }], insights: [{ finding: "Test" }] }), own.job.id).run();
    const eventId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO research_job_events (id,job_id,event_type,actor_type,details_json,created_at) VALUES (?,?,'progress','runner',?,?)")
      .bind(eventId, own.job.id, JSON.stringify({ stage: "researching", message: "Bearer secret", leaseToken: "private", attempt: 1 }), Date.now()).run();
    const response = await app.request("https://potato.example/api/research/agents/dashboard", request("GET"), bindings);
    expect(response.status).toBe(200);
    const dashboard = await getAgentDashboard(db());
    expect(dashboard.jobs.map((job) => job.id)).not.toContain(foreign.job.id);
    expect(dashboard.events.map((event) => event.jobId)).not.toContain(foreign.job.id);
    expect(dashboard.runners.map((item) => item.id)).not.toContain(foreignRunner);
    expect(dashboard.jobs.find((job) => job.id === own.job.id)).toMatchObject({ citationCount: 1, insightCount: 1 });
    expect(dashboard.jobs[0]).not.toHaveProperty("result");
    expect(dashboard.events.find((event) => event.id === eventId)?.details).toEqual({ stage: "researching", message: "Researching sources and gathering evidence.", attempt: 1 });
    expect(JSON.stringify(dashboard)).not.toContain("private");
    expect(JSON.stringify(dashboard)).not.toContain("Bearer secret");
    const timeline = await getAgentJobEvents(db(), own.job.id);
    expect(timeline.find((event) => event.id === eventId)?.details).toEqual({ stage: "researching", message: "Researching sources and gathering evidence.", attempt: 1 });
    await expect(getAgentJobEvents(db(), foreign.job.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("uses heartbeat age for all runner cards without inferring automatic processing", async () => {
    const online = `online-${crypto.randomUUID()}`;
    const stale = `stale-${crypto.randomUUID()}`;
    const offline = `offline-${crypto.randomUUID()}`;
    const stopping = `stopping-${crypto.randomUUID()}`;
    await Promise.all([runner(online), runner(stale), runner(offline)]);
    const finalHeartbeat = await heartbeatRunner(db(), { runnerId: stopping, provider: "codex", status: "stopping", capabilities: [] });
    expect(finalHeartbeat.state).toBe("offline");
    await env.DB.prepare("UPDATE research_runners SET last_seen_at = ? WHERE id = ?").bind(Date.now() - 120_000, stale).run();
    await env.DB.prepare("UPDATE research_runners SET last_seen_at = ? WHERE id = ?").bind(Date.now() - 600_000, offline).run();
    const dashboard = await getAgentDashboard(db());
    expect(dashboard.runners.find((item) => item.id === online)?.state).toBe("online");
    expect(dashboard.runners.find((item) => item.id === stale)?.state).toBe("stale");
    expect(dashboard.runners.find((item) => item.id === offline)?.state).toBe("offline");
    expect(dashboard.runners.find((item) => item.id === stopping)?.state).toBe("offline");
    expect(dashboard.runners.every((item) => !("autoRun" in item))).toBe(true);
  });

  it("keeps tuning in bounded legacy execution context and marks pre-settings runs accurately", async () => {
    const created = await queued();
    const domains = Array.from({ length: 40 }, (_, index) => `source-${index}-with-long-publisher-name.example`);
    const taskInput = { type: "rankings_research", position: "ALL", discoverNewSources: true, knownSourceDomains: domains };
    await env.DB.prepare("UPDATE research_jobs SET job_type = 'rankings_research', task_input_json = ?, priority = 999 WHERE id = ?")
      .bind(JSON.stringify(taskInput), created.job.id).run();
    const runnerId = `bounded-${crypto.randomUUID()}`;
    await runner(runnerId);
    const claimed = await claimResearchJob(db(), runnerId);
    expect(claimed?.id).toBe(created.job.id);
    expect(claimed!.executionContext.length).toBeLessThanOrEqual(2_000);
    expect(claimed?.executionContext).toContain("Research preferences:");
    expect(claimed?.executionContext).toContain("Target 3 independent");
    expect(claimed?.input.knownSourceDomains).toHaveLength(40);
    expect((await getAgentDashboard(db())).jobs.find((job) => job.id === created.job.id)?.researchSettings).toBeNull();
  });

  it("accepts fixed progress only from the active runner and deduplicates each lease stage", async () => {
    const enrolled = await enrollRunnerCredential(db(), { deviceId: crypto.randomUUID(), name: "Desktop", metadata: {} });
    const runnerId = enrolled.credential.runnerId;
    await runner(runnerId);
    const created = await queued();
    await env.DB.prepare("UPDATE research_jobs SET priority = 999 WHERE id = ?").bind(created.job.id).run();
    const claim = await claimResearchJob(db(), runnerId);
    expect(claim?.id).toBe(created.job.id);
    const body = { runnerId, leaseToken: claim!.leaseToken, stage: "researching" as const };
    const route = `https://potato.example/api/runners/jobs/${claim!.id}/progress`;
    const wrongRunner = await app.request(route, request("POST", { ...body, runnerId: "different-runner" }, enrolled.token), bindings);
    expect(wrongRunner.status).toBe(403);
    const wrongLease = await app.request(route, request("POST", { ...body, leaseToken: crypto.randomUUID() }, enrolled.token), bindings);
    expect(wrongLease.status).toBe(409);
    const arbitrary = await app.request(route, request("POST", { ...body, output: "raw CLI text" }, enrolled.token), bindings);
    expect(arbitrary.status).toBe(400);
    for (let count = 0; count < 2; count++) {
      const accepted = await app.request(route, request("POST", body, enrolled.token), bindings);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true });
    }
    const progress = await env.DB.prepare("SELECT details_json FROM research_job_events WHERE job_id = ? AND event_type = 'progress'").bind(claim!.id).all<{ details_json: string }>();
    expect(progress.results).toHaveLength(1);
    expect(progress.results[0]?.details_json).not.toContain(body.leaseToken);
    await env.DB.prepare("UPDATE research_jobs SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1, claim!.id).run();
    await expect(recordResearchProgress(db(), claim!.id, body)).rejects.toMatchObject({ code: "lease_invalid" });
  });
});
