import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";
import { createResearchJob, createResearchJobInput } from "./research-bridge";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };
type ResearchJobInput = z.infer<typeof createResearchJobInput>;

const scheduleName = z.string().trim().min(1).max(100);
const localTime = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).refine(
  (value) => Number(value.slice(3)) % 15 === 0,
  "Schedule time must be on a 15-minute boundary",
);
const daysOfWeek = z.array(z.number().int().min(0).max(6)).min(1).max(7)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));
const timeZone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid IANA time zone");

export const createResearchScheduleInput = z.object({
  name: scheduleName,
  enabled: z.boolean().optional().default(true),
  timeZone,
  localTime,
  daysOfWeek: daysOfWeek.optional().default([0, 1, 2, 3, 4, 5, 6]),
  job: createResearchJobInput,
}).strict();

export const updateResearchScheduleInput = z.object({
  name: scheduleName.optional(),
  enabled: z.boolean().optional(),
  timeZone: timeZone.optional(),
  localTime: localTime.optional(),
  daysOfWeek: daysOfWeek.optional(),
  job: createResearchJobInput.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one schedule change");

type ScheduleRow = {
  id: string;
  owner_identity: string;
  name: string;
  enabled: number;
  timezone: string;
  local_time: string;
  days_of_week_json: string;
  job_type: ResearchJobInput["type"];
  task_input_json: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_job_id: string | null;
  created_at: number;
  updated_at: number;
};

export class ResearchScheduleError extends Error {
  constructor(
    readonly code: "not_found" | "schedule_time_unavailable",
    message: string,
    readonly status: 404 | 422,
  ) {
    super(message);
    this.name = "ResearchScheduleError";
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function toPublicSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    timeZone: row.timezone,
    localTime: row.local_time,
    daysOfWeek: parseJson<number[]>(row.days_of_week_json, []),
    job: parseJson<ResearchJobInput>(row.task_input_json, {} as ResearchJobInput),
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    lastJobId: row.last_job_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const localPartFormatters = new Map<string, Intl.DateTimeFormat>();

function partsAt(value: number, zone: string): LocalParts {
  let formatter = localPartFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    });
    localPartFormatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: weekdayMap[parts.weekday]!,
  };
}

function addLocalDays(parts: LocalParts, days: number): Pick<LocalParts, "year" | "month" | "day" | "weekday"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function localOccurrence(
  date: Pick<LocalParts, "year" | "month" | "day">,
  hour: number,
  minute: number,
  zone: string,
): number | null {
  const requestedAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const minuteMs = 60_000;
  const offsetAt = (timestamp: number) => {
    const observed = partsAt(timestamp, zone);
    return Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute)
      - Math.floor(timestamp / minuteMs) * minuteMs;
  };
  const probes = [-36, 0, 36].map((hours) => {
    const timestamp = requestedAsUtc + hours * 60 * minuteMs;
    return { timestamp, offset: offsetAt(timestamp) };
  });
  const offsets = [...new Set(probes.map((probe) => probe.offset))];
  const exact = offsets.map((offset) => requestedAsUtc - offset).filter((timestamp) => {
    const candidate = partsAt(timestamp, zone);
    return candidate.year === date.year && candidate.month === date.month && candidate.day === date.day
      && candidate.hour === hour && candidate.minute === minute;
  });
  // A fall-back local time occurs twice. Run it once, at its first occurrence.
  if (exact.length) return Math.min(...exact);

  // A spring-forward local time does not exist. Locate the offset transition
  // with a bounded binary search and use its first valid local minute. This is
  // at most ~15 Intl calls instead of scanning hundreds of minutes, keeping a
  // free-tier cron tick comfortably small.
  const requestedMinute = hour * 60 + minute;
  const gapCandidates: { localMinute: number; timestamp: number }[] = [];
  for (let index = 1; index < probes.length; index += 1) {
    const previous = probes[index - 1]!;
    const current = probes[index]!;
    if (previous.offset === current.offset) continue;
    let low = previous.timestamp;
    let high = current.timestamp;
    const lowOffset = previous.offset;
    while (high - low > minuteMs) {
      const midpoint = Math.floor((low + high) / (2 * minuteMs)) * minuteMs;
      if (offsetAt(midpoint) === lowOffset) low = midpoint;
      else high = midpoint;
    }
    const transition = Math.ceil(high / minuteMs) * minuteMs;
    const candidate = partsAt(transition, zone);
    const candidateMinute = candidate.hour * 60 + candidate.minute;
    if (candidate.year === date.year && candidate.month === date.month && candidate.day === date.day
      && candidateMinute >= requestedMinute) {
      gapCandidates.push({ localMinute: candidateMinute, timestamp: transition });
    }
  }
  gapCandidates.sort((left, right) => left.localMinute - right.localMinute || left.timestamp - right.timestamp);
  return gapCandidates[0]?.timestamp ?? null;
}

