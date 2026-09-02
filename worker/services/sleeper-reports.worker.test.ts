import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../index";
import { canonicalSourceDomain } from "./sleeper-reports";

const bindings = {
  DB: env.DB,
  RESEARCH_OWNER_TOKEN: "owner-secret",
  AGENT_RUNNER_TOKEN: "runner-secret",
};

function request(method: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

const source = (publisher: string, url: string) => ({
  publisher,
  title: `${publisher} sleepers`,
  url,
  publishedAt: null,
  recommendation: "Identified this player as a current PPR draft value.",
});

function sleeperReportFixture() {
  const fantasyPros = source("FantasyPros", "https://www.fantasypros.com/nfl/sleepers/one");
  const duplicateFantasyPros = source("FantasyPros duplicate", "https://rankings.fantasypros.com/nfl/sleepers/two");
  const cbs = source("CBS Sports", "https://www.cbssports.com/fantasy/football/news/sleepers/");
  const espn = source("ESPN", "https://www.espn.com/fantasy/football/story/_/id/123/sleepers");
  return {
    summary: "Current PPR values are concentrated in ambiguous backfields and ascending passing roles.",
    positionSummaries: {
      QB: "Later-round passers with rushing or breakout upside lead the quarterback pool.",
      RB: "Backfield contingency value drives the running back list.",
      WR: "Target growth creates the strongest receiver values.",
      TE: "Route participation separates the late tight ends.",
    },
    candidates: [
      {
        playerName: "Quarterback Alpha", position: "QB", team: "BUF",
        recommendedPickStart: 88, recommendedPickEnd: 105,
        summary: "Multiple publishers identify a useful late-quarterback profile.", upside: "Rushing creates a weekly ceiling.", risk: "Passing volume may remain modest.",
        sources: [fantasyPros, duplicateFantasyPros, cbs],
      },
      {
        playerName: "Quarterback Beta", position: "QB", team: "DEN",
        recommendedPickStart: 100, recommendedPickEnd: 112,
        summary: "One current source recommends the price.", upside: null, risk: null, sources: [espn],
      },
      {
        playerName: "Running Back Alpha", position: "RB", team: "ATL",
        recommendedPickStart: 92, recommendedPickEnd: 108,
        summary: "A contingent workload creates upside.", upside: null, risk: null, sources: [espn],
      },
      {
        playerName: "Receiver Alpha", position: "WR", team: "MIN",
        recommendedPickStart: 96, recommendedPickEnd: 114,
        summary: "An expanding route role supports the value case.", upside: null, risk: null, sources: [cbs],
      },
      {
        playerName: "Tight End Alpha", position: "TE", team: "DAL",
        recommendedPickStart: 120, recommendedPickEnd: 138,
        summary: "Late-round routes provide an inexpensive path to targets.", upside: null, risk: null, sources: [fantasyPros],
      },
    ],
  };
}

function completionResult(sleeperReport: ReturnType<typeof sleeperReportFixture>) {
  return {
    summary: sleeperReport.summary,
    generatedAt: "2026-09-01T20:00:00.000Z",
    citations: [],
    insights: [],
    rankingSnapshot: null,
    rankingSnapshots: null,
    sleeperReport,
  };
}

describe("sleeper research reports", () => {
  it("canonicalizes publisher subdomains and common multi-label public suffixes", () => {
    expect(canonicalSourceDomain("https://fantasy.espn.com/football/")).toBe("espn.com");
    expect(canonicalSourceDomain("https://espn.com/football/")).toBe("espn.com");
    expect(canonicalSourceDomain("https://sports.bbc.co.uk/football/")).toBe("bbc.co.uk");
  });

  it("publishes a normalized report, deduplicates domains, ranks by source count, and derives rounds", async () => {
    const suffix = crypto.randomUUID();
    const runnerId = `sleepers-${suffix}`;
    const heartbeat = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", {
        runnerId,
        name: "Sleeper runner",
        provider: "codex",
        status: "idle",
        capabilities: ["sleepers_research"],
      }, "runner-secret"),
      bindings,
    );
    expect(heartbeat.status).toBe(200);

    const create = await app.request(
      "https://potato.example/api/research/jobs",
      request("POST", {
        type: "sleepers_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        season: "2026",
        leagueSize: 12,
        sleepersPerPosition: 2,
      }, "owner-secret", { "Idempotency-Key": `sleepers-${suffix}` }),
      bindings,
    );
    expect(create.status).toBe(201);
    const created = await create.json<{ job: { id: string; leagueSize: number; sleepersPerPosition: number } }>();
    expect(created.job).toMatchObject({ leagueSize: 12, sleepersPerPosition: 2 });

    const claim = await app.request(
      "https://potato.example/api/runners/jobs/claim",
      request("POST", { runnerId }, "runner-secret"),
      bindings,
    );
    const claimed = (await claim.json<{ job: { id: string; leaseToken: string; executionContext: string } }>()).job;
    expect(claimed.id).toBe(created.job.id);
    expect(claimed.executionContext).toContain("12-team league");
    expect(claimed.executionContext).toContain("each of QB, RB, WR, and TE");

    const sleeperReport = sleeperReportFixture();
    const completion = await app.request(
      `https://potato.example/api/runners/jobs/${created.job.id}/result`,
      request("POST", {
        runnerId,
        leaseToken: claimed.leaseToken,
        resultId: `sleepers-result-${suffix}`,
        result: completionResult(sleeperReport),
      }, "runner-secret"),
      bindings,
    );
    expect(completion.status).toBe(200);
    const completed = await completion.json<{ sleeperReportId: string }>();
    expect(completed.sleeperReportId).toBeTruthy();

    // The reading route deliberately needs neither owner nor runner credentials.
    const latest = await app.request("https://potato.example/api/sleepers/latest", request("GET"), { DB: env.DB });
    expect(latest.status).toBe(200);
    const body = await latest.json<{ report: {
      id: string;
      leagueSize: number;
      positionSummaries: Record<string, string>;
      positions: Record<string, Array<{
        playerName: string;
        rank: number;
        sourceCount: number;
        recommendedRoundStart: number;
        recommendedRoundEnd: number;
        sources: Array<{ publisher: string; url: string }>;
      }>>;
    } }>();
    expect(body.report.id).toBe(completed.sleeperReportId);
    expect(body.report.leagueSize).toBe(12);
    expect(body.report.positionSummaries.QB).toContain("quarterback");
    expect(body.report.positions.QB.map((candidate) => candidate.playerName)).toEqual([
      "Quarterback Alpha",
      "Quarterback Beta",
    ]);
    expect(body.report.positions.QB[0]).toMatchObject({
      rank: 1,
      sourceCount: 2,
      recommendedRoundStart: 8,
      recommendedRoundEnd: 9,
    });
    expect(body.report.positions.QB[0]?.sources).toHaveLength(2);
    expect(body.report.positions.QB[0]?.sources.map((item) => item.publisher)).toEqual(["CBS Sports", "FantasyPros"]);

    const storedDomains = await env.DB.prepare(
      `SELECT source_domain FROM sleeper_candidate_sources
       WHERE candidate_id = ? ORDER BY source_domain`,
    ).bind((await env.DB.prepare(
      "SELECT id FROM sleeper_candidates WHERE report_id = ? AND player_name = ?",
    ).bind(completed.sleeperReportId, "Quarterback Alpha").first<{ id: string }>())!.id)
      .all<{ source_domain: string }>();
    expect(storedDomains.results.map((row) => row.source_domain)).toEqual(["cbssports.com", "fantasypros.com"]);

    const laterJobId = crypto.randomUUID();
    const laterReportId = crypto.randomUUID();
    const later = Date.now() + 1_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO research_jobs
         (id, owner_identity, job_type, status, priority, task_input_json, idempotency_key,
          attempt_count, max_attempts, created_at, updated_at)
         VALUES (?, 'primary-owner', 'sleepers_research', 'completed', 0, '{}', ?, 1, 3, ?, ?)`,
      ).bind(laterJobId, `latest-order-${suffix}`, later, later),
      env.DB.prepare(
        `INSERT INTO sleeper_reports
         (id, job_id, season, scoring_format, ranking_type, league_size, summary,
          generated_at, created_at, published_at)
         VALUES (?, ?, '2026', 'ppr', 'redraft', 12, 'Published later.', ?, ?, ?)`,
      ).bind(laterReportId, laterJobId, Date.parse("2000-01-01T00:00:00.000Z"), later, later),
    ]);
    const latestByPublication = await app.request("https://potato.example/api/sleepers/latest", request("GET"), { DB: env.DB });
    expect((await latestByPublication.json<{ report: { id: string } }>()).report.id).toBe(laterReportId);
  });

  it("never publishes after lease loss and repairs publication on an idempotent completion retry", async () => {
    const suffix = crypto.randomUUID();
    const runnerId = `sleeper-race-${suffix}`;
    await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", {
        runnerId,
        name: "Sleeper race runner",
        provider: "codex",
        status: "idle",
        capabilities: ["sleepers_research"],
      }, "runner-secret"),
      bindings,
    );
    const create = await app.request(
      "https://potato.example/api/research/jobs",
      request("POST", {
        type: "sleepers_research",
        scoringFormat: "ppr",
        rankingType: "redraft",
        season: "2026",
        leagueSize: 12,
        sleepersPerPosition: 8,
      }, "owner-secret", { "Idempotency-Key": `sleeper-race-${suffix}` }),
      bindings,
    );
    const jobId = (await create.json<{ job: { id: string } }>()).job.id;
    const claim = await app.request(
      "https://potato.example/api/runners/jobs/claim",
      request("POST", { runnerId }, "runner-secret"),
      bindings,
    );
    const claimed = (await claim.json<{ job: { leaseToken: string } }>()).job;
    const resultId = `sleeper-race-result-${suffix}`;
    const completionBody = {
      runnerId,
      leaseToken: claimed.leaseToken,
      resultId,
      result: completionResult(sleeperReportFixture()),
    };

    // Expire the lease immediately after the hidden report parent is inserted,
    // reproducing a lease race without introducing a production-only test hook.
    const triggerName = `expire_sleeper_${suffix.replace(/-/g, "")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName} AFTER INSERT ON sleeper_reports
       WHEN NEW.job_id = '${jobId}'
       BEGIN
         UPDATE research_jobs SET lease_expires_at = 0 WHERE id = NEW.job_id;
       END`,
    ).run();
    const stale = await app.request(
      `https://potato.example/api/runners/jobs/${jobId}/result`,
      request("POST", completionBody, "runner-secret"),
      bindings,
    );
    await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
    expect(stale.status).toBe(409);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sleeper_reports WHERE job_id = ?",
    ).bind(jobId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare(
      "SELECT status FROM research_jobs WHERE id = ?",
    ).bind(jobId).first<{ status: string }>())?.status).toBe("running");

    // A subsequent valid lease can rebuild and complete the same job.
    await env.DB.prepare("UPDATE research_jobs SET lease_expires_at = ? WHERE id = ?")
      .bind(Date.now() + 15 * 60_000, jobId).run();
    const completed = await app.request(
      `https://potato.example/api/runners/jobs/${jobId}/result`,
      request("POST", completionBody, "runner-secret"),
      bindings,
    );
    expect(completed.status).toBe(200);
    const sleeperReportId = (await completed.json<{ sleeperReportId: string }>()).sleeperReportId;

    // Simulate the narrow failure window after the job transition but before
    // publication, then repeat the same completion request.
    await env.DB.prepare("UPDATE sleeper_reports SET published_at = NULL WHERE id = ?")
      .bind(sleeperReportId).run();
    const repaired = await app.request(
      `https://potato.example/api/runners/jobs/${jobId}/result`,
      request("POST", completionBody, "runner-secret"),
      bindings,
    );
    expect(repaired.status).toBe(200);
    expect((await repaired.json<{ idempotent: boolean }>()).idempotent).toBe(true);
    expect((await env.DB.prepare(
      "SELECT published_at FROM sleeper_reports WHERE id = ?",
    ).bind(sleeperReportId).first<{ published_at: number | null }>())?.published_at).not.toBeNull();
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM research_job_events WHERE job_id = ? AND event_type = 'publication_repaired'",
    ).bind(jobId).first<{ count: number }>())?.count).toBe(1);
  });
});
