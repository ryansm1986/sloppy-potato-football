import type { ZodType } from "zod";
import {
  sleeperDraftPickSchema,
  sleeperDraftSchema,
  sleeperLeagueMemberSchema,
  sleeperLeagueSchema,
  sleeperPlayerMapSchema,
  sleeperRosterSchema,
  type SleeperDraft,
  type SleeperDraftPick,
  type SleeperLeague,
  type SleeperLeagueMember,
  type SleeperPlayerMap,
  type SleeperRoster,
} from "./types";
import { z } from "zod";

export const DEFAULT_SLEEPER_API_BASE_URL = "https://api.sleeper.app/v1";

export class SleeperApiError extends Error {
  constructor(
    message: string,
    readonly code: "upstream_http" | "invalid_response" | "network_error",
    readonly status?: number,
  ) {
    super(message);
    this.name = "SleeperApiError";
  }
}

type Fetcher = typeof fetch;

// Cloudflare's native fetch requires its global `this` binding. Wrapping it also
// keeps the default path easy to replace in tests without passing an unbound host
// function through the client.
const defaultFetcher: Fetcher = (input, init) => globalThis.fetch(input, init);

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class SleeperClient {
  constructor(
    private readonly baseUrl = DEFAULT_SLEEPER_API_BASE_URL,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {}

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.get(`/league/${encodeURIComponent(leagueId)}`, sleeperLeagueSchema);
  }

  getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/rosters`, z.array(sleeperRosterSchema));
  }

  getLeagueMembers(leagueId: string): Promise<SleeperLeagueMember[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/users`, z.array(sleeperLeagueMemberSchema));
  }

  getDrafts(leagueId: string): Promise<SleeperDraft[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/drafts`, z.array(sleeperDraftSchema));
  }

  getDraftPicks(draftId: string): Promise<SleeperDraftPick[]> {
    return this.get(`/draft/${encodeURIComponent(draftId)}/picks`, z.array(sleeperDraftPickSchema));
  }

  getActiveNflPlayers(): Promise<SleeperPlayerMap> {
    return this.get("/players/nfl?active=true", sleeperPlayerMapSchema);
  }

  private async get<T>(path: string, schema: ZodType<T>): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;

      try {
        response = await this.fetcher(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (attempt < 2) {
          await wait(200 * 2 ** attempt);
          continue;
        }
        throw new SleeperApiError(
          `Sleeper request failed: ${error instanceof Error ? error.message : "network error"}`,
          "network_error",
        );
      }

      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        throw new SleeperApiError(
          `Sleeper returned HTTP ${response.status} for ${path}`,
          "upstream_http",
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SleeperApiError(
          `Sleeper returned invalid JSON for ${path}`,
          "invalid_response",
        );
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new SleeperApiError(
          `Sleeper returned an unexpected payload for ${path}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
          "invalid_response",
        );
      }

      return parsed.data;
    }

    throw new SleeperApiError("Sleeper request exhausted retries", "network_error");
  }
}
