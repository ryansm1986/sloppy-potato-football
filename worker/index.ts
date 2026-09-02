import { and, asc, desc, eq, gt, inArray, isNotNull, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
  leagueMembers,
  leagues,
  playerExternalIds,
  players,
  providerSyncs,
  rosters,
  scoringSettings,
} from "./db/schema";
import * as schema from "./db/schema";
import { SleeperApiError, SleeperClient } from "./providers/sleeper/client";
import { ImportInProgressError, importSleeperLeague } from "./services/sleeper-import";
import { syncSleeperPlayerCatalog } from "./services/player-catalog";
import {
  RankingSnapshotError,
  createRankingSnapshot,
  getRankingSnapshots,
  rankingSnapshotInput,
  rankingSnapshotQueryInput,
} from "./services/ranking-snapshots";
import {
  RankingSourceRegistryError,
  getRankingSourceCatalog,
  rankingSourceRegistryInput,
  resolveOrCreateRankingSource,
} from "./services/ranking-sources";
import {
  ResearchBridgeError,
  claimResearchJob,
  claimResearchJobInput,
  completeResearchJob,
  completeResearchJobInput,
  createResearchJob,
  createResearchJobInput,
  failResearchJob,
  failResearchJobInput,
  getResearchJob,
  getRunnerStatus,
  heartbeatRunner,
  listResearchJobs,
  retryResearchJob,
  runnerHeartbeatInput,
} from "./services/research-bridge";
import { getLatestSleeperReport } from "./services/sleeper-reports";
import {
  PersonalRankingError,
  getPersonalRankingBoard,
  personalRankingQueryInput,
  savePersonalRankingBoard,
  savePersonalRankingInput,
} from "./services/personal-rankings";
import {
  ResearchScheduleError,
  createResearchSchedule,
  createResearchScheduleInput,
  deleteResearchSchedule,
  enqueueDueResearchSchedules,
  getResearchSchedule,
  listResearchSchedules,
  runResearchScheduleNow,
  updateResearchSchedule,
  updateResearchScheduleInput,
} from "./services/research-schedules";
import {
  authenticateRunnerCredential,
  enrollRunnerCredential,
  enrollRunnerCredentialInput,
  hasEnrolledRunnerCredentials,
  listRunnerCredentials,
  revokeRunnerCredential,
  RunnerCredentialError,
  secureTokenEqual,
  type AuthenticatedRunnerCredential,
} from "./services/runner-credentials";

type Bindings = {
  DB: D1Database;
  SLEEPER_API_BASE_URL?: string;
  IMPORT_ADMIN_TOKEN?: string;
  RESEARCH_OWNER_TOKEN?: string;
  AGENT_RUNNER_TOKEN?: string;
};

type RunnerAuthorization =
  | ({ kind: "device" } & AuthenticatedRunnerCredential)
  | { kind: "legacy"; credentialId: null; ownerIdentity: "primary-owner"; deviceId: null; name: null };

type Variables = { runnerAuthorization?: RunnerAuthorization };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const sleeperImportInput = z.object({
  leagueId: z.string().trim().regex(/^\d{5,30}$/, "Enter a numeric Sleeper league ID"),
});
const requireImportToken = createMiddleware<{ Bindings: Bindings }>(async (context, next) => {
  const hostname = new URL(context.req.url).hostname;
  const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname);
  const configuredToken = context.env.IMPORT_ADMIN_TOKEN;
  if (!configuredToken && isLocal) return next();
  if (!configuredToken) {
    return context.json(
      { error: "import_auth_not_configured", message: "Imports are disabled until an admin token is configured." },
      503,
    );
  }
  if (context.req.header("Authorization") !== `Bearer ${configuredToken}`) {
    return context.json({ error: "unauthorized", message: "A valid import admin token is required." }, 401);
  }
  return next();
});

function isLocalRequest(url: string) {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(new URL(url).hostname);
}

const requireResearchOwner = createMiddleware<{ Bindings: Bindings }>(async (context, next) => {
  const configuredToken = context.env.RESEARCH_OWNER_TOKEN;
  if (!configuredToken && isLocalRequest(context.req.url)) return next();
  if (!configuredToken) {
    return context.json(
      { error: "research_auth_not_configured", message: "Research jobs are disabled until an owner token is configured." },
      503,
    );
  }
  const supplied = context.req.header("X-Research-Owner-Token")
    ?? context.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (supplied !== configuredToken) {
    return context.json({ error: "unauthorized", message: "A valid research owner token is required." }, 401);
  }
  return next();
});

