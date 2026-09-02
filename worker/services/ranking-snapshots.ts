import { and, eq, inArray } from "drizzle-orm";
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
import { canonicalSourceDomain } from "./source-domains";

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

export const rankingPositionScope = z.enum(["ALL", "QB", "RB", "WR", "TE", "K", "DST"]);

export const rankingSnapshotInput = z.object({
  source: sourceInput,
  externalRunId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(3).max(140),
  scoringFormat: z.enum(["ppr", "half_ppr", "standard"]),
  rankingType: z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]),
  season: z.string().regex(/^20\d{2}$/),
  week: z.number().int().min(1).max(25).nullish(),
  positionScope: rankingPositionScope.optional().default("ALL"),
  generatedAt: z.string().datetime({ offset: true }),
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

export type RankingSnapshotDiscovery = {
  researchJobId: string;
  discoverNewSources: boolean;
  isNewDiscovery: boolean;
  newPublisherCount: number;
};

export class RankingSnapshotError extends Error {
  constructor(readonly code: "unknown_player" | "snapshot_conflict", message: string) {
    super(message);
    this.name = "RankingSnapshotError";
  }
}

export async function createRankingSnapshot(
  db: Database,
  input: RankingSnapshotInput,
  discovery?: RankingSnapshotDiscovery,
) {
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
         week, position_scope, status, generated_at, summary, methodology, research_job_id,
         source_url, discover_new_sources, is_new_discovery, new_publisher_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      sourceId,
      input.externalRunId ?? null,
      input.title,
      input.scoringFormat,
      input.rankingType,
      input.season,
      input.week ?? null,
      input.positionScope,
      discovery ? "pending" : "completed",
      new Date(input.generatedAt).getTime(),
      input.summary ?? null,
      input.methodology ?? null,
      discovery?.researchJobId ?? null,
      input.source.attributionUrl ?? null,
      discovery?.discoverNewSources ? 1 : 0,
      discovery?.isNewDiscovery ? 1 : 0,
      discovery?.newPublisherCount ?? 0,
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

type RankingDomainRow = {
  attribution_url: string | null;
  snapshot_source_url: string | null;
  alias_domain: string | null;
  latest_snapshot_at: number;
};

async function loadRankingDomainRows(db: Database, limit?: number) {
  const limitSql = limit === undefined ? "" : " LIMIT ?";
  const statement = db.$client.prepare(
    `SELECT sources.attribution_url, snapshots.source_url AS snapshot_source_url,
       aliases.normalized_value AS alias_domain,
       MAX(snapshots.created_at) AS latest_snapshot_at
     FROM ranking_sources sources
     JOIN ranking_snapshots snapshots ON snapshots.source_id = sources.id
       AND snapshots.status = 'completed'
     LEFT JOIN ranking_source_aliases aliases ON aliases.source_id = sources.id
       AND aliases.alias_type = 'domain'
     WHERE sources.kind = 'external'
     GROUP BY sources.id, sources.attribution_url, snapshots.source_url, aliases.normalized_value
     ORDER BY latest_snapshot_at DESC, sources.id${limitSql}`,
  );
  return limit === undefined
    ? (await statement.all<RankingDomainRow>()).results
    : (await statement.bind(limit).all<RankingDomainRow>()).results;
}

function domainsFromRankingRows(rows: RankingDomainRow[]) {
  const domains = new Set<string>();
  for (const row of rows) {
    if (row.alias_domain) {
      try {
        domains.add(canonicalSourceDomain(`https://${row.alias_domain}`));
      } catch {
        // Ignore malformed legacy aliases; a valid attribution URL can still
        // preserve the source's history below.
      }
    }
    if (row.attribution_url) {
      try {
        domains.add(canonicalSourceDomain(row.attribution_url));
      } catch {
        // Ignore malformed legacy URLs rather than blocking a research job.
      }
    }
    if (row.snapshot_source_url) {
      try {
        domains.add(canonicalSourceDomain(row.snapshot_source_url));
      } catch {
        // Ignore malformed legacy snapshot URLs.
      }
    }
  }
  return [...domains];
}

export async function snapshotKnownRankingSourceDomains(db: Database) {
  // Fetch extra rows before applying the stricter prompt budgets because one
  // source can have multiple historical domain aliases.
  const candidates = domainsFromRankingRows(await loadRankingDomainRows(db, 100));
  const domains: string[] = [];
  let characterCount = 0;
  for (const domain of candidates) {
    if (!domain || domain.length > 253 || characterCount + domain.length > 1_200) continue;
    domains.push(domain);
    characterCount += domain.length;
    if (domains.length === 40) break;
  }
  return domains;
}

export async function loadAllKnownRankingSourceDomains(db: Database) {
  return domainsFromRankingRows(await loadRankingDomainRows(db));
}

export async function publishRankingSnapshots(db: Database, researchJobId: string) {
  const result = await db.$client.prepare(
    "UPDATE ranking_snapshots SET status = 'completed' WHERE research_job_id = ? AND status = 'pending'",
  ).bind(researchJobId).run();
  return result.meta.changes ?? 0;
}

export async function discardPendingRankingSnapshots(db: Database, researchJobId: string) {
  await db.$client.prepare(
    "DELETE FROM ranking_snapshots WHERE research_job_id = ? AND status = 'pending'",
  ).bind(researchJobId).run();
}

export const rankingSnapshotQueryInput = z.object({
  scoringFormat: z.enum(["ppr", "half_ppr", "standard"]).optional(),
  rankingType: z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]).optional(),
  season: z.string().regex(/^20\d{2}$/).optional(),
  week: z.number().int().min(1).max(25).nullable().optional(),
  position: rankingPositionScope.optional(),
  source: z.string().trim().min(1).max(128).optional(),
  latestPerSource: z.boolean().optional().default(false),
});

