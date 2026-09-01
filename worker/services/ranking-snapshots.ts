import { and, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import {
  rankingSnapshotEntries,
  rankingSnapshots,
  rankingSources,
} from "../db/schema";
import * as schema from "../db/schema";
import {
  rankingSourceRegistryInput,
  resolveOrCreateRankingSource,
} from "./ranking-sources";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

const sourceInput = z.object({
  canonicalKey: z.string().trim().toLowerCase().min(2).max(128)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/).optional(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["agent", "import", "derived", "external", "custom"]),
  provider: z.string().trim().max(50).nullish(),
  attributionUrl: z.string().url().nullish(),
  aliases: z.array(z.object({
    type: z.enum(["slug", "name", "url", "domain", "external", "custom"]),
    value: z.string().trim().min(1).max(500),
  })).max(50).optional().default([]),
  provenance: z.record(z.string(), z.unknown()).optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

const entryInput = z.object({
  playerId: z.string().trim().min(1).max(100).nullish(),
  externalPlayerId: z.string().trim().max(100).nullish(),
  playerName: z.string().trim().min(2).max(120),
  position: z.string().trim().toUpperCase().max(10).nullish(),
  team: z.string().trim().toUpperCase().max(5).nullish(),
  rank: z.number().int().positive().max(500),
  previousRank: z.number().int().positive().max(500).nullish(),
  tier: z.number().int().positive().max(100).nullish(),
  insight: z.string().trim().max(600).nullish(),
});

export const rankingSnapshotInput = z.object({
  source: sourceInput,
  externalRunId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(3).max(140),
  scoringFormat: z.enum(["ppr", "half_ppr", "standard"]),
  rankingType: z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]),
  season: z.string().regex(/^20\d{2}$/),
  week: z.number().int().min(1).max(25).nullish(),
  generatedAt: z.string().datetime(),
  summary: z.string().trim().max(1_500).nullish(),
  methodology: z.string().trim().max(2_000).nullish(),
  entries: z.array(entryInput).min(1).max(500),
}).superRefine((value, context) => {
  if (value.source.kind === "agent" && !value.externalRunId) {
    context.addIssue({ code: "custom", path: ["externalRunId"], message: "Agent snapshots require an external run ID" });
  }
  const ranks = value.entries.map((entry) => entry.rank);
  if (new Set(ranks).size !== ranks.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "Entry ranks must be unique" });
  }
  const sorted = [...ranks].sort((left, right) => left - right);
  if (sorted.some((rank, index) => rank !== index + 1)) {
    context.addIssue({ code: "custom", path: ["entries"], message: "Entry ranks must be contiguous from 1" });
  }
});

export type RankingSnapshotInput = z.infer<typeof rankingSnapshotInput>;

export class RankingSnapshotError extends Error {
  constructor(readonly code: "unknown_player" | "snapshot_conflict", message: string) {
    super(message);
    this.name = "RankingSnapshotError";
  }
}