export function nextResearchScheduleRun(
  schedule: { timeZone: string; localTime: string; daysOfWeek: number[] },
  after: number,
): number {
  const [hour, minute] = schedule.localTime.split(":").map(Number) as [number, number];
  const localNow = partsAt(after, schedule.timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addLocalDays(localNow, offset);
    if (!schedule.daysOfWeek.includes(date.weekday)) continue;
    const occurrence = localOccurrence(date, hour, minute, schedule.timeZone);
    if (occurrence !== null && occurrence > after) return occurrence;
  }
  throw new ResearchScheduleError("schedule_time_unavailable", "Could not calculate the next schedule occurrence", 422);
}

async function findSchedule(db: Database, id: string, ownerIdentity?: string) {
  const sql = ownerIdentity
    ? "SELECT * FROM research_schedules WHERE id = ? AND owner_identity = ?"
    : "SELECT * FROM research_schedules WHERE id = ?";
  const statement = db.$client.prepare(sql);
  return (ownerIdentity ? statement.bind(id, ownerIdentity) : statement.bind(id)).first<ScheduleRow>();
}

export async function createResearchSchedule(
  db: Database,
  input: z.infer<typeof createResearchScheduleInput>,
  ownerIdentity = "primary-owner",
  now = Date.now(),
) {
  const id = crypto.randomUUID();
  const nextRunAt = nextResearchScheduleRun(input, now);
  await db.$client.prepare(
    `INSERT INTO research_schedules
      (id, owner_identity, name, enabled, timezone, local_time, days_of_week_json,
       job_type, task_input_json, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, ownerIdentity, input.name, input.enabled ? 1 : 0, input.timeZone, input.localTime,
    JSON.stringify(input.daysOfWeek), input.job.type, JSON.stringify(input.job), nextRunAt, now, now,
  ).run();
  return toPublicSchedule((await findSchedule(db, id))!);
}

export async function listResearchSchedules(db: Database, ownerIdentity = "primary-owner") {
  const rows = await db.$client.prepare(
    "SELECT * FROM research_schedules WHERE owner_identity = ? ORDER BY created_at, id",
  ).bind(ownerIdentity).all<ScheduleRow>();
  return rows.results.map(toPublicSchedule);
}

export async function getResearchSchedule(db: Database, id: string, ownerIdentity = "primary-owner") {
  const row = await findSchedule(db, id, ownerIdentity);
  if (!row) throw new ResearchScheduleError("not_found", "Research schedule not found", 404);
  return toPublicSchedule(row);
}

export async function updateResearchSchedule(
  db: Database,
  id: string,
  changes: z.infer<typeof updateResearchScheduleInput>,
  ownerIdentity = "primary-owner",
  now = Date.now(),
) {
  const existing = await findSchedule(db, id, ownerIdentity);
  if (!existing) throw new ResearchScheduleError("not_found", "Research schedule not found", 404);
  const next = {
    name: changes.name ?? existing.name,
    enabled: changes.enabled ?? existing.enabled === 1,
    timeZone: changes.timeZone ?? existing.timezone,
    localTime: changes.localTime ?? existing.local_time,
    daysOfWeek: changes.daysOfWeek ?? parseJson<number[]>(existing.days_of_week_json, []),
    job: changes.job ?? parseJson<ResearchJobInput>(existing.task_input_json, {} as ResearchJobInput),
  };
  const nextRunAt = nextResearchScheduleRun(next, now);
  await db.$client.prepare(
    `UPDATE research_schedules SET name = ?, enabled = ?, timezone = ?, local_time = ?,
       days_of_week_json = ?, job_type = ?, task_input_json = ?, next_run_at = ?, updated_at = ?
     WHERE id = ? AND owner_identity = ?`,
  ).bind(
    next.name, next.enabled ? 1 : 0, next.timeZone, next.localTime, JSON.stringify(next.daysOfWeek),
    next.job.type, JSON.stringify(next.job), nextRunAt, now, id, ownerIdentity,
  ).run();
  return toPublicSchedule((await findSchedule(db, id, ownerIdentity))!);
}

export async function deleteResearchSchedule(db: Database, id: string, ownerIdentity = "primary-owner") {
  const result = await db.$client.prepare(
    "DELETE FROM research_schedules WHERE id = ? AND owner_identity = ?",
  ).bind(id, ownerIdentity).run();
  if ((result.meta.changes ?? 0) === 0) throw new ResearchScheduleError("not_found", "Research schedule not found", 404);
}

async function enqueueScheduleOccurrence(db: Database, row: ScheduleRow, scheduledFor: number, runType: "scheduled" | "manual") {
  const input = createResearchJobInput.parse(parseJson(row.task_input_json, null));
  const idempotencyKey = runType === "scheduled"
    ? `schedule:${row.id}:${scheduledFor}`
    : `schedule:${row.id}:manual:${crypto.randomUUID()}`;
  const result = await createResearchJob(db, input, idempotencyKey, row.owner_identity);
  await db.$client.prepare(
    `INSERT OR IGNORE INTO research_schedule_runs
      (id, schedule_id, scheduled_for, run_type, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), row.id, scheduledFor, runType, result.job.id, Date.now()).run();
  return result;
}

