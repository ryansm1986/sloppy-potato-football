import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";
import {
  createRankingSnapshot,
  discardPendingRankingSnapshots,
  loadAllKnownRankingSourceDomains,
  publishRankingSnapshots,
  rankingLeagueSize,
  rankingSnapshotInput,
  snapshotKnownRankingSourceDomains,
} from "./ranking-snapshots";
import {
  canonicalSourceDomain,
  discardUnpublishedSleeperReport,
  persistSleeperReport,
  publishSleeperReport,
  sleeperReportInput,
  snapshotKnownSleeperSourceDomains,
} from "./sleeper-reports";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

const safeLabel = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9 .,'&()/:+\-]+$/, "Use a player, source, or ranking label without instructions");
const jobType = z.enum(["source_refresh", "player_research", "rankings_research", "sleepers_research"]);
const scoringFormat = z.enum(["ppr", "half_ppr", "standard"]);
const rankingType = z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]);
const position = z.enum(["ALL", "QB", "RB", "WR", "TE", "K", "DST"]);
const httpSourceUrl = z.string().url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Source URLs must use HTTP or HTTPS");

export const createResearchJobInput = z.object({
  type: jobType,
  subject: safeLabel.optional(),
  sourceName: safeLabel.optional(),
  scoringFormat: scoringFormat.optional().default("ppr"),
  rankingType: rankingType.optional().default("redraft"),
  position: position.optional().default("ALL"),
  season: z.string().regex(/^20\d{2}$/).optional(),
  week: z.number().int().min(1).max(25).optional(),
  rankingLimit: z.number().int().min(1).max(500).optional(),
  leagueSize: rankingLeagueSize.optional().default(12),
  sleepersPerPosition: z.number().int().min(1).max(20).optional(),
  discoverNewSources: z.boolean().optional().default(false),
}).superRefine((value, context) => {
  if (value.type === "player_research" && !value.subject) {
    context.addIssue({ code: "custom", path: ["subject"], message: "Player research requires a subject" });
  }
  if (value.type === "source_refresh" && !value.sourceName) {
    context.addIssue({ code: "custom", path: ["sourceName"], message: "Source refresh requires a source name" });
  }
  if (value.type === "sleepers_research" && (value.scoringFormat !== "ppr" || value.rankingType !== "redraft")) {
    context.addIssue({
      code: "custom",
      path: ["type"],
      message: "Sleeper research currently supports PPR redraft leagues",
    });
  }
}).transform((value) => ({
  ...value,
  rankingLimit: value.type === "source_refresh" || value.type === "rankings_research"
    ? value.rankingLimit ?? 100
    : undefined,
  leagueSize: value.leagueSize,
  sleepersPerPosition: value.type === "sleepers_research" ? value.sleepersPerPosition ?? 8 : undefined,
  discoverNewSources: value.type === "sleepers_research" || value.type === "rankings_research"
    ? value.discoverNewSources
    : undefined,
}));

type ResearchTaskInput = z.infer<typeof createResearchJobInput> & {
  // Populated only by the Worker from completed ranking/sleeper source history.
  // It is not part of the owner-facing schema and cannot be client-supplied.
  knownSourceDomains?: string[];
};

export const runnerHeartbeatInput = z.object({
  runnerId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(2).max(100).optional(),
  provider: z.enum(["codex", "claude"]),
  version: z.string().trim().max(80).optional(),
  status: z.enum(["idle", "busy", "stopping"]).default("idle"),
  capabilities: z.array(jobType).max(4).optional().default([]),
});

export const claimResearchJobInput = z.object({
  runnerId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
});

const citationInput = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().url().max(2_000),
  publisher: z.string().trim().max(120).optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  accessedAt: z.string().datetime({ offset: true }).optional(),
});

const insightInput = z.object({
  subject: z.string().trim().min(1).max(160),
  finding: z.string().trim().min(1).max(1_200),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  citationUrls: z.array(z.string().url().max(2_000)).max(10).optional(),
});

const sourcedRankingSnapshotInput = z.object({
  sourceName: safeLabel,
  sourceUrl: httpSourceUrl,
}).passthrough();

const multiSourceRankingInput = z.array(sourcedRankingSnapshotInput).min(3).max(5).superRefine((snapshots, context) => {
  const names = snapshots.map((snapshot) => snapshot.sourceName.trim().toLowerCase());
  const hosts = snapshots.map((snapshot) => canonicalSourceDomain(snapshot.sourceUrl));
  if (new Set(names).size !== names.length || new Set(hosts).size !== hosts.length) {
    context.addIssue({
      code: "custom",
      message: "General ranking research requires at least three distinct publishers and domains",
    });
  }
});