const requireAgentRunner = createMiddleware<{ Bindings: Bindings; Variables: Variables }>(async (context, next) => {
  const configuredToken = context.env.AGENT_RUNNER_TOKEN;
  if (!configuredToken && isLocalRequest(context.req.url)) return next();
  const supplied = context.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();

  // Keep the original shared secret working during migration. Newly enrolled
  // installations use independently revocable D1-backed credentials instead.
  if (
    configuredToken
    && supplied
    && await secureTokenEqual(supplied, configuredToken)
    && !await hasEnrolledRunnerCredentials(database(context))
  ) {
    context.set("runnerAuthorization", {
      kind: "legacy",
      credentialId: null,
      ownerIdentity: "primary-owner",
      deviceId: null,
      name: null,
    });
    return next();
  }

  if (supplied) {
    const credential = await authenticateRunnerCredential(database(context), supplied);
    if (credential) {
      context.set("runnerAuthorization", { kind: "device", ...credential });
      return next();
    }
    return context.json({ error: "unauthorized", message: "A valid agent runner token is required." }, 401);
  }

  if (!configuredToken && !await hasEnrolledRunnerCredentials(database(context))) {
    return context.json(
      { error: "runner_auth_not_configured", message: "Runner access is disabled until a runner token is configured." },
      503,
    );
  }
  return context.json({ error: "unauthorized", message: "A valid agent runner token is required." }, 401);
});

app.use("/api/imports/*", requireImportToken);
app.use("/api/leagues/:leagueId/sync", requireImportToken);
app.use("/api/research/*", requireResearchOwner);
app.use("/api/runners/*", requireAgentRunner);

function database(context: { env: Bindings }) {
  return drizzle(context.env.DB, { schema });
}

function runnerIdentityMismatch(
  context: { get(key: "runnerAuthorization"): RunnerAuthorization | undefined },
  runnerId: string,
) {
  const authorization = context.get("runnerAuthorization");
  return authorization?.kind === "device" && authorization.runnerId !== runnerId;
}

type PlayerCursor = { searchName: string; id: string };

function encodePlayerCursor(cursor: PlayerCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodePlayerCursor(value: string): PlayerCursor | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as unknown;
    if (
      typeof decoded !== "object" || decoded === null
      || !("searchName" in decoded) || typeof decoded.searchName !== "string"
      || !("id" in decoded) || typeof decoded.id !== "string" || !decoded.id
    ) return null;
    return { searchName: decoded.searchName, id: decoded.id };
  } catch {
    return null;
  }
}

app.get("/api/health", async (context) => {
  const databaseResult = await context.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return context.json({
    app: "Sloppy Potato Fantasy Football",
    status: databaseResult?.ok === 1 ? "ok" : "degraded",
    database: databaseResult?.ok === 1 ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

// Reports are safe to share with the small friend group. Only the separate
// /api/research queue can activate the owner's runner.
app.get("/api/sleepers/latest", async (context) => {
  return context.json({ report: await getLatestSleeperReport(database(context)) });
});

app.post("/api/imports/sleeper", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = sleeperImportInput.safeParse(body);
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid request" },
      400,
    );
  }

  const client = new SleeperClient(context.env.SLEEPER_API_BASE_URL);
  const result = await importSleeperLeague(database(context), client, input.data.leagueId);
  return context.json(result, 200);
});

app.post("/api/leagues/:leagueId/sync", async (context) => {
  const db = database(context);
  const canonicalLeague = await db
    .select({ externalId: leagues.externalId, provider: leagues.provider })
    .from(leagues)
    .where(eq(leagues.id, context.req.param("leagueId")))
    .limit(1);
  if (!canonicalLeague[0]) {
    return context.json({ error: "not_found", message: "League not found" }, 404);
  }
  if (canonicalLeague[0].provider !== "sleeper") {
    return context.json({ error: "unsupported_provider", message: "Only Sleeper sync is available" }, 409);
  }

  const client = new SleeperClient(context.env.SLEEPER_API_BASE_URL);
  const result = await importSleeperLeague(db, client, canonicalLeague[0].externalId);
  return context.json(result);
});

app.get("/api/leagues/:leagueId", async (context) => {
  const db = database(context);
  const leagueId = context.req.param("leagueId");
  const league = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!league[0]) {
    return context.json({ error: "not_found", message: "League not found" }, 404);
  }

  const [members, leagueRosters, scoring, latestSync] = await Promise.all([
    db
      .select()
      .from(leagueMembers)
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.isActive, true)))
      .orderBy(asc(leagueMembers.displayName)),
    db.select().from(rosters).where(eq(rosters.leagueId, leagueId)),
    db.select().from(scoringSettings).where(eq(scoringSettings.leagueId, leagueId)),
    db
      .select()
      .from(providerSyncs)
      .where(eq(providerSyncs.leagueId, leagueId))
      .orderBy(desc(providerSyncs.startedAt))
      .limit(1),
  ]);

  return context.json({
    ...league[0],
    rosterPositions: JSON.parse(league[0].rosterPositionsJson),
    settings: JSON.parse(league[0].settingsJson),
    members,
    rosters: leagueRosters,
    scoringSettings: Object.fromEntries(scoring.map((row) => [row.key, row.value])),
    latestSync: latestSync[0] ?? null,
  });
});

