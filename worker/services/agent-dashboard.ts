import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import type * as schema from "../db/schema";
import { getResearchSettings } from "./agent-settings";
import { ResearchBridgeError, toPublicJob, toRunner, type ResearchJobRow, type RunnerRow } from "./research-bridge";
import { safeResearchEventDetails, stageMessages } from "./research-event-details";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

export const researchProgressInput = z.object({
  runnerId: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  leaseToken: z.string().uuid(),
  stage: z.enum(["starting", "researching", "validating", "publishing"]),
}).strict();

export async function getAgentJobEvents(db: Database, jobId: string, ownerIdentity = "primary-owner") {
  const job = await db.$client.prepare("SELECT id FROM research_jobs WHERE id = ? AND owner_identity = ?")
    .bind(jobId, ownerIdentity).first();
  if (!job) throw new ResearchBridgeError("not_found", "Research job not found", 404);
  const rows = await db.$client.prepare(
    `SELECT id, job_id, event_type, actor_type, actor_id, details_json, created_at FROM research_job_events
     WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
  ).bind(jobId).all<{ id: string; job_id: string; event_type: string; actor_type: string; actor_id: string | null; details_json: string; created_at: number }>();
  return rows.results.map((event) => ({
    id: event.id, jobId: event.job_id, type: event.event_type, actorType: event.actor_type,
    actorId: event.actor_id, details: safeResearchEventDetails(event.details_json), createdAt: new Date(event.created_at).toISOString(),
  }));
}

export async function recordResearchProgress(db: Database, jobId: string, input: z.infer<typeof researchProgressInput>) {
  const now = Date.now();
  const row = await db.$client.prepare(
    `SELECT attempt_count FROM research_jobs WHERE id = ? AND status = 'running'
     AND leased_by_runner_id = ? AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(jobId, input.runnerId, input.leaseToken, now).first<{ attempt_count: number }>();
  if (!row) throw new ResearchBridgeError("lease_invalid", "The job lease is missing, expired, or belongs to another runner", 409);
  // Hash the lease into a deduplication ID: never store or return the credential.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${jobId}:${input.leaseToken}:${input.stage}`));
  const eventId = `progress:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const inserted = await db.$client.prepare(
    `INSERT OR IGNORE INTO research_job_events (id, job_id, event_type, actor_type, actor_id, details_json, created_at)
     SELECT ?, id, 'progress', 'runner', ?, ?, ? FROM research_jobs
     WHERE id = ? AND status = 'running' AND leased_by_runner_id = ? AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(eventId, input.runnerId, JSON.stringify({ stage: input.stage, message: stageMessages[input.stage], attempt: row.attempt_count }),
    now, jobId, input.runnerId, input.leaseToken, Date.now()).run();
  if ((inserted.meta.changes ?? 0) === 0) {
    const existing = await db.$client.prepare("SELECT id FROM research_job_events WHERE id = ?").bind(eventId).first();
    if (!existing) throw new ResearchBridgeError("lease_invalid", "The job lease changed before progress was recorded", 409);
  }
  return { ok: true as const };
}

export async function getAgentDashboard(db: Database, ownerIdentity = "primary-owner") {
  const [jobs, runners, events, settings] = await Promise.all([
    db.$client.prepare(
      `SELECT id, owner_identity, job_type, status, priority, task_input_json, idempotency_key,
       attempt_count, max_attempts, leased_by_runner_id, ranking_snapshot_id, error_code, error_message,
       new_publisher_count, created_at, started_at, completed_at, updated_at,
       CASE WHEN json_valid(result_json) THEN COALESCE(json_array_length(result_json, '$.citations'), 0) ELSE 0 END AS citation_count,
       CASE WHEN json_valid(result_json) THEN COALESCE(json_array_length(result_json, '$.insights'), 0) ELSE 0 END AS insight_count
       FROM research_jobs WHERE owner_identity = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    ).bind(ownerIdentity).all<ResearchJobRow & { citation_count: number; insight_count: number }>(),
    db.$client.prepare(
      `SELECT r.id, r.name, r.provider, r.version, r.status, r.capabilities_json, r.last_seen_at, r.created_at, r.updated_at,
       CASE WHEN EXISTS (SELECT 1 FROM research_jobs current WHERE current.id = r.current_job_id AND current.owner_identity = ?)
            THEN r.current_job_id ELSE NULL END AS current_job_id
       FROM research_runners r WHERE NOT EXISTS (SELECT 1 FROM runner_credentials other WHERE other.runner_id = r.id AND other.owner_identity != ?)
       AND (
       EXISTS (SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id AND c.owner_identity = ?)
       OR EXISTS (SELECT 1 FROM research_jobs j WHERE j.leased_by_runner_id = r.id AND j.owner_identity = ?)
       OR (? = 'primary-owner' AND NOT EXISTS (SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM research_jobs j WHERE j.leased_by_runner_id = r.id AND j.owner_identity != ?)))
       ORDER BY r.last_seen_at DESC, r.id DESC LIMIT 100`,
    ).bind(ownerIdentity, ownerIdentity, ownerIdentity, ownerIdentity, ownerIdentity, ownerIdentity).all<RunnerRow>(),
    db.$client.prepare(
      `SELECT e.id, e.job_id, e.event_type, e.actor_type, e.actor_id, e.details_json, e.created_at
       FROM research_job_events e JOIN research_jobs j ON j.id = e.job_id
       WHERE j.owner_identity = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
    ).bind(ownerIdentity).all<{ id: string; job_id: string; event_type: string; actor_type: string; actor_id: string | null; details_json: string; created_at: number }>(),
    getResearchSettings(db, ownerIdentity),
  ]);
  return {
    jobs: jobs.results.map((row) => {
      const { result: _result, ...job } = toPublicJob({ ...row, result_json: null });
      return { ...job, citationCount: row.citation_count, insightCount: row.insight_count };
    }),
    runners: runners.results.map((row) => toRunner(row)),
    events: events.results.map((event) => ({
      id: event.id, jobId: event.job_id, type: event.event_type, actorType: event.actor_type,
      actorId: event.actor_id, details: safeResearchEventDetails(event.details_json),
      createdAt: new Date(event.created_at).toISOString(),
    })),
    settings,
  };
}
