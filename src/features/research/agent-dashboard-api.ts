import { apiFetch } from "../auth/auth-api";
import { ResearchApiError, type ResearchJob } from "./research-api";

export type AgentResearchSettings = {
  focus: "balanced" | "injuries" | "usage" | "draft_value";
  detail: "concise" | "standard" | "thorough";
  recencyDays: 7 | 30 | 90;
  sourceTarget: number;
};
export const DEFAULT_AGENT_SETTINGS: AgentResearchSettings = { focus: "balanced", detail: "standard", recencyDays: 30, sourceTarget: 3 };
export type AgentJob = ResearchJob & {
  runnerId?: string | null;
  maxAttempts?: number;
  errorCode?: string | null;
  researchSettings?: AgentResearchSettings | null;
  citationCount?: number;
  insightCount?: number;
};
export type AgentEvent = { id: string; jobId: string; type: string; actorType: string; actorId: string | null; details: Record<string, unknown>; createdAt: string };
export type AgentDevice = { id: string; name: string; provider: string; version: string | null; state: string; currentJobId: string | null; lastSeenAt: string | null; capabilities: string[] };
export type AgentDashboard = { jobs: AgentJob[]; runners: AgentDevice[]; events: AgentEvent[]; settings: AgentResearchSettings };

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, { ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new ResearchApiError(payload.message ?? payload.error ?? `Agent dashboard returned ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}
export const fetchAgentDashboard = (token: string, signal?: AbortSignal) => request<AgentDashboard>("/api/research/agents/dashboard", token, { signal });
export const fetchAgentEvents = (token: string, id: string, signal?: AbortSignal) => request<{ events: AgentEvent[] }>(`/api/research/agents/jobs/${encodeURIComponent(id)}/events`, token, { signal });
export const saveAgentSettings = (token: string, settings: AgentResearchSettings) => request<{ settings: AgentResearchSettings }>("/api/research/agents/settings", token, { method: "PUT", body: JSON.stringify(settings) });
export async function fetchAgentJob(token: string, id: string, signal?: AbortSignal): Promise<AgentJob> {
  const result = await request<{ job: AgentJob }>(`/api/research/jobs/${encodeURIComponent(id)}`, token, { signal });
  return result.job;
}