app.post("/api/players/sync", requireResearchOwner, async (context) => {
  const client = new SleeperClient(context.env.SLEEPER_API_BASE_URL);
  return context.json(await syncSleeperPlayerCatalog(database(context), client));
});

app.get("/api/players", async (context) => {
  const db = database(context);
  const query = context.req.query("query")?.trim().toLowerCase() ?? "";
  const position = context.req.query("position")?.trim().toUpperCase();
  const fantasy = context.req.query("fantasy") === "true";
  const requestedLimit = Number(context.req.query("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 100;
  const cursorValue = context.req.query("cursor")?.trim() || context.req.query("after")?.trim();
  const cursor = cursorValue ? decodePlayerCursor(cursorValue) : null;
  if (cursorValue && !cursor) {
    return context.json({ error: "invalid_request", message: "Invalid player pagination cursor" }, 400);
  }
  const conditions = [];
  if (query) {
    conditions.push(
      or(
        like(players.fullName, `%${query}%`),
        like(players.searchName, `%${query.replace(/[^a-z0-9]/g, "")}%`),
      )!,
    );
  }
  if (position) conditions.push(eq(players.position, position));
  if (fantasy) {
    conditions.push(
      and(
        eq(players.sport, "nfl"),
        isNotNull(players.nflTeam),
        or(
          inArray(players.position, ["QB", "RB", "WR", "TE", "K", "DEF", "DST"]),
          eq(players.isTeamDefense, true),
        )!,
      )!,
    );
  }
  if (cursor) {
    conditions.push(or(
      gt(players.searchName, cursor.searchName),
      and(eq(players.searchName, cursor.searchName), gt(players.id, cursor.id)),
    )!);
  }

  const rows = await db
    .select()
    .from(players)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(players.searchName), asc(players.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last
    ? encodePlayerCursor({ searchName: last.searchName, id: last.id })
    : null;

  return context.json({
    players: page.map((player) => ({
      ...player,
      fantasyPositions: JSON.parse(player.fantasyPositionsJson),
    })),
    nextCursor,
    nextAfter: nextCursor,
    pagination: { limit, hasMore, nextCursor },
  });
});

app.get("/api/players/:playerId", async (context) => {
  const db = database(context);
  const player = await db
    .select()
    .from(players)
    .where(eq(players.id, context.req.param("playerId")))
    .limit(1);
  if (!player[0]) {
    return context.json({ error: "not_found", message: "Player not found" }, 404);
  }
  const externalIds = await db
    .select()
    .from(playerExternalIds)
    .where(eq(playerExternalIds.playerId, player[0].id));
  return context.json({
    ...player[0],
    fantasyPositions: JSON.parse(player[0].fantasyPositionsJson),
    externalIds,
  });
});

app.get("/api/rankings/snapshots", async (context) => {
  const requestedLimit = Number(context.req.query("limit") ?? 5);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 5;
  const weekValue = context.req.query("week");
  const leagueSizeValue = context.req.query("leagueSize");
  const latestPerSourceValue = context.req.query("latestPerSource");
  const query = rankingSnapshotQueryInput.safeParse({
    scoringFormat: context.req.query("scoringFormat"),
    rankingType: context.req.query("rankingType"),
    season: context.req.query("season"),
    week: weekValue === undefined ? undefined : weekValue === "null" ? null : Number(weekValue),
    position: context.req.query("position"),
    leagueSize: leagueSizeValue === undefined ? undefined : Number(leagueSizeValue),
    source: context.req.query("source"),
    latestPerSource: latestPerSourceValue === undefined
      ? undefined
      : latestPerSourceValue === "true" ? true : latestPerSourceValue === "false" ? false : latestPerSourceValue,
  });
  if (!query.success) {
    return context.json(
      { error: "invalid_request", message: query.error.issues[0]?.message ?? "Invalid ranking snapshot filters" },
      400,
    );
  }
  return context.json({ snapshots: await getRankingSnapshots(database(context), limit, query.data) });
});

app.get("/api/rankings/sources", async (context) => {
  const requestedLimit = Number(context.req.query("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 100;
  const after = context.req.query("after")?.trim().toLowerCase();
  return context.json(await getRankingSourceCatalog(database(context), { limit, after }));
});

app.post("/api/rankings/sources/resolve", requireImportToken, async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = rankingSourceRegistryInput.safeParse(body);
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid ranking source" },
      400,
    );
  }
  const result = await resolveOrCreateRankingSource(database(context), input.data);
  return context.json(result, result.created ? 201 : 200);
});

app.post("/api/rankings/snapshots", requireImportToken, async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = rankingSnapshotInput.safeParse(body);
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid ranking snapshot" },
      400,
    );
  }
  const result = await createRankingSnapshot(database(context), input.data);
  return context.json(result, result.created ? 201 : 200);
});