export type RankingSnapshotQuery = z.input<typeof rankingSnapshotQueryInput>;

export async function getRankingSnapshots(db: Database, limit: number, query: RankingSnapshotQuery = {}) {
  const parsedQuery = rankingSnapshotQueryInput.parse(query);
  const clauses = ["sn.status = 'completed'"];
  const bindings: unknown[] = [];
  const addFilter = (column: string, value: unknown) => {
    clauses.push(`${column} = ?`);
    bindings.push(value);
  };
  if (parsedQuery.scoringFormat) addFilter("sn.scoring_format", parsedQuery.scoringFormat);
  if (parsedQuery.rankingType) addFilter("sn.ranking_type", parsedQuery.rankingType);
  if (parsedQuery.season) addFilter("sn.season", parsedQuery.season);
  if (parsedQuery.week !== undefined) {
    if (parsedQuery.week === null) clauses.push("sn.week IS NULL");
    else addFilter("sn.week", parsedQuery.week);
  }
  if (parsedQuery.position) addFilter("sn.position_scope", parsedQuery.position);
  if (parsedQuery.source) {
    clauses.push("(rs.canonical_key = ? OR rs.slug = ? OR rs.id = ?)");
    bindings.push(parsedQuery.source, parsedQuery.source, parsedQuery.source);
  }

  const rankProjection = parsedQuery.latestPerSource
    ? "ROW_NUMBER() OVER (PARTITION BY sn.source_id ORDER BY sn.created_at DESC, sn.id DESC) AS source_rank"
    : "1 AS source_rank";
  const selectedSnapshotIds = await db.$client.prepare(
    `WITH scoped AS (
       SELECT sn.id, sn.created_at, ${rankProjection}
       FROM ranking_snapshots sn
       INNER JOIN ranking_sources rs ON rs.id = sn.source_id
       WHERE ${clauses.join(" AND ")}
     )
     SELECT id FROM scoped
     WHERE source_rank = 1
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).bind(...bindings, limit).all<{ id: string }>();
  const snapshotIds = selectedSnapshotIds.results.map((row) => row.id);
  if (snapshotIds.length === 0) return [];

  const unorderedSnapshotRows = await db
    .select({
      id: rankingSnapshots.id,
      sourceId: rankingSnapshots.sourceId,
      sourceName: rankingSources.name,
      sourceSlug: rankingSources.slug,
      sourceCanonicalKey: rankingSources.canonicalKey,
      sourceKind: rankingSources.kind,
      sourceProvider: rankingSources.provider,
      sourceAttributionUrl: rankingSources.attributionUrl,
      title: rankingSnapshots.title,
      scoringFormat: rankingSnapshots.scoringFormat,
      rankingType: rankingSnapshots.rankingType,
      season: rankingSnapshots.season,
      week: rankingSnapshots.week,
      positionScope: rankingSnapshots.positionScope,
      generatedAt: rankingSnapshots.generatedAt,
      createdAt: rankingSnapshots.createdAt,
      summary: rankingSnapshots.summary,
      methodology: rankingSnapshots.methodology,
      researchJobId: rankingSnapshots.researchJobId,
      sourceUrl: rankingSnapshots.sourceUrl,
      discoverNewSources: rankingSnapshots.discoverNewSources,
      isNewDiscovery: rankingSnapshots.isNewDiscovery,
      newPublisherCount: rankingSnapshots.newPublisherCount,
    })
    .from(rankingSnapshots)
    .innerJoin(rankingSources, eq(rankingSources.id, rankingSnapshots.sourceId))
    .where(inArray(rankingSnapshots.id, snapshotIds));
  const snapshotsById = new Map(unorderedSnapshotRows.map((snapshot) => [snapshot.id, snapshot]));
  const snapshotRows = snapshotIds.flatMap((id) => {
    const snapshot = snapshotsById.get(id);
    return snapshot ? [snapshot] : [];
  });
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
      attributionUrl: snapshot.sourceAttributionUrl,
    },
    title: snapshot.title,
    scoringFormat: snapshot.scoringFormat,
    rankingType: snapshot.rankingType,
    season: snapshot.season,
    week: snapshot.week,
    positionScope: snapshot.positionScope,
    generatedAt: snapshot.generatedAt,
    createdAt: snapshot.createdAt,
    savedAt: snapshot.createdAt,
    summary: snapshot.summary,
    methodology: snapshot.methodology,
    researchJobId: snapshot.researchJobId,
    sourceUrl: snapshot.sourceUrl ?? snapshot.sourceAttributionUrl,
    discoverNewSources: snapshot.discoverNewSources,
    isNewDiscovery: snapshot.isNewDiscovery,
    newPublisherCount: snapshot.newPublisherCount,
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