export const completeResearchJobInput = z.object({
  runnerId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  leaseToken: z.string().uuid(),
  resultId: z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  result: z.object({
    summary: z.string().trim().min(1).max(5_000),
    generatedAt: z.string().datetime({ offset: true }).optional(),
    citations: z.array(citationInput).max(50).optional().default([]),
    insights: z.array(insightInput).max(100).optional().default([]),
    rankingSnapshot: z.unknown().optional(),
    rankingSnapshots: z.unknown().optional(),
    sleeperReport: z.unknown().optional(),
  }),
});

export const failResearchJobInput = z.object({
  runnerId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  leaseToken: z.string().uuid(),
  error: z.object({
    code: z.string().trim().min(2).max(80).regex(/^[a-z0-9_:-]+$/i),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  }),
});

type ResearchJobRow = {
  id: string;
  owner_identity: string;
  job_type: z.infer<typeof jobType>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  priority: number;
  task_input_json: string;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  leased_by_runner_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  completion_key: string | null;
  result_json: string | null;
  ranking_snapshot_id: string | null;
  error_code: string | null;
  error_message: string | null;
  new_publisher_count: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
};

type RunnerRow = {
  id: string;
  name: string;
  provider: string;
  version: string | null;
  status: string;
  capabilities_json: string;
  current_job_id: string | null;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
};

