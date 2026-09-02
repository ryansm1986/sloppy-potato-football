import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import app from "../index";
import * as schema from "../db/schema";
import {
  createResearchSchedule,
  enqueueDueResearchSchedules,
  nextResearchScheduleRun,
} from "./research-schedules";

const bindings = {
  DB: env.DB,
  RESEARCH_OWNER_TOKEN: "owner-secret",
  AGENT_RUNNER_TOKEN: "runner-secret",
};
const db = drizzle(env.DB, { schema });

function request(method: string, body?: unknown, token = "owner-secret") {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function scheduleBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `Weekly rankings ${crypto.randomUUID()}`,
    enabled: true,
    timeZone: "America/Chicago",
    localTime: "08:30",
    daysOfWeek: [1, 4],
    job: {
      type: "rankings_research",
      scoringFormat: "ppr",
      rankingType: "redraft",
      position: "ALL",
      rankingLimit: 300,
      leagueSize: 14,
      discoverNewSources: true,
    },
    ...overrides,
  };
}

describe("research schedules", () => {
  it("exports the cron handler on the same Worker object as Hono fetch", () => {
    expect(app.fetch).toBeTypeOf("function");
    expect(app.scheduled).toBeTypeOf("function");
  });

  it("protects owner CRUD and supports create, read, update, and delete", async () => {
    const unauthorized = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody(), "wrong-token"),
      bindings,
    );
    expect(unauthorized.status).toBe(401);

    const createdResponse = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody()),
      bindings,
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json<{ schedule: {
      id: string; enabled: boolean; nextRunAt: string; job: { leagueSize: number; rankingLimit: number };
    } }>()).schedule;
    expect(created).toMatchObject({ enabled: true, job: { leagueSize: 14, rankingLimit: 300 } });
    expect(Date.parse(created.nextRunAt)).toBeGreaterThan(Date.now());

    const read = await app.request(
      `https://potato.example/api/research/schedules/${created.id}`,
      request("GET"),
      bindings,
    );
    expect(read.status).toBe(200);

    const updatedResponse = await app.request(
      `https://potato.example/api/research/schedules/${created.id}`,
      request("PATCH", { enabled: false, localTime: "10:45", daysOfWeek: [0, 6] }),
      bindings,
    );
    const updated = (await updatedResponse.json<{ schedule: {
      enabled: boolean; localTime: string; daysOfWeek: number[];
    } }>()).schedule;
    expect(updated).toMatchObject({ enabled: false, localTime: "10:45", daysOfWeek: [0, 6] });

    const listed = await app.request(
      "https://potato.example/api/research/schedules",
      request("GET"),
      bindings,
    );
    expect((await listed.json<{ schedules: { id: string }[] }>()).schedules.some((item) => item.id === created.id)).toBe(true);

    const deleted = await app.request(
      `https://potato.example/api/research/schedules/${created.id}`,
      request("DELETE"),
      bindings,
    );
    expect(deleted.status).toBe(204);
    const missing = await app.request(
      `https://potato.example/api/research/schedules/${created.id}`,
      request("GET"),
      bindings,
    );
    expect(missing.status).toBe(404);
  });

  it("accepts supported league sizes and rejects unsafe schedule or job input", async () => {
    for (const leagueSize of [8, 10, 12, 14, 16]) {
      const response = await app.request(
        "https://potato.example/api/research/schedules",
        request("POST", scheduleBody({
          job: { type: "sleepers_research", scoringFormat: "ppr", rankingType: "redraft", leagueSize },
        })),
        bindings,
      );
      expect(response.status).toBe(201);
    }
    const invalidSize = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody({ job: { type: "rankings_research", leagueSize: 11 } })),
      bindings,
    );
    expect(invalidSize.status).toBe(400);
    const invalidMinute = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody({ localTime: "08:17" })),
      bindings,
    );
    expect(invalidMinute.status).toBe(400);
    const invalidZone = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody({ timeZone: "The Moon/Potato" })),
      bindings,
    );
    expect(invalidZone.status).toBe(400);
  });

  it("calculates local schedules across time zones and daylight-saving transitions", () => {
    const dailyNewYork = { timeZone: "America/New_York", localTime: "09:00", daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    expect(new Date(nextResearchScheduleRun(dailyNewYork, Date.parse("2026-01-15T12:00:00Z"))).toISOString())
      .toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(nextResearchScheduleRun(dailyNewYork, Date.parse("2026-07-15T12:00:00Z"))).toISOString())
      .toBe("2026-07-15T13:00:00.000Z");

    const springGap = { timeZone: "America/New_York", localTime: "02:30", daysOfWeek: [0] };
    expect(new Date(nextResearchScheduleRun(springGap, Date.parse("2026-03-08T05:00:00Z"))).toISOString())
      .toBe("2026-03-08T07:00:00.000Z");

    const fallFold = { timeZone: "America/New_York", localTime: "01:30", daysOfWeek: [0] };
    expect(new Date(nextResearchScheduleRun(fallFold, Date.parse("2026-11-01T04:00:00Z"))).toISOString())
      .toBe("2026-11-01T05:30:00.000Z");
  });

  it("enqueues each due occurrence once and leaves work queued while a desktop runner is offline", async () => {
    const now = Date.parse("2026-09-02T15:00:00Z");
    const schedule = await createResearchSchedule(db, scheduleBody({
      timeZone: "UTC", localTime: "15:15", daysOfWeek: [3],
    }) as never, "primary-owner", now);
    const scheduledFor = now - 60_000;
    await env.DB.prepare("UPDATE research_schedules SET next_run_at = ? WHERE id = ?")
      .bind(scheduledFor, schedule.id).run();

    const first = await enqueueDueResearchSchedules(db, now);
    expect(first.enqueued).toBe(1);
    const queued = await env.DB.prepare(
      "SELECT id, status FROM research_jobs WHERE idempotency_key = ?",
    ).bind(`schedule:${schedule.id}:${scheduledFor}`).all<{ id: string; status: string }>();
    expect(queued.results).toHaveLength(1);
    expect(queued.results[0]?.status).toBe("queued");

    // Simulate a cron retry after the enqueue succeeded but before a caller
    // observed the schedule advance. The deterministic key still yields one job.
    await env.DB.prepare("UPDATE research_schedules SET next_run_at = ? WHERE id = ?")
      .bind(scheduledFor, schedule.id).run();
    const retry = await enqueueDueResearchSchedules(db, now);
    expect(retry.enqueued).toBe(0);
    const afterRetry = await env.DB.prepare(
      "SELECT id FROM research_jobs WHERE idempotency_key = ?",
    ).bind(`schedule:${schedule.id}:${scheduledFor}`).all();
    expect(afterRetry.results).toHaveLength(1);
    const runRows = await env.DB.prepare(
      "SELECT job_id FROM research_schedule_runs WHERE schedule_id = ? AND scheduled_for = ? AND run_type = 'scheduled'",
    ).bind(schedule.id, scheduledFor).all();
    expect(runRows.results).toHaveLength(1);
  });

  it("supports owner run-now without changing the next scheduled occurrence", async () => {
    const createdResponse = await app.request(
      "https://potato.example/api/research/schedules",
      request("POST", scheduleBody({
        job: { type: "player_research", subject: "Bijan Robinson", leagueSize: 12 },
      })),
      bindings,
    );
    const created = (await createdResponse.json<{ schedule: { id: string; nextRunAt: string } }>()).schedule;
    const runResponse = await app.request(
      `https://potato.example/api/research/schedules/${created.id}/run`,
      request("POST"),
      bindings,
    );
    expect(runResponse.status).toBe(201);
    const result = await runResponse.json<{ schedule: { nextRunAt: string; lastJobId: string }; job: { id: string; status: string } }>();
    expect(result.job.status).toBe("queued");
    expect(result.schedule.lastJobId).toBe(result.job.id);
    expect(result.schedule.nextRunAt).toBe(created.nextRunAt);
  });
});
