import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

export const sleeperPositions = ["QB", "RB", "WR", "TE"] as const;
const sleeperPosition = z.enum(sleeperPositions);

const httpUrl = z.string().url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Source URLs must use HTTP or HTTPS");

const sleeperSourceInput = z.object({
  publisher: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  url: httpUrl,
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  recommendation: z.string().trim().min(1).max(1_200).nullable(),
}).strict();

const sleeperCandidateInput = z.object({
  playerName: z.string().trim().min(2).max(120),
  position: sleeperPosition,
  team: z.string().trim().toUpperCase().min(2).max(5).nullable(),
  recommendedPickStart: z.number().int().min(1).max(500),
  recommendedPickEnd: z.number().int().min(1).max(500),
  summary: z.string().trim().min(1).max(1_500),
  upside: z.string().trim().min(1).max(1_200).nullable(),
  risk: z.string().trim().min(1).max(1_200).nullable(),
  sources: z.array(sleeperSourceInput).min(1).max(12),
}).strict().superRefine((candidate, context) => {
  if (candidate.recommendedPickStart > candidate.recommendedPickEnd) {
    context.addIssue({
      code: "custom",
      path: ["recommendedPickEnd"],
      message: "Recommended pick ranges must be ordered from earliest to latest",
    });
  }
});

export const sleeperReportInput = z.object({
  summary: z.string().trim().min(1).max(5_000),
  positionSummaries: z.object({
    QB: z.string().trim().min(1).max(1_500),
    RB: z.string().trim().min(1).max(1_500),
    WR: z.string().trim().min(1).max(1_500),
    TE: z.string().trim().min(1).max(1_500),
  }).strict(),
  candidates: z.array(sleeperCandidateInput).min(4).max(80),
}).strict().superRefine((report, context) => {
  const positions = new Set(report.candidates.map((candidate) => candidate.position));
  for (const required of sleeperPositions) {
    if (!positions.has(required)) {
      context.addIssue({ code: "custom", path: ["candidates"], message: `Sleeper research requires at least one ${required}` });
    }
  }
  const playerKeys = report.candidates.map((candidate) => `${candidate.position}:${candidate.playerName.toLowerCase()}`);
  if (new Set(playerKeys).size !== playerKeys.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "Players must be unique within each position" });
  }
});

export type SleeperReportInput = z.infer<typeof sleeperReportInput>;

type PersistSleeperReportOptions = {
  jobId: string;
  season: string;
  scoringFormat: "ppr";
  rankingType: "redraft";
  leagueSize: number;
  sleepersPerPosition: number;
  generatedAt: string;
  report: SleeperReportInput;
};

// A compact approximation of the common multi-label public suffixes likely to
// appear in fantasy-football sources. This is deliberately conservative: the
// default remains the final two labels, while these suffixes retain one more.
const commonMultiLabelPublicSuffixes = new Set([
  "ac.uk", "co.uk", "gov.uk", "me.uk", "net.uk", "org.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "net.au", "org.au",
  "ac.nz", "co.nz", "govt.nz", "net.nz", "org.nz",
  "co.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "co.jp", "ne.jp", "or.jp",
  "co.kr", "ne.kr", "or.kr",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.sg", "com.tw", "co.za", "com.ar",
]);

export function canonicalSourceDomain(url: string) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) return hostname;
  const finalTwo = labels.slice(-2).join(".");
  return commonMultiLabelPublicSuffixes.has(finalTwo)
    ? labels.slice(-3).join(".")
    : finalTwo;
}

function dedupeSources(sources: SleeperReportInput["candidates"][number]["sources"]) {
  const byDomain = new Map<string, typeof sources[number]>();
  const publishers = new Set<string>();
  for (const source of sources) {
    const domain = canonicalSourceDomain(source.url);
    const publisher = source.publisher.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!byDomain.has(domain) && !publishers.has(publisher)) {
      byDomain.set(domain, source);
      publishers.add(publisher);
    }
  }
  return [...byDomain.entries()].map(([domain, source]) => ({ ...source, domain }));
}

