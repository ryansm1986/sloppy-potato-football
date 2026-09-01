import { and, asc, desc, eq, like, or } from "drizzle-orm";
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
import {
  RankingSnapshotError,
  createRankingSnapshot,
  getRankingSnapshots,
  rankingSnapshotInput,
} from "./services/ranking-snapshots";
import {
  RankingSourceRegistryError,
  getRankingSourceCatalog,
  rankingSourceRegistryInput,
  resolveOrCreateRankingSource,
} from "./services/ranking-sources";

type Bindings = {
  DB: D1Database;
  SLEEPER_API_BASE_URL?: string;
  IMPORT_ADMIN_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
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

app.use("/api/imports/*", requireImportToken);
app.use("/api/leagues/:leagueId/sync", requireImportToken);

function database(context: { env: Bindings }) {
  return drizzle(context.env.DB, { schema });
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

app.get("/api/players", async (context) => {
  const db = database(context);
  const query = context.req.query("query")?.trim().toLowerCase() ?? "";
  const position = context.req.query("position")?.trim().toUpperCase();
  const requestedLimit = Number(context.req.query("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
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

  const rows = await db
    .select()
    .from(players)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(players.fullName))
    .limit(limit);

  return context.json({
    players: rows.map((player) => ({
      ...player,
      fantasyPositions: JSON.parse(player.fantasyPositionsJson),
    })),
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
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 20)
    : 5;
  return context.json({ snapshots: await getRankingSnapshots(database(context), limit) });
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

  return context.json(
    { error: "internal_error", message: "The request could not be completed" },
    500,
  );
});

app.notFound((context) => context.json({ error: "not_found", message: "Route not found" }, 404));

export default app;
