export const RESEARCH_OWNER_TOKEN_KEY = "spff:research-owner-token:v1";

export type ResearchJobType = "source_refresh" | "player_research" | "rankings_research" | "sleepers_research";
export type ResearchJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunnerState = "online" | "busy" | "stale" | "offline";

export type ResearchResult = {
  summary: string;
  generatedAt: string;
  citations: Array<{
    title: string;
    url: string;
    publisher: string | null;
    publishedAt: string | null;
    accessedAt: string | null;
  }>;
  insights: Array<{
    subject: string;
    finding: string;
    confidence: "low" | "medium" | "high" | null;
    citationUrls: string[];
  }>;
};

export type ResearchJob = {
  id: string;
  type: ResearchJobType;
  status: ResearchJobStatus;
  subject: string | null;
  sourceName: string | null;
  scoringFormat: string;
  rankingType: string;
  position: string | null;
  rankingLimit?: number | null;
  leagueSize?: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempts: number;
  error: string | null;
  result?: ResearchResult | null;
};

export type RunnerStatus = {
  state: RunnerState;
  provider: string | null;
  lastSeenAt: string | null;
  currentJobId: string | null;
  jobsToday: number;
  autoRun: boolean;
};

export type RunnerCredential = {
  id: string;
  deviceId: string;
  runnerId: string;
  name: string;
  tokenHint: string;
  metadata: Record<string, string>;
  active: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateResearchJob = {
  type: ResearchJobType;
  subject?: string;
  sourceName?: string;
  scoringFormat: "ppr";
  rankingType: "redraft";
  position?: "ALL" | "QB" | "RB" | "WR" | "TE";
  rankingLimit?: number;
  leagueSize?: number;
  sleepersPerPosition?: number;
  discoverNewSources?: boolean;
};

export type ResearchSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  timeZone: string;
  localTime: string;
  daysOfWeek: number[];
  job: CreateResearchJob;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateResearchSchedule = {
  name: string;
  enabled?: boolean;
  timeZone: string;
  localTime: string;
  daysOfWeek: number[];
  job: CreateResearchJob;
};

export class ResearchApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ResearchApiError";
  }
}

function authHeaders(token: string, includeJson = false): HeadersInit {
  return {
    Accept: "application/json",
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function parseError(response: Response): Promise<ResearchApiError> {
  let message = `Research service returned ${response.status}`;
  try {
    const payload = await response.json() as { error?: string; message?: string };
    message = payload.message ?? payload.error ?? message;
  } catch {
    // An HTML or empty error response still gets a useful status message.
  }
  return new ResearchApiError(message, response.status);
}

export async function fetchResearchJobs(token: string, signal?: AbortSignal, limit = 20): Promise<ResearchJob[]> {
  const response = await fetch(`/api/research/jobs?limit=${Math.min(Math.max(Math.trunc(limit), 1), 100)}`, {
    headers: authHeaders(token),
    signal,
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { jobs?: ResearchJob[] } | ResearchJob[];
  return Array.isArray(payload) ? payload : payload.jobs ?? [];
}

export async function fetchRunnerStatus(token: string, signal?: AbortSignal): Promise<RunnerStatus> {
  const response = await fetch("/api/research/runner/status", {
    headers: authHeaders(token),
    signal,
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { runner?: RunnerStatus; status?: RunnerStatus } | RunnerStatus;
  if ("runner" in payload && payload.runner) return payload.runner;
  if ("status" in payload && typeof payload.status === "object" && payload.status) return payload.status;
  return payload as RunnerStatus;
}

export async function fetchRunnerCredentials(token: string, signal?: AbortSignal): Promise<RunnerCredential[]> {
  const response = await fetch("/api/research/runner-credentials", {
    headers: authHeaders(token),
    signal,
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { credentials?: RunnerCredential[] } | RunnerCredential[];
  return Array.isArray(payload) ? payload : payload.credentials ?? [];
}

export async function revokeRunnerCredential(token: string, credentialId: string): Promise<void> {
  const response = await fetch(`/api/research/runner-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) throw await parseError(response);
}

export async function createResearchJob(token: string, input: CreateResearchJob): Promise<ResearchJob> {
  const response = await fetch("/api/research/jobs", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { job?: ResearchJob } | ResearchJob;
  return "job" in payload && payload.job ? payload.job : payload as ResearchJob;
}

export async function retryResearchJob(token: string, jobId: string): Promise<ResearchJob> {
  const response = await fetch(`/api/research/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: authHeaders(token, true),
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { job?: ResearchJob } | ResearchJob;
  return "job" in payload && payload.job ? payload.job : payload as ResearchJob;
}

export async function fetchResearchSchedules(token: string, signal?: AbortSignal): Promise<ResearchSchedule[]> {
  const response = await fetch("/api/research/schedules", { headers: authHeaders(token), signal });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { schedules?: ResearchSchedule[] } | ResearchSchedule[];
  return Array.isArray(payload) ? payload : payload.schedules ?? [];
}

export async function createResearchSchedule(token: string, input: CreateResearchSchedule): Promise<ResearchSchedule> {
  const response = await fetch("/api/research/schedules", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { schedule?: ResearchSchedule } | ResearchSchedule;
  return "schedule" in payload && payload.schedule ? payload.schedule : payload as ResearchSchedule;
}

export async function updateResearchSchedule(
  token: string,
  scheduleId: string,
  changes: Partial<CreateResearchSchedule>,
): Promise<ResearchSchedule> {
  const response = await fetch(`/api/research/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { schedule?: ResearchSchedule } | ResearchSchedule;
  return "schedule" in payload && payload.schedule ? payload.schedule : payload as ResearchSchedule;
}

export async function deleteResearchSchedule(token: string, scheduleId: string): Promise<void> {
  const response = await fetch(`/api/research/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) throw await parseError(response);
}

export async function runResearchScheduleNow(token: string, scheduleId: string): Promise<ResearchJob> {
  const response = await fetch(`/api/research/schedules/${encodeURIComponent(scheduleId)}/run`, {
    method: "POST",
    headers: authHeaders(token, true),
  });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { job?: ResearchJob } | ResearchJob;
  return "job" in payload && payload.job ? payload.job : payload as ResearchJob;
}

export function isLocalDevelopment(): boolean {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

export function runnerDisplayState(runner: RunnerStatus | null, now = Date.now()): RunnerState {
  if (!runner || runner.state === "offline") return "offline";
  if (runner.lastSeenAt) {
    const lastSeen = Date.parse(runner.lastSeenAt);
    if (Number.isFinite(lastSeen) && now - lastSeen > 60_000) return "stale";
  }
  return runner.state;
}