app.post("/api/research/jobs", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = createResearchJobInput.safeParse(body);
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid research job" },
      400,
    );
  }
  const suppliedIdempotencyKey = context.req.header("Idempotency-Key")?.trim();
  if (suppliedIdempotencyKey && !/^[A-Za-z0-9._:-]{3,128}$/.test(suppliedIdempotencyKey)) {
    return context.json({ error: "invalid_request", message: "Invalid Idempotency-Key header" }, 400);
  }
  const result = await createResearchJob(
    database(context),
    input.data,
    suppliedIdempotencyKey ?? crypto.randomUUID(),
  );
  return context.json({ job: result.job }, result.created ? 201 : 200);
});

app.get("/api/research/jobs", async (context) => {
  const requestedLimit = Number(context.req.query("limit") ?? 20);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 20;
  return context.json({ jobs: await listResearchJobs(database(context), limit) });
});

app.get("/api/research/jobs/:jobId", async (context) => {
  return context.json(await getResearchJob(database(context), context.req.param("jobId")));
});

app.post("/api/research/jobs/:jobId/retry", async (context) => {
  return context.json({ job: await retryResearchJob(database(context), context.req.param("jobId")) });
});

app.get("/api/research/runner/status", async (context) => {
  return context.json({ runner: await getRunnerStatus(database(context)) });
});

app.post("/api/research/runner-credentials", async (context) => {
  const input = enrollRunnerCredentialInput.safeParse(await context.req.json().catch(() => null));
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid runner credential" },
      400,
    );
  }
  const result = await enrollRunnerCredential(database(context), input.data);
  context.header("Cache-Control", "no-store");
  return context.json(
    { credential: result.credential, token: result.token },
    result.created ? 201 : 200,
  );
});

app.get("/api/research/runner-credentials", async (context) => {
  context.header("Cache-Control", "no-store");
  return context.json({ credentials: await listRunnerCredentials(database(context)) });
});

app.delete("/api/research/runner-credentials/:credentialId", async (context) => {
  await revokeRunnerCredential(database(context), context.req.param("credentialId"));
  return context.body(null, 204);
});

app.get("/api/research/personal-rankings", async (context) => {
  const input = personalRankingQueryInput.safeParse({
    season: context.req.query("season"),
    scoringFormat: context.req.query("scoringFormat"),
    rankingType: context.req.query("rankingType"),
  });
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid personal ranking scope" },
      400,
    );
  }
  return context.json({ board: await getPersonalRankingBoard(database(context), input.data) });
});

app.put("/api/research/personal-rankings", async (context) => {
  const input = savePersonalRankingInput.safeParse(await context.req.json().catch(() => null));
  if (!input.success) {
    return context.json(
      { error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid personal rankings" },
      400,
    );
  }
  return context.json(await savePersonalRankingBoard(database(context), input.data));
});

app.post("/api/research/schedules", async (context) => {
  const input = createResearchScheduleInput.safeParse(await context.req.json().catch(() => null));
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid research schedule" }, 400);
  }
  return context.json({ schedule: await createResearchSchedule(database(context), input.data) }, 201);
});

app.get("/api/research/schedules", async (context) => {
  return context.json({ schedules: await listResearchSchedules(database(context)) });
});

app.get("/api/research/schedules/:scheduleId", async (context) => {
  return context.json({ schedule: await getResearchSchedule(database(context), context.req.param("scheduleId")) });
});