export class ResearchBridgeError extends Error {
  constructor(
    readonly code: "not_found" | "job_conflict" | "lease_invalid" | "runner_not_registered" | "result_conflict",
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "ResearchBridgeError";
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function toPublicJob(row: ResearchJobRow) {
  const input = parseJson<ResearchTaskInput>(row.task_input_json, {} as never);
  return {
    id: row.id,
    type: row.job_type,
    status: row.status,
    subject: input.subject ?? null,
    sourceName: input.sourceName ?? null,
    scoringFormat: input.scoringFormat ?? "ppr",
    rankingType: input.rankingType ?? "redraft",
    position: input.position ?? "ALL",
    season: input.season ?? null,
    week: input.week ?? null,
    rankingLimit: input.rankingLimit ?? null,
    leagueSize: input.leagueSize ?? 12,
    sleepersPerPosition: input.sleepersPerPosition ?? null,
    discoverNewSources: input.discoverNewSources ?? false,
    newPublisherCount: row.new_publisher_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    attempts: row.attempt_count,
    maxAttempts: row.max_attempts,
    error: row.error_message,
    errorCode: row.error_code,
    result: parseJson(row.result_json, null),
    rankingSnapshotId: row.ranking_snapshot_id,
  };
}

function executionContext(row: ResearchJobRow) {
  const input = parseJson<ResearchTaskInput>(row.task_input_json, {} as never);
  const scope = `${input.leagueSize ?? 12}-team ${input.scoringFormat ?? "ppr"} ${input.rankingType ?? "redraft"}, ${input.position ?? "ALL"}, season ${input.season ?? new Date().getUTCFullYear()}`;
  const rankingLimit = input.rankingLimit ?? 100;
  switch (row.job_type) {
    case "source_refresh":
      return `Refresh the published fantasy-football rankings from the named source (${input.sourceName}) for ${scope}. Collect up to the requested Top ${rankingLimit} entries (all verifiable entries the source publishes, capped at ${rankingLimit}). Return only verifiable findings, citations, and a structured ranking snapshot when rankings are available.`;
    case "player_research":
      return `Research the named NFL fantasy player (${input.subject}) for ${scope}. Summarize current role, material news, risk, and ranking implications with citations.`;
    case "rankings_research":
      return `Research current fantasy-football ranking boards for ${scope}${input.subject ? `, focused on ${input.subject}` : ""}. Find at least three distinct reputable publishers and preserve each publisher as a separately attributed source board so the app can aggregate them. For EACH source return up to the requested Top ${rankingLimit}: exactly ${rankingLimit} contiguous entries when that publisher exposes them, or every verifiable entry available up to ${rankingLimit}. For ALL, use cross-position overall boards rather than quarterback-only or separate positional lists. Cite direct ranking URLs; never synthesize an agent-authored source.${input.discoverNewSources ? ` Source discovery is enabled. Previously used canonical ranking publisher domains: ${(input.knownSourceDomains ?? []).join(", ") || "none"}. Try to include at least two credible current-season ranking publisher domains outside that snapshot; if they cannot be verified, fall back to the strongest established ranking sources.` : ""}`;
    case "sleepers_research":
      return `Research current-season PPR redraft sleepers for a ${input.leagueSize ?? 12}-team league. Return up to ${input.sleepersPerPosition ?? 8} evidence-backed candidates for each of QB, RB, WR, and TE. Preserve each independent publisher's direct article URL and recommendation for each player. Recommend an overall-pick range for every candidate; the server derives rounds and ranks candidates by their count of unique recommending source domains.${input.discoverNewSources ? ` Source discovery is enabled. Previously used canonical publisher domains: ${(input.knownSourceDomains ?? []).join(", ") || "none"}. Try to include at least two credible current-season publisher domains outside that snapshot; if they cannot be verified, fall back to the strongest established sources.` : ""}`;
  }
}

async function insertEvent(db: Database, jobId: string, type: string, actorType: string, actorId?: string, details: unknown = {}) {
  await db.$client.prepare(
    "INSERT INTO research_job_events (id, job_id, event_type, actor_type, actor_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), jobId, type, actorType, actorId ?? null, JSON.stringify(details), Date.now()).run();
}

async function findJob(db: Database, id: string) {
  return db.$client.prepare("SELECT * FROM research_jobs WHERE id = ?").bind(id).first<ResearchJobRow>();
}

async function findJobRankingSnapshotIds(db: Database, jobId: string) {
  const singleRunId = `research-job:${jobId}`;
  const multiRunPrefix = `${singleRunId}:`;
  const rows = await db.$client.prepare(
    `SELECT id FROM ranking_snapshots
     WHERE external_run_id = ? OR instr(external_run_id, ?) = 1
     ORDER BY external_run_id`,
  ).bind(singleRunId, multiRunPrefix).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function findJobSleeperReportId(db: Database, jobId: string) {
  const row = await db.$client.prepare("SELECT id FROM sleeper_reports WHERE job_id = ?")
    .bind(jobId).first<{ id: string }>();
  return row?.id ?? null;
}

export async function createResearchJob(
  db: Database,
  input: z.infer<typeof createResearchJobInput>,
  idempotencyKey: string,
  ownerIdentity = "primary-owner",
) {
  const existing = await db.$client.prepare(
    "SELECT * FROM research_jobs WHERE owner_identity = ? AND idempotency_key = ?",
  ).bind(ownerIdentity, idempotencyKey).first<ResearchJobRow>();
  if (existing) return { job: toPublicJob(existing), created: false };

  const id = crypto.randomUUID();
  const now = Date.now();
  const taskInput: ResearchTaskInput = input.discoverNewSources
    ? input.type === "sleepers_research"
      ? { ...input, knownSourceDomains: await snapshotKnownSleeperSourceDomains(db) }
      : input.type === "rankings_research"
        ? { ...input, knownSourceDomains: await snapshotKnownRankingSourceDomains(db) }
        : input
    : input;
  try {
    await db.$client.batch([
      db.$client.prepare(
        `INSERT INTO research_jobs
         (id, owner_identity, job_type, status, priority, task_input_json, idempotency_key,
          attempt_count, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, 0, 3, ?, ?)`,
      ).bind(id, ownerIdentity, input.type, JSON.stringify(taskInput), idempotencyKey, now, now),
      db.$client.prepare(
        "INSERT INTO research_job_events (id, job_id, event_type, actor_type, actor_id, details_json, created_at) VALUES (?, ?, 'queued', 'owner', ?, '{}', ?)",
      ).bind(crypto.randomUUID(), id, ownerIdentity, now),
    ]);
  } catch (error) {
    // Concurrent cron deliveries may race between the lookup and insert. The
    // database uniqueness constraint is the authority for idempotency.
    const raced = await db.$client.prepare(
      "SELECT * FROM research_jobs WHERE owner_identity = ? AND idempotency_key = ?",
    ).bind(ownerIdentity, idempotencyKey).first<ResearchJobRow>();
    if (raced) return { job: toPublicJob(raced), created: false };
    throw error;
  }
  const row = await findJob(db, id);
  return { job: toPublicJob(row!), created: true };
}

export async function listResearchJobs(db: Database, limit: number, ownerIdentity = "primary-owner") {
  const rows = await db.$client.prepare(
    "SELECT * FROM research_jobs WHERE owner_identity = ? ORDER BY created_at DESC, id DESC LIMIT ?",
  ).bind(ownerIdentity, limit).all<ResearchJobRow>();
  return rows.results.map(toPublicJob);
}

export async function getResearchJob(db: Database, id: string, ownerIdentity = "primary-owner") {
  const row = await db.$client.prepare(
    "SELECT * FROM research_jobs WHERE id = ? AND owner_identity = ?",
  ).bind(id, ownerIdentity).first<ResearchJobRow>();
  if (!row) throw new ResearchBridgeError("not_found", "Research job not found", 404);
  const events = await db.$client.prepare(
    "SELECT id, event_type, actor_type, actor_id, details_json, created_at FROM research_job_events WHERE job_id = ? ORDER BY created_at, id",
  ).bind(id).all<{ id: string; event_type: string; actor_type: string; actor_id: string | null; details_json: string; created_at: number }>();
  return {
    job: toPublicJob(row),
    events: events.results.map((event) => ({
      id: event.id,
      type: event.event_type,
      actorType: event.actor_type,
      actorId: event.actor_id,
      details: parseJson(event.details_json, {}),
      createdAt: iso(event.created_at),
    })),
  };
}

export async function retryResearchJob(db: Database, id: string, ownerIdentity = "primary-owner") {
  const now = Date.now();
  const result = await db.$client.prepare(
    `UPDATE research_jobs SET status = 'queued', attempt_count = 0, leased_by_runner_id = NULL,
       lease_token = NULL, lease_expires_at = NULL, completion_key = NULL, error_code = NULL,
       error_message = NULL, completed_at = NULL, updated_at = ?
     WHERE id = ? AND owner_identity = ? AND status IN ('failed', 'cancelled')`,
  ).bind(now, id, ownerIdentity).run();
  if ((result.meta.changes ?? 0) === 0) {
    const row = await findJob(db, id);
    if (!row || row.owner_identity !== ownerIdentity) throw new ResearchBridgeError("not_found", "Research job not found", 404);
    throw new ResearchBridgeError("job_conflict", "Only failed or cancelled jobs can be retried", 409);
  }
  await discardPendingRankingSnapshots(db, id);
  await insertEvent(db, id, "retried", "owner", ownerIdentity);
  return toPublicJob((await findJob(db, id))!);
}

export async function heartbeatRunner(db: Database, input: z.infer<typeof runnerHeartbeatInput>) {
  const now = Date.now();
  await db.$client.prepare(
    `INSERT INTO research_runners
       (id, name, provider, version, status, capabilities_json, current_job_id, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider,
       version = excluded.version, status = excluded.status, capabilities_json = excluded.capabilities_json,
       last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
  ).bind(
    input.runnerId,
    input.name ?? input.runnerId,
    input.provider,
    input.version ?? null,
    input.status,
    JSON.stringify(input.capabilities),
    now,
    now,
    now,
  ).run();
  const runner = await db.$client.prepare("SELECT * FROM research_runners WHERE id = ?").bind(input.runnerId).first<RunnerRow>();
  return toRunner(runner!, now);
}

function toRunner(row: RunnerRow, now = Date.now()) {
  const age = now - row.last_seen_at;
  const state = age > 5 * 60_000 ? "offline" : age > 60_000 ? "stale" : row.current_job_id || row.status === "busy" ? "busy" : "online";
  return {
    id: row.id,
    name: row.name,
    state,
    provider: row.provider,
    version: row.version,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    lastSeenAt: iso(row.last_seen_at),
    currentJobId: row.current_job_id,
  };
}

export async function getRunnerStatus(db: Database) {
  const now = Date.now();
  const runner = await db.$client.prepare(
    "SELECT * FROM research_runners ORDER BY last_seen_at DESC LIMIT 1",
  ).first<RunnerRow>();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const count = await db.$client.prepare(
    "SELECT COUNT(*) AS count FROM research_jobs WHERE completed_at >= ?",
  ).bind(startOfToday.getTime()).first<{ count: number }>();
  if (!runner) return {
    state: "offline", provider: null, lastSeenAt: null, currentJobId: null,
    jobsToday: count?.count ?? 0, autoRun: false,
  };
  return { ...toRunner(runner, now), jobsToday: count?.count ?? 0, autoRun: true };
}

export async function claimResearchJob(db: Database, runnerId: string) {
  const runner = await db.$client.prepare("SELECT * FROM research_runners WHERE id = ?").bind(runnerId).first<RunnerRow>();
  if (!runner) throw new ResearchBridgeError("runner_not_registered", "Send a runner heartbeat before claiming jobs", 409);
  const now = Date.now();
  if (runner.current_job_id) {
    const active = await findJob(db, runner.current_job_id);
    if (active?.status === "running" && active.leased_by_runner_id === runnerId
      && active.lease_token && active.lease_expires_at && active.lease_expires_at >= now) {
      return {
        id: active.id,
        type: active.job_type,
        input: parseJson(active.task_input_json, {}),
        attempt: active.attempt_count,
        maxAttempts: active.max_attempts,
        leaseToken: active.lease_token,
        leaseExpiresAt: iso(active.lease_expires_at),
        executionContext: executionContext(active),
      };
    }
  }
  await db.$client.prepare(
    `DELETE FROM ranking_snapshots
     WHERE status = 'pending' AND research_job_id IN (
       SELECT id FROM research_jobs WHERE status = 'running' AND lease_expires_at < ?
     )`,
  ).bind(now).run();
  await db.$client.prepare(
    `UPDATE research_jobs SET status = 'queued', leased_by_runner_id = NULL, lease_token = NULL,
       lease_expires_at = NULL, updated_at = ?
     WHERE status = 'running' AND lease_expires_at < ? AND attempt_count < max_attempts`,
  ).bind(now, now).run();
  await db.$client.prepare(
    `UPDATE research_jobs SET status = 'failed', error_code = 'attempts_exhausted',
       error_message = 'The runner lease expired too many times.', completed_at = ?, updated_at = ?
     WHERE status = 'running' AND lease_expires_at < ? AND attempt_count >= max_attempts`,
  ).bind(now, now, now).run();

  const capabilities = parseJson<string[]>(runner.capabilities_json, []);
  const candidates = await db.$client.prepare(
    "SELECT * FROM research_jobs WHERE status = 'queued' ORDER BY priority DESC, created_at, id LIMIT 10",
  ).all<ResearchJobRow>();
  const candidate = candidates.results.find((job) => capabilities.length === 0 || capabilities.includes(job.job_type));
  if (!candidate) {
    await db.$client.prepare(
      "UPDATE research_runners SET status = 'idle', current_job_id = NULL, last_seen_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, runnerId).run();
    return null;
  }

  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = now + 15 * 60_000;
  const claimed = await db.$client.prepare(
    `UPDATE research_jobs SET status = 'running', attempt_count = attempt_count + 1,
       leased_by_runner_id = ?, lease_token = ?, lease_expires_at = ?,
       started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  ).bind(runnerId, leaseToken, leaseExpiresAt, now, now, candidate.id).run();
  if ((claimed.meta.changes ?? 0) === 0) return claimResearchJob(db, runnerId);
  await db.$client.prepare(
    "UPDATE research_runners SET status = 'busy', current_job_id = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
  ).bind(candidate.id, now, now, runnerId).run();
  await insertEvent(db, candidate.id, "claimed", "runner", runnerId, { leaseExpiresAt: iso(leaseExpiresAt) });
  const job = (await findJob(db, candidate.id))!;
  const claimedInput = parseJson<ResearchTaskInput>(job.task_input_json, {} as never);
  return {
    id: job.id,
    type: job.job_type,
    input: { ...claimedInput, leagueSize: claimedInput.leagueSize ?? 12 },
    attempt: job.attempt_count,
    maxAttempts: job.max_attempts,
    leaseToken,
    leaseExpiresAt: iso(leaseExpiresAt),
    executionContext: executionContext(job),
  };
}

function assertActiveLease(row: ResearchJobRow, runnerId: string, leaseToken: string, now: number) {
  if (row.status !== "running" || row.leased_by_runner_id !== runnerId || row.lease_token !== leaseToken || !row.lease_expires_at || row.lease_expires_at < now) {
    throw new ResearchBridgeError("lease_invalid", "The job lease is missing, expired, or belongs to another runner", 409);
  }
}

function sourceSlug(name: string, fallback: string) {
  return name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63) || fallback;
}

function assertPositionCoverage(entries: Array<{ position?: string | null }>, requestedPosition: z.infer<typeof position>) {
  const normalized = entries.flatMap((entry) => {
    if (!entry.position) return [];
    const value = entry.position.trim().toUpperCase();
    return [value === "DEF" ? "DST" : value];
  });
  z.unknown().superRefine((_value, context) => {
    if (requestedPosition === "ALL") {
      if (entries.length >= 12 && new Set(normalized).size < 2) {
        context.addIssue({ code: "custom", message: "An ALL ranking board must span multiple player positions" });
      }
      if (entries.length >= 25 && new Set(normalized).size < 3) {
        context.addIssue({ code: "custom", message: "A large ALL ranking board must span at least three player positions" });
      }
      return;
    }
    // Some publishers include a few out-of-position flex or comparison rows on
    // positional pages. Position scope is server-owned metadata, so retain those
    // rows instead of rejecting an otherwise verifiable published board.
  }).parse(entries);
}

export async function completeResearchJob(db: Database, jobId: string, input: z.infer<typeof completeResearchJobInput>) {
  const row = await findJob(db, jobId);
  if (!row) throw new ResearchBridgeError("not_found", "Research job not found", 404);
  if (row.status === "completed") {
    if (row.completion_key !== input.resultId) throw new ResearchBridgeError("result_conflict", "This job already has a different result", 409);
    const rankingSnapshotIds = await findJobRankingSnapshotIds(db, jobId);
    const repairedRankingPublications = await publishRankingSnapshots(db, jobId);
    const sleeperReportId = await findJobSleeperReportId(db, jobId);
    const repairedPublication = sleeperReportId ? await publishSleeperReport(db, sleeperReportId) : false;
    await db.$client.prepare(
      "UPDATE research_runners SET status = 'idle', current_job_id = NULL, last_seen_at = ?, updated_at = ? WHERE id = ? AND current_job_id = ?",
    ).bind(Date.now(), Date.now(), input.runnerId, jobId).run();
    if (repairedPublication) {
      await insertEvent(db, jobId, "publication_repaired", "runner", input.runnerId, { sleeperReportId });
    }
    if (repairedRankingPublications > 0) {
      await insertEvent(db, jobId, "ranking_publication_repaired", "runner", input.runnerId, {
        rankingSnapshotIds,
      });
    }
    return { job: toPublicJob(row), idempotent: true, rankingSnapshotId: row.ranking_snapshot_id, rankingSnapshotIds, sleeperReportId };
  }
  const now = Date.now();
  assertActiveLease(row, input.runnerId, input.leaseToken, now);

  const taskInput = parseJson<ResearchTaskInput>(row.task_input_json, {} as never);
  const runner = await db.$client.prepare("SELECT provider FROM research_runners WHERE id = ?")
    .bind(input.runnerId).first<{ provider: string }>();
  const provider = runner?.provider === "claude" ? "claude" : "codex";
  const generatedAt = input.result.generatedAt ?? new Date(now).toISOString();
  const snapshotsToCreate: Array<z.infer<typeof rankingSnapshotInput>> = [];
  const rankingSnapshotDomains: string[] = [];
  const parsedSleeperReport = row.job_type === "sleepers_research"
    ? sleeperReportInput.parse(input.result.sleeperReport)
    : null;
  if (row.job_type === "sleepers_research") {
    if (input.result.rankingSnapshot !== undefined && input.result.rankingSnapshot !== null) {
      z.never().parse(input.result.rankingSnapshot);
    }
    if (input.result.rankingSnapshots !== undefined && input.result.rankingSnapshots !== null) {
      z.never().parse(input.result.rankingSnapshots);
    }
  } else if (input.result.sleeperReport !== undefined && input.result.sleeperReport !== null) {
    z.never().parse(input.result.sleeperReport);
  }

  if (input.result.rankingSnapshots !== undefined && input.result.rankingSnapshots !== null) {
    if (row.job_type !== "rankings_research") {
      z.never().parse(input.result.rankingSnapshots);
    }
    const sourcedSnapshots = multiSourceRankingInput.parse(input.result.rankingSnapshots);
    for (const [index, rawSnapshot] of sourcedSnapshots.entries()) {
      const fields = { ...rawSnapshot } as Record<string, unknown>;
      delete fields.source;
      delete fields.externalRunId;
      delete fields.generatedAt;
      delete fields.positionScope;
      delete fields.leagueSize;
      delete fields.sourceName;
      delete fields.sourceUrl;
      const slug = sourceSlug(rawSnapshot.sourceName, `rankings-source-${index + 1}`);
      const domain = new URL(rawSnapshot.sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
      rankingSnapshotDomains.push(canonicalSourceDomain(rawSnapshot.sourceUrl));
      const snapshot = rankingSnapshotInput.parse({
        ...fields,
        scoringFormat: taskInput.scoringFormat ?? "ppr",
        rankingType: taskInput.rankingType ?? "redraft",
        season: taskInput.season ?? fields.season,
        week: taskInput.week ?? fields.week ?? null,
        source: {
          canonicalKey: `external:${slug}`,
          slug,
          name: rawSnapshot.sourceName,
          kind: "external",
          attributionUrl: rawSnapshot.sourceUrl,
          aliases: [
            { type: "name", value: rawSnapshot.sourceName },
            { type: "url", value: rawSnapshot.sourceUrl },
            { type: "domain", value: domain },
          ],
          provenance: { discoveredBy: provider, researchJobId: jobId },
        },
        generatedAt,
        externalRunId: `research-job:${jobId}:${index + 1}`,
        positionScope: taskInput.position ?? "ALL",
        leagueSize: taskInput.leagueSize ?? 12,
      });
      assertPositionCoverage(snapshot.entries, taskInput.position ?? "ALL");
      snapshotsToCreate.push(snapshot);
    }
  } else if (input.result.rankingSnapshot !== undefined && input.result.rankingSnapshot !== null) {
    // Legacy single-snapshot results remain accepted for in-flight runners and
    // source_refresh jobs. New rankings_research prompts use rankingSnapshots.
    const rawSnapshot = input.result.rankingSnapshot as Record<string, unknown>;
    const rawSourceUrl = typeof rawSnapshot.sourceUrl === "string" ? rawSnapshot.sourceUrl : undefined;
    const sourceName = row.job_type === "source_refresh"
      ? taskInput.sourceName!
      : `Sloppy Potato ${provider === "claude" ? "Claude" : "Codex"} Research`;
    const slug = sourceSlug(sourceName, `${provider}-research`);
    const snapshotFields = { ...rawSnapshot };
    delete snapshotFields.source;
    delete snapshotFields.externalRunId;
    delete snapshotFields.generatedAt;
    delete snapshotFields.positionScope;
    delete snapshotFields.leagueSize;
    delete snapshotFields.sourceName;
    delete snapshotFields.sourceUrl;
    const snapshot = rankingSnapshotInput.parse({
      ...snapshotFields,
      scoringFormat: taskInput.scoringFormat ?? "ppr",
      rankingType: taskInput.rankingType ?? "redraft",
      season: taskInput.season ?? snapshotFields.season,
      week: taskInput.week ?? snapshotFields.week ?? null,
      source: row.job_type === "source_refresh" ? {
        canonicalKey: `external:${slug}`,
        slug,
        name: sourceName,
        kind: "external",
        attributionUrl: rawSourceUrl,
      } : {
        canonicalKey: `agent:${provider}-research`,
        slug: `${provider}-research`,
        name: sourceName,
        kind: "agent",
        provider,
      },
      generatedAt,
      externalRunId: `research-job:${jobId}`,
      positionScope: taskInput.position ?? "ALL",
      leagueSize: taskInput.leagueSize ?? 12,
    });
    assertPositionCoverage(snapshot.entries, taskInput.position ?? "ALL");
    snapshotsToCreate.push(snapshot);
  }

  const rankingSnapshotIds: string[] = [];
  // The prompt receives a bounded recent-domain snapshot, but persisted labels
  // compare against the entire source registry and completed snapshot history.
  // This prevents an older publisher from becoming falsely "new" after it
  // falls out of the prompt cap.
  const allKnownRankingDomains = row.job_type === "rankings_research"
    ? new Set(await loadAllKnownRankingSourceDomains(db))
    : new Set<string>();
  const newRankingDomains = new Set(taskInput.discoverNewSources && row.job_type === "rankings_research"
    ? rankingSnapshotDomains.filter((domain) => !allKnownRankingDomains.has(domain))
    : []);
  for (const [index, snapshot] of snapshotsToCreate.entries()) {
    const rankingDiscovery = row.job_type === "rankings_research" ? {
      researchJobId: jobId,
      discoverNewSources: taskInput.discoverNewSources ?? false,
      isNewDiscovery: newRankingDomains.has(rankingSnapshotDomains[index]),
      newPublisherCount: newRankingDomains.size,
    } : {
      researchJobId: jobId,
      discoverNewSources: false,
      isNewDiscovery: false,
      newPublisherCount: 0,
    };
    const created = await createRankingSnapshot(db, snapshot, rankingDiscovery);
    rankingSnapshotIds.push(created.id);
  }
  const rankingSnapshotId = rankingSnapshotIds[0] ?? null;
  let sleeperReportId: string | null = null;
  if (parsedSleeperReport) {
    sleeperReportId = await persistSleeperReport(db, {
      jobId,
      season: taskInput.season ?? String(new Date(now).getUTCFullYear()),
      scoringFormat: "ppr",
      rankingType: "redraft",
      leagueSize: taskInput.leagueSize ?? 12,
      sleepersPerPosition: taskInput.sleepersPerPosition ?? 8,
      discoverNewSources: taskInput.discoverNewSources ?? false,
      knownSourceDomains: taskInput.knownSourceDomains ?? [],
      generatedAt,
      report: parsedSleeperReport,
    });
  }
  const resultJson = JSON.stringify(input.result);
  const finalizedAt = Date.now();
  const updated = await db.$client.prepare(
    `UPDATE research_jobs SET status = 'completed', completion_key = ?, result_json = ?,
       ranking_snapshot_id = ?, new_publisher_count = ?, completed_at = ?, updated_at = ?, lease_expires_at = NULL
     WHERE id = ? AND status = 'running' AND leased_by_runner_id = ? AND lease_token = ?
       AND lease_expires_at >= ?`,
  ).bind(
    input.resultId,
    resultJson,
    rankingSnapshotId,
    newRankingDomains.size,
    finalizedAt,
    finalizedAt,
    jobId,
    input.runnerId,
    input.leaseToken,
    finalizedAt,
  ).run();
  if ((updated.meta.changes ?? 0) === 0) {
    if (sleeperReportId) await discardUnpublishedSleeperReport(db, jobId);
    await discardPendingRankingSnapshots(db, jobId);
    throw new ResearchBridgeError("lease_invalid", "The job lease changed before completion", 409);
  }
  await publishRankingSnapshots(db, jobId);
  if (sleeperReportId) await publishSleeperReport(db, sleeperReportId);
  await db.$client.prepare(
    "UPDATE research_runners SET status = 'idle', current_job_id = NULL, last_seen_at = ?, updated_at = ? WHERE id = ? AND current_job_id = ?",
  ).bind(now, now, input.runnerId, jobId).run();
  await insertEvent(db, jobId, "completed", "runner", input.runnerId, {
    resultId: input.resultId,
    rankingSnapshotId,
    rankingSnapshotIds,
    sleeperReportId,
  });
  return {
    job: toPublicJob((await findJob(db, jobId))!),
    idempotent: false,
    rankingSnapshotId,
    rankingSnapshotIds,
    sleeperReportId,
  };
}

export async function failResearchJob(db: Database, jobId: string, input: z.infer<typeof failResearchJobInput>) {
  const row = await findJob(db, jobId);
  if (!row) throw new ResearchBridgeError("not_found", "Research job not found", 404);
  const now = Date.now();
  assertActiveLease(row, input.runnerId, input.leaseToken, now);
  const retry = input.error.retryable && row.attempt_count < row.max_attempts;
  const nextStatus = retry ? "queued" : "failed";
  const updated = await db.$client.prepare(
    `UPDATE research_jobs SET status = ?, leased_by_runner_id = NULL, lease_token = NULL,
       lease_expires_at = NULL, error_code = ?, error_message = ?,
       completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?`,
  ).bind(nextStatus, input.error.code, input.error.message, retry ? null : now, now, jobId, input.leaseToken).run();
  if ((updated.meta.changes ?? 0) === 0) {
    throw new ResearchBridgeError("lease_invalid", "The job lease changed before failure was recorded", 409);
  }
  await discardPendingRankingSnapshots(db, jobId);
  await db.$client.prepare(
    "UPDATE research_runners SET status = 'idle', current_job_id = NULL, last_seen_at = ?, updated_at = ? WHERE id = ? AND current_job_id = ?",
  ).bind(now, now, input.runnerId, jobId).run();
  await insertEvent(db, jobId, retry ? "requeued" : "failed", "runner", input.runnerId, input.error);
  return toPublicJob((await findJob(db, jobId))!);
}