export async function createRankingSnapshot(db: Database, input: RankingSnapshotInput) {
  const registryInput = rankingSourceRegistryInput.parse({
    canonicalKey: input.source.canonicalKey ?? input.source.slug,
    slug: input.source.slug,
    name: input.source.name,
    kind: input.source.kind,
    provider: input.source.provider,
    attributionUrl: input.source.attributionUrl,
    aliases: input.source.aliases,
    refresh: { mode: input.source.kind === "agent" ? "agent" : "manual" },
    provenance: input.source.provenance,
    metadata: input.source.metadata,
  });
  const { source } = await resolveOrCreateRankingSource(db, registryInput);
  const sourceId = source.id;

  if (input.externalRunId) {
    const existingSnapshot = await db
      .select({ id: rankingSnapshots.id })
      .from(rankingSnapshots)
      .where(and(
        eq(rankingSnapshots.sourceId, sourceId),
        eq(rankingSnapshots.externalRunId, input.externalRunId),
      ))
      .limit(1);
    if (existingSnapshot[0]) return { id: existingSnapshot[0].id, created: false };
  }

  const requestedPlayerIds = [...new Set(input.entries.flatMap((entry) => entry.playerId ? [entry.playerId] : []))];
  if (requestedPlayerIds.length > 0) {
    const known = await db.$client
      .prepare("SELECT id FROM players WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(requestedPlayerIds))
      .all<{ id: string }>();
    const knownIds = new Set(known.results.map((row) => row.id));
    const unknown = requestedPlayerIds.find((id) => !knownIds.has(id));
    if (unknown) throw new RankingSnapshotError("unknown_player", `Unknown canonical player ID: ${unknown}`);
  }

  const snapshotId = crypto.randomUUID();
  const now = Date.now();
  const entryRows = input.entries.map((entry) => ({
    id: crypto.randomUUID(),
    snapshotId,
    playerId: entry.playerId ?? null,
    externalPlayerId: entry.externalPlayerId ?? null,
    playerName: entry.playerName,
    position: entry.position ?? null,
    nflTeam: entry.team ?? null,
    rank: entry.rank,
    previousRank: entry.previousRank ?? null,
    tier: entry.tier ?? null,
    insight: entry.insight ?? null,
    createdAt: now,
  }));
  await db.$client.batch([
    db.$client.prepare(
      `INSERT INTO ranking_snapshots (
         id, source_id, external_run_id, title, scoring_format, ranking_type, season,
         week, status, generated_at, summary, methodology, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      sourceId,
      input.externalRunId ?? null,
      input.title,
      input.scoringFormat,
      input.rankingType,
      input.season,
      input.week ?? null,
      new Date(input.generatedAt).getTime(),
      input.summary ?? null,
      input.methodology ?? null,
      now,
    ),
    db.$client.prepare(
      `INSERT INTO ranking_snapshot_entries (
         id, snapshot_id, player_id, external_player_id, player_name, position,
         nfl_team, rank, previous_rank, tier, insight, created_at
       )
       SELECT json_extract(value, '$.id'), json_extract(value, '$.snapshotId'),
         json_extract(value, '$.playerId'), json_extract(value, '$.externalPlayerId'),
         json_extract(value, '$.playerName'), json_extract(value, '$.position'),
         json_extract(value, '$.nflTeam'), json_extract(value, '$.rank'),
         json_extract(value, '$.previousRank'), json_extract(value, '$.tier'),
         json_extract(value, '$.insight'), json_extract(value, '$.createdAt')
       FROM json_each(?)`,
    ).bind(JSON.stringify(entryRows)),
  ]);
  return { id: snapshotId, created: true };
}

export async function getRankingSnapshots(db: Database, limit: number) {
  const snapshotRows = await db
    .select({
      id: rankingSnapshots.id,
      sourceId: rankingSnapshots.sourceId,
      sourceName: rankingSources.name,
      sourceSlug: rankingSources.slug,
      sourceCanonicalKey: rankingSources.canonicalKey,
      sourceKind: rankingSources.kind,
      sourceProvider: rankingSources.provider,
      title: rankingSnapshots.title,
      scoringFormat: rankingSnapshots.scoringFormat,
      rankingType: rankingSnapshots.rankingType,
      season: rankingSnapshots.season,
      week: rankingSnapshots.week,
      generatedAt: rankingSnapshots.generatedAt,
      summary: rankingSnapshots.summary,
      methodology: rankingSnapshots.methodology,
    })
    .from(rankingSnapshots)
    .innerJoin(rankingSources, eq(rankingSources.id, rankingSnapshots.sourceId))
    .where(eq(rankingSnapshots.status, "completed"))
    .orderBy(desc(rankingSnapshots.generatedAt), desc(rankingSnapshots.id))
    .limit(limit);

  if (snapshotRows.length === 0) return [];
  const entries = await db
    .select()
    .from(rankingSnapshotEntries)
    .where(inArray(rankingSnapshotEntries.snapshotId, snapshotRows.map((snapshot) => snapshot.id)))
    .orderBy(rankingSnapshotEntries.rank);
  const entriesBySnapshot = new Map<string, typeof entries>();
  for (const entry of entries) {
    const current = entriesBySnapshot.get(entry.snapshotId) ?? [];
    current.push(entry);
    entriesBySnapshot.set(entry.snapshotId, current);
  }

  return snapshotRows.map((snapshot) => ({
    id: snapshot.id,
    source: {
      id: snapshot.sourceId,
      canonicalKey: snapshot.sourceCanonicalKey,
      name: snapshot.sourceName,
      slug: snapshot.sourceSlug,
      kind: snapshot.sourceKind,
      provider: snapshot.sourceProvider,
    },
    title: snapshot.title,
    scoringFormat: snapshot.scoringFormat,
    rankingType: snapshot.rankingType,
    season: snapshot.season,
    week: snapshot.week,
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    methodology: snapshot.methodology,
    entries: (entriesBySnapshot.get(snapshot.id) ?? []).map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      externalPlayerId: entry.externalPlayerId,
      playerName: entry.playerName,
      position: entry.position,
      team: entry.nflTeam,
      rank: entry.rank,
      previousRank: entry.previousRank,
      tier: entry.tier,
      insight: entry.insight,
      createdAt: entry.createdAt,
    })),
  }));
}