export async function runResearchScheduleNow(
  db: Database,
  id: string,
  ownerIdentity = "primary-owner",
  now = Date.now(),
) {
  const row = await findSchedule(db, id, ownerIdentity);
  if (!row) throw new ResearchScheduleError("not_found", "Research schedule not found", 404);
  const { job } = await enqueueScheduleOccurrence(db, row, now, "manual");
  await db.$client.prepare(
    "UPDATE research_schedules SET last_run_at = ?, last_job_id = ?, updated_at = ? WHERE id = ? AND owner_identity = ?",
  ).bind(now, job.id, now, id, ownerIdentity).run();
  return { schedule: toPublicSchedule((await findSchedule(db, id, ownerIdentity))!), job };
}

export async function enqueueDueResearchSchedules(db: Database, now = Date.now()) {
  const due = await db.$client.prepare(
    `SELECT * FROM research_schedules
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at, id LIMIT 50`,
  ).bind(now).all<ScheduleRow>();
  let enqueued = 0;
  for (const row of due.results) {
    const scheduledFor = row.next_run_at!;
    const result = await enqueueScheduleOccurrence(db, row, scheduledFor, "scheduled");
    // Calculate from now to coalesce missed ticks into one queued job. The job
    // itself stays queued until the owner's desktop runner comes back online.
    const nextRunAt = nextResearchScheduleRun({
      timeZone: row.timezone,
      localTime: row.local_time,
      daysOfWeek: parseJson<number[]>(row.days_of_week_json, []),
    }, now);
    const updated = await db.$client.prepare(
      `UPDATE research_schedules SET next_run_at = ?, last_run_at = ?, last_job_id = ?, updated_at = ?
       WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
    ).bind(nextRunAt, now, result.job.id, now, row.id, scheduledFor).run();
    if ((updated.meta.changes ?? 0) > 0 && result.created) enqueued += 1;
  }
  return { checked: due.results.length, enqueued };
}