export async function persistSleeperReport(db: Database, options: PersistSleeperReportOptions) {
  const existing = await db.$client.prepare("SELECT id, published_at FROM sleeper_reports WHERE job_id = ?")
    .bind(options.jobId).first<{ id: string; published_at: number | null }>();
  if (existing) {
    // This function is called only while the job is still running. Any previous
    // row is therefore an incomplete attempt (including legacy premature
    // publication) and must be rebuilt behind the unpublished boundary.
    await db.$client.prepare("DELETE FROM sleeper_reports WHERE id = ?").bind(existing.id).run();
  }

  const normalized = options.report.candidates.map((candidate) => ({
    ...candidate,
    sources: dedupeSources(candidate.sources),
  }));
  const allDomains = new Set(normalized.flatMap((candidate) => candidate.sources.map((source) => source.domain)));
  const allPublishers = new Set(normalized.flatMap((candidate) => candidate.sources.map((source) => (
    source.publisher.toLowerCase().replace(/[^a-z0-9]+/g, "")
  ))));
  if (allDomains.size < 3 || allPublishers.size < 3) {
    throw new z.ZodError([{
      code: "custom",
      path: ["sleeperReport", "candidates"],
      message: "Sleeper research requires recommendations from at least three independent publishers and source domains",
    }]);
  }
  if (normalized.some((candidate) => candidate.recommendedPickEnd > options.leagueSize * 25)) {
    throw new z.ZodError([{
      code: "custom",
      path: ["sleeperReport", "candidates", "recommendedPickEnd"],
      message: "Recommended picks must fit within 25 rounds for the requested league size",
    }]);
  }

  const reportId = crypto.randomUUID();
  const now = Date.now();
  await db.$client.prepare(
      `INSERT INTO sleeper_reports
       (id, job_id, season, scoring_format, ranking_type, league_size, summary, generated_at, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      reportId,
      options.jobId,
      options.season,
      options.scoringFormat,
      options.rankingType,
      options.leagueSize,
      options.report.summary,
      Date.parse(options.generatedAt),
      now,
    ).run();
  const statements: D1PreparedStatement[] = [];

  for (const position of sleeperPositions) {
    statements.push(db.$client.prepare(
      "INSERT INTO sleeper_position_summaries (report_id, position, summary) VALUES (?, ?, ?)",
    ).bind(reportId, position, options.report.positionSummaries[position]));

    const candidates = normalized
      .filter((candidate) => candidate.position === position)
      .sort((left, right) => right.sources.length - left.sources.length
        || left.recommendedPickStart - right.recommendedPickStart
        || left.playerName.localeCompare(right.playerName))
      .slice(0, options.sleepersPerPosition);

    for (const [index, candidate] of candidates.entries()) {
      const candidateId = crypto.randomUUID();
      statements.push(db.$client.prepare(
        `INSERT INTO sleeper_candidates
         (id, report_id, position, position_rank, player_name, team, source_count,
          recommended_pick_start, recommended_pick_end, summary, upside, risk, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        candidateId,
        reportId,
        position,
        index + 1,
        candidate.playerName,
        candidate.team,
        candidate.sources.length,
        candidate.recommendedPickStart,
        candidate.recommendedPickEnd,
        candidate.summary,
        candidate.upside,
        candidate.risk,
        now,
      ));
      for (const source of candidate.sources) {
        statements.push(db.$client.prepare(
          `INSERT INTO sleeper_candidate_sources
           (id, candidate_id, publisher, title, url, source_domain, published_at, recommendation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          candidateId,
          source.publisher,
          source.title,
          source.url,
          source.domain,
          source.publishedAt ? Date.parse(source.publishedAt) : null,
          source.recommendation,
          now,
        ));
      }
    }
  }
  // D1 limits a batch to 100 statements. The unpublished parent makes these
  // chunks invisible until every normalized child row has been stored.
  for (let offset = 0; offset < statements.length; offset += 75) {
    await db.$client.batch(statements.slice(offset, offset + 75));
  }
  return reportId;
}

export async function publishSleeperReport(db: Database, reportId: string) {
  const result = await db.$client.prepare(
    "UPDATE sleeper_reports SET published_at = ? WHERE id = ? AND published_at IS NULL",
  ).bind(Date.now(), reportId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function discardUnpublishedSleeperReport(db: Database, jobId: string) {
  await db.$client.prepare(
    "DELETE FROM sleeper_reports WHERE job_id = ? AND published_at IS NULL",
  ).bind(jobId).run();
}

type ReportRow = {
  id: string;
  season: string;
  scoring_format: string;
  ranking_type: string;
  league_size: number;
  summary: string;
  generated_at: number;
  created_at: number;
  published_at: number;
};

type CandidateRow = {
  id: string;
  position: typeof sleeperPositions[number];
  position_rank: number;
  player_name: string;
  team: string | null;
  source_count: number;
  recommended_pick_start: number;
  recommended_pick_end: number;
  summary: string;
  upside: string | null;
  risk: string | null;
};

type SourceRow = {
  id: string;
  candidate_id: string;
  publisher: string;
  title: string;
  url: string;
  published_at: number | null;
  recommendation: string | null;
};

export async function getLatestSleeperReport(db: Database) {
  const report = await db.$client.prepare(
    `SELECT id, season, scoring_format, ranking_type, league_size, summary, generated_at, created_at
     FROM sleeper_reports WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1`,
  ).first<ReportRow>();
  if (!report) return null;

  const [summaryRows, candidateRows] = await Promise.all([
    db.$client.prepare("SELECT position, summary FROM sleeper_position_summaries WHERE report_id = ?")
      .bind(report.id).all<{ position: typeof sleeperPositions[number]; summary: string }>(),
    db.$client.prepare(
      `SELECT id, position, position_rank, player_name, team, source_count,
              recommended_pick_start, recommended_pick_end, summary, upside, risk
       FROM sleeper_candidates WHERE report_id = ? ORDER BY position, position_rank, id`,
    ).bind(report.id).all<CandidateRow>(),
  ]);
  const candidateIds = candidateRows.results.map((candidate) => candidate.id);
  const sourceRows = candidateIds.length === 0
    ? { results: [] as SourceRow[] }
    : await db.$client.prepare(
      `SELECT id, candidate_id, publisher, title, url, published_at, recommendation
       FROM sleeper_candidate_sources
       WHERE candidate_id IN (SELECT value FROM json_each(?))
       ORDER BY publisher, id`,
    ).bind(JSON.stringify(candidateIds)).all<SourceRow>();
  const summaries = new Map(summaryRows.results.map((row) => [row.position, row.summary]));
  const sourcesByCandidate = new Map<string, SourceRow[]>();
  for (const source of sourceRows.results) {
    const values = sourcesByCandidate.get(source.candidate_id) ?? [];
    values.push(source);
    sourcesByCandidate.set(source.candidate_id, values);
  }

  const positionSummaries = Object.fromEntries(sleeperPositions.map((position) => [
    position,
    summaries.get(position) ?? "",
  ])) as Record<typeof sleeperPositions[number], string>;
  const positions = Object.fromEntries(sleeperPositions.map((position) => [
    position,
    candidateRows.results.filter((candidate) => candidate.position === position).map((candidate) => ({
      id: candidate.id,
      rank: candidate.position_rank,
      playerName: candidate.player_name,
      team: candidate.team,
      position: candidate.position,
      sourceCount: candidate.source_count,
      recommendedPickStart: candidate.recommended_pick_start,
      recommendedPickEnd: candidate.recommended_pick_end,
      recommendedRoundStart: Math.floor((candidate.recommended_pick_start - 1) / report.league_size) + 1,
      recommendedRoundEnd: Math.floor((candidate.recommended_pick_end - 1) / report.league_size) + 1,
      summary: candidate.summary,
      upside: candidate.upside,
      risk: candidate.risk,
      sources: (sourcesByCandidate.get(candidate.id) ?? []).map((source) => ({
        publisher: source.publisher,
        title: source.title,
        url: source.url,
        publishedAt: source.published_at === null ? null : new Date(source.published_at).toISOString(),
        recommendation: source.recommendation,
      })),
    })),
  ])) as Record<typeof sleeperPositions[number], unknown[]>;

  return {
    id: report.id,
    season: report.season,
    scoringFormat: report.scoring_format,
    rankingType: report.ranking_type,
    leagueSize: report.league_size,
    summary: report.summary,
    positionSummaries,
    generatedAt: new Date(report.generated_at).toISOString(),
    createdAt: new Date(report.created_at).toISOString(),
    positions,
  };
}
