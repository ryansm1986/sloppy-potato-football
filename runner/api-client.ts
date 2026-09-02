import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunnerConfig } from "./config.js";
import { researchJobSchema, type ResearchResult } from "./schemas.js";

const claimResponseSchema = z.object({ job: researchJobSchema.nullable() }).passthrough();

export type RunnerStatus = "idle" | "busy" | "stopping";
export type Failure = { code: string; message: string; retryable: boolean };

type RequestOptions = {
  idempotencyKey?: string;
  retries?: number;
  signal?: AbortSignal;
};

export class RunnerApiClient {
  constructor(
    private readonly config: RunnerConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async heartbeat(status: RunnerStatus, signal?: AbortSignal): Promise<void> {
    await this.request("/api/runners/heartbeat", {
      runnerId: this.config.runnerId,
      name: this.config.runnerName,
      provider: "codex",
      version: "0.1.0",
      status,
      capabilities: ["source_refresh", "player_research", "rankings_research", "sleepers_research"],
    }, { signal, retries: 2 });
  }

  async claim(signal?: AbortSignal) {
    const value = await this.request("/api/runners/jobs/claim", {
      runnerId: this.config.runnerId,
    }, { signal, retries: 2 });
    return claimResponseSchema.parse(value).job;
  }

  async complete(jobId: string, leaseToken: string, result: ResearchResult): Promise<void> {
    const normalizedResult = {
      summary: result.summary,
      generatedAt: result.generatedAt,
      citations: result.citations.map((citation) => ({
        title: citation.title,
        url: citation.url,
        ...(citation.publisher ? { publisher: citation.publisher } : {}),
        ...(citation.publishedAt ? { publishedAt: citation.publishedAt } : {}),
        ...(citation.accessedAt ? { accessedAt: citation.accessedAt } : {}),
      })),
      insights: result.insights.map((insight) => ({
        subject: insight.subject,
        finding: insight.finding,
        ...(insight.confidence ? { confidence: insight.confidence } : {}),
        citationUrls: insight.citationUrls,
      })),
      ...(result.rankingSnapshot ? { rankingSnapshot: result.rankingSnapshot } : {}),
      ...(result.rankingSnapshots ? { rankingSnapshots: result.rankingSnapshots } : {}),
      ...(result.sleeperReport ? { sleeperReport: result.sleeperReport } : {}),
    };
    await this.request(`/api/runners/jobs/${encodeURIComponent(jobId)}/result`, {
      runnerId: this.config.runnerId,
      leaseToken,
      resultId: `research-job:${jobId}`,
      result: normalizedResult,
    }, { retries: 3, idempotencyKey: `result:${jobId}` });
  }

  async fail(jobId: string, leaseToken: string, error: Failure): Promise<void> {
    await this.request(`/api/runners/jobs/${encodeURIComponent(jobId)}/fail`, {
      runnerId: this.config.runnerId,
      leaseToken,
      error,
    }, { retries: 3, idempotencyKey: `failure:${jobId}:${error.code}` });
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImplementation(`${this.config.apiUrl}/api/health`, { signal });
    if (!response.ok) throw new Error(`Health check failed with HTTP ${response.status}`);
  }

  private async request(path: string, body: unknown, options: RequestOptions): Promise<unknown> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const attempts = (options.retries ?? 0) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timeout = AbortSignal.timeout(this.config.httpTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await this.fetchImplementation(`${this.config.apiUrl}${path}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const message = (await response.text()).slice(0, 1_000);
          const error = new Error(`Runner API ${path} returned HTTP ${response.status}: ${message}`);
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
        } else {
          const text = await response.text();
          return text ? JSON.parse(text) as unknown : {};
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message)) throw error;
      }
      if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 2 ** (attempt - 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("Runner API request failed");
  }
}