app.patch("/api/research/schedules/:scheduleId", async (context) => {
  const input = updateResearchScheduleInput.safeParse(await context.req.json().catch(() => null));
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid schedule update" }, 400);
  }
  return context.json({
    schedule: await updateResearchSchedule(database(context), context.req.param("scheduleId"), input.data),
  });
});

app.delete("/api/research/schedules/:scheduleId", async (context) => {
  await deleteResearchSchedule(database(context), context.req.param("scheduleId"));
  return context.body(null, 204);
});

app.post("/api/research/schedules/:scheduleId/run", async (context) => {
  return context.json(await runResearchScheduleNow(database(context), context.req.param("scheduleId")), 201);
});

app.post("/api/runners/heartbeat", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = runnerHeartbeatInput.safeParse(body);
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid runner heartbeat" }, 400);
  }
  if (runnerIdentityMismatch(context, input.data.runnerId)) {
    return context.json({ error: "runner_identity_mismatch", message: "This credential belongs to another runner." }, 403);
  }
  return context.json({ runner: await heartbeatRunner(database(context), input.data) });
});

app.post("/api/runners/jobs/claim", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = claimResearchJobInput.safeParse(body);
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid job claim" }, 400);
  }
  if (runnerIdentityMismatch(context, input.data.runnerId)) {
    return context.json({ error: "runner_identity_mismatch", message: "This credential belongs to another runner." }, 403);
  }
  return context.json({ job: await claimResearchJob(database(context), input.data.runnerId) });
});

app.post("/api/runners/jobs/:jobId/result", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = completeResearchJobInput.safeParse(body);
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid research result" }, 400);
  }
  if (runnerIdentityMismatch(context, input.data.runnerId)) {
    return context.json({ error: "runner_identity_mismatch", message: "This credential belongs to another runner." }, 403);
  }
  return context.json(await completeResearchJob(database(context), context.req.param("jobId"), input.data));
});

app.post("/api/runners/jobs/:jobId/fail", async (context) => {
  const body = await context.req.json().catch(() => null);
  const input = failResearchJobInput.safeParse(body);
  if (!input.success) {
    return context.json({ error: "invalid_request", message: input.error.issues[0]?.message ?? "Invalid research failure" }, 400);
  }
  if (runnerIdentityMismatch(context, input.data.runnerId)) {
    return context.json({ error: "runner_identity_mismatch", message: "This credential belongs to another runner." }, 403);
  }
  return context.json({ job: await failResearchJob(database(context), context.req.param("jobId"), input.data) });
});

app.onError((error, context) => {
  console.error("request_failed", {
    path: context.req.path,
    error: error instanceof Error ? error.message : String(error),
  });

  if (error instanceof SleeperApiError) {
    const status = error.status === 404 ? 404 : 502;
    return context.json(
      {
        error: error.code,
        message:
          error.status === 404
            ? "Sleeper league not found. Check the league ID and visibility."
            : "Sleeper is temporarily unavailable or returned unexpected data.",
        upstreamStatus: error.status ?? null,
      },
      status,
    );
  }

  if (error instanceof ImportInProgressError) {
    return context.json(
      { error: error.code, message: "Another import is running. Try again shortly." },
      409,
    );
  }

  if (error instanceof RankingSnapshotError) {
    return context.json(
      { error: error.code, message: error.message },
      error.code === "snapshot_conflict" ? 409 : 422,
    );
  }

  if (error instanceof RankingSourceRegistryError) {
    return context.json({ error: error.code, message: error.message }, 409);
  }

  if (error instanceof ResearchBridgeError) {
    return context.json({ error: error.code, message: error.message }, error.status);
  }

  if (error instanceof ResearchScheduleError) {
    return context.json({ error: error.code, message: error.message }, error.status);
  }

  if (error instanceof PersonalRankingError) {
    return context.json({ error: error.code, message: error.message }, error.status);
  }

  if (error instanceof RunnerCredentialError) {
    return context.json({ error: error.code, message: error.message }, error.status);
  }

  if (error instanceof z.ZodError) {
    return context.json(
      { error: "invalid_result", message: error.issues[0]?.message ?? "The runner returned an invalid result" },
      422,
    );
  }

  return context.json(
    { error: "internal_error", message: "The request could not be completed" },
    500,
  );
});

app.notFound((context) => context.json({ error: "not_found", message: "Route not found" }, 404));

export async function scheduled(_controller: ScheduledController, env: Bindings, context: ExecutionContext) {
  context.waitUntil(enqueueDueResearchSchedules(drizzle(env.DB, { schema })));
}

export default Object.assign(app, { scheduled });
