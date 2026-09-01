import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

const canonicalKey = z.string().trim().toLowerCase()
  .min(2).max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, "Use a stable namespaced key such as site:fantasypros");
const sourceSlug = z.string().trim().toLowerCase()
  .min(2).max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const aliasInput = z.object({
  type: z.enum(["slug", "name", "url", "domain", "external", "custom"]),
  value: z.string().trim().min(1).max(500),
});

export const rankingSourceRegistryInput = z.object({
  canonicalKey,
  slug: sourceSlug,
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["agent", "import", "derived", "external", "custom"]),
  provider: z.string().trim().max(50).nullish(),
  attributionUrl: z.string().url().max(500).nullish(),
  aliases: z.array(aliasInput).max(50).optional().default([]),
  refresh: z.object({
    mode: z.enum(["manual", "agent", "import"]).default("manual"),
    intervalMinutes: z.number().int().min(15).max(525_600).nullish(),
  }).optional().default({ mode: "manual" }),
  provenance: z.record(z.string(), z.unknown()).optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type RankingSourceRegistryInput = z.infer<typeof rankingSourceRegistryInput>;

type NormalizedAlias = {
  type: z.infer<typeof aliasInput>["type"];
  normalizedValue: string;
  displayValue: string;
};

export class RankingSourceRegistryError extends Error {
  constructor(
    readonly code: "source_conflict" | "alias_conflict",
    message: string,
  ) {
    super(message);
    this.name = "RankingSourceRegistryError";
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function normalizeAlias(type: NormalizedAlias["type"], value: string): string {
  const normalized = value.trim().normalize("NFKC");
  if (type === "url") return normalizeUrl(normalized);
  if (type === "domain") {
    return normalized.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  }
  return normalized.toLowerCase().replace(/\s+/g, " ");
}

function aliasesFor(input: RankingSourceRegistryInput): NormalizedAlias[] {
  const candidates = [
    { type: "slug" as const, value: input.slug },
    { type: "name" as const, value: input.name },
    ...input.aliases,
  ];
  if (input.attributionUrl) {
    const url = new URL(input.attributionUrl);
    candidates.push({ type: "url", value: input.attributionUrl });
    candidates.push({ type: "domain", value: url.hostname });
  }

  const unique = new Map<string, NormalizedAlias>();
  for (const alias of candidates) {
    const normalizedValue = normalizeAlias(alias.type, alias.value);
    const key = `${alias.type}\u0000${normalizedValue}`;
    unique.set(key, { type: alias.type, normalizedValue, displayValue: alias.value.trim() });
  }
  return [...unique.values()];
}

async function stableId(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}:${hex}`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

type SourceRow = {
  id: string;
  canonical_key: string;
  slug: string;
  name: string;
  kind: string;
  provider: string | null;
  attribution_url: string | null;
  refresh_mode: string;
  refresh_interval_minutes: number | null;
  last_refresh_requested_at: number | null;
  last_refresh_completed_at: number | null;
  last_refresh_status: string | null;
  last_refresh_error: string | null;
  provenance_json: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

async function findMatchingSourceIds(
  db: Database,
  input: RankingSourceRegistryInput,
  aliases: NormalizedAlias[],
): Promise<string[]> {
  const matches = await db.$client.prepare(
    `SELECT id FROM ranking_sources WHERE canonical_key = ? OR slug = ?
     UNION
     SELECT source_id AS id
     FROM ranking_source_aliases
     WHERE EXISTS (
       SELECT 1 FROM json_each(?) candidate
       WHERE json_extract(candidate.value, '$.type') = alias_type
         AND json_extract(candidate.value, '$.normalizedValue') = normalized_value
     )`,
  ).bind(input.canonicalKey, input.slug, JSON.stringify(aliases)).all<{ id: string }>();
  return matches.results.map((row) => row.id);
}

async function loadSource(db: Database, sourceId: string) {
  const row = await db.$client.prepare(
    `SELECT id, canonical_key, slug, name, kind, provider, attribution_url,
       refresh_mode, refresh_interval_minutes, last_refresh_requested_at,
       last_refresh_completed_at, last_refresh_status, last_refresh_error,
       provenance_json, metadata_json, created_at, updated_at
     FROM ranking_sources WHERE id = ?`,
  ).bind(sourceId).first<SourceRow>();
  if (!row) throw new RankingSourceRegistryError("source_conflict", "Ranking source could not be resolved");
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    attributionUrl: row.attribution_url,
    refresh: {
      mode: row.refresh_mode,
      intervalMinutes: row.refresh_interval_minutes,
      lastRequestedAt: row.last_refresh_requested_at ? new Date(row.last_refresh_requested_at) : null,
      lastCompletedAt: row.last_refresh_completed_at ? new Date(row.last_refresh_completed_at) : null,
      status: row.last_refresh_status,
      error: row.last_refresh_error,
    },
    provenance: parseJsonObject(row.provenance_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function attachAliases(db: Database, sourceId: string, aliases: NormalizedAlias[], now: number) {
  const aliasRows = await Promise.all(aliases.map(async (alias) => ({
    id: await stableId("ranking-source-alias", `${alias.type}:${alias.normalizedValue}`),
    sourceId,
    ...alias,
  })));
  if (aliasRows.length === 0) return;
  await db.$client.prepare(
    `INSERT OR IGNORE INTO ranking_source_aliases (
       id, source_id, alias_type, normalized_value, display_value, created_at
     )
     SELECT json_extract(value, '$.id'), json_extract(value, '$.sourceId'),
       json_extract(value, '$.type'), json_extract(value, '$.normalizedValue'),
       json_extract(value, '$.displayValue'), ?
     FROM json_each(?)`,
  ).bind(now, JSON.stringify(aliasRows)).run();

  const conflicts = await db.$client.prepare(
    `SELECT alias_type, normalized_value, source_id
     FROM ranking_source_aliases
     WHERE source_id <> ? AND EXISTS (
       SELECT 1 FROM json_each(?) candidate
       WHERE json_extract(candidate.value, '$.type') = alias_type
         AND json_extract(candidate.value, '$.normalizedValue') = normalized_value
     )`,
  ).bind(sourceId, JSON.stringify(aliases)).all<{
    alias_type: string;
    normalized_value: string;
    source_id: string;
  }>();
  if (conflicts.results[0]) {
    throw new RankingSourceRegistryError(
      "alias_conflict",
      `Alias ${conflicts.results[0].alias_type}:${conflicts.results[0].normalized_value} belongs to another source`,
    );
  }
}

export async function resolveOrCreateRankingSource(db: Database, input: RankingSourceRegistryInput) {
  const aliases = aliasesFor(input);
  const matchingIds = await findMatchingSourceIds(db, input, aliases);
  if (matchingIds.length > 1) {
    throw new RankingSourceRegistryError(
      "source_conflict",
      "The supplied canonical key and aliases identify different ranking sources",
    );
  }

  const now = Date.now();
  if (matchingIds[0]) {
    const sourceId = matchingIds[0];
    const matchedSource = await loadSource(db, sourceId);
    // Sources created before the registry migration used their slug as the
    // canonical key. Permit a one-time upgrade to a namespaced key while
    // preserving the source ID, snapshots, and seeded slug alias.
    if (matchedSource.canonicalKey === matchedSource.slug && input.canonicalKey !== matchedSource.canonicalKey) {
      try {
        await db.$client.prepare(
          "UPDATE ranking_sources SET canonical_key = ?, updated_at = ? WHERE id = ? AND canonical_key = ?",
        ).bind(input.canonicalKey, now, sourceId, matchedSource.canonicalKey).run();
      } catch {
        throw new RankingSourceRegistryError(
          "source_conflict",
          `Canonical key ${input.canonicalKey} already belongs to another source`,
        );
      }
    }
    await attachAliases(db, sourceId, aliases, now);
    return { source: await loadSource(db, sourceId), created: false };
  }

  const sourceId = await stableId("ranking-source", input.canonicalKey);
  const aliasRows = await Promise.all(aliases.map(async (alias) => ({
    id: await stableId("ranking-source-alias", `${alias.type}:${alias.normalizedValue}`),
    sourceId,
    ...alias,
  })));
  try {
    await db.$client.batch([
      db.$client.prepare(
        `INSERT INTO ranking_sources (
           id, canonical_key, slug, name, kind, provider, attribution_url,
           refresh_mode, refresh_interval_minutes, provenance_json, metadata_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_key) DO NOTHING`,
      ).bind(
        sourceId,
        input.canonicalKey,
        input.slug,
        input.name,
        input.kind,
        input.provider ?? null,
        input.attributionUrl ?? null,
        input.refresh.mode,
        input.refresh.intervalMinutes ?? null,
        JSON.stringify(input.provenance),
        JSON.stringify(input.metadata),
        now,
        now,
      ),
      db.$client.prepare(
        `INSERT INTO ranking_source_aliases (
           id, source_id, alias_type, normalized_value, display_value, created_at
         )
         SELECT json_extract(value, '$.id'), json_extract(value, '$.sourceId'),
           json_extract(value, '$.type'), json_extract(value, '$.normalizedValue'),
           json_extract(value, '$.displayValue'), ?
         FROM json_each(?)`,
      ).bind(now, JSON.stringify(aliasRows)),
    ]);
  } catch (error) {
    const retryMatches = await findMatchingSourceIds(db, input, aliases);
    if (retryMatches.length === 1) {
      return { source: await loadSource(db, retryMatches[0]), created: false };
    }
    throw new RankingSourceRegistryError(
      "source_conflict",
      error instanceof Error ? error.message : "Ranking source conflicts with the registry",
    );
  }

  const resolvedIds = await findMatchingSourceIds(db, input, aliases);
  if (resolvedIds.length !== 1) {
    throw new RankingSourceRegistryError(
      "alias_conflict",
      "One or more aliases were claimed concurrently by another source",
    );
  }
  return { source: await loadSource(db, resolvedIds[0]), created: resolvedIds[0] === sourceId };
}

type CatalogRow = SourceRow & {
  snapshot_count: number | null;
  latest_snapshot_id: string | null;
  latest_snapshot_title: string | null;
  latest_ranking_type: string | null;
  latest_scoring_format: string | null;
  latest_season: string | null;
  latest_week: number | null;
  latest_generated_at: number | null;
};

export async function getRankingSourceCatalog(
  db: Database,
  options: { limit: number; after?: string },
) {
  const rows = await db.$client.prepare(
    `WITH completed_snapshots AS (
       SELECT id, source_id, title, ranking_type, scoring_format, season, week,
         generated_at,
         ROW_NUMBER() OVER (
           PARTITION BY source_id ORDER BY generated_at DESC, id DESC
         ) AS snapshot_number,
         COUNT(*) OVER (PARTITION BY source_id) AS snapshot_count
       FROM ranking_snapshots
       WHERE status = 'completed'
     )
     SELECT source.id, source.canonical_key, source.slug, source.name, source.kind,
       source.provider, source.attribution_url, source.refresh_mode,
       source.refresh_interval_minutes, source.last_refresh_requested_at,
       source.last_refresh_completed_at, source.last_refresh_status,
       source.last_refresh_error, source.provenance_json, source.metadata_json,
       source.created_at, source.updated_at,
       latest.snapshot_count, latest.id AS latest_snapshot_id,
       latest.title AS latest_snapshot_title,
       latest.ranking_type AS latest_ranking_type,
       latest.scoring_format AS latest_scoring_format,
       latest.season AS latest_season, latest.week AS latest_week,
       latest.generated_at AS latest_generated_at
     FROM ranking_sources source
     LEFT JOIN completed_snapshots latest
       ON latest.source_id = source.id AND latest.snapshot_number = 1
     WHERE source.canonical_key > ?
     ORDER BY source.canonical_key
     LIMIT ?`,
  ).bind(options.after ?? "", options.limit + 1).all<CatalogRow>();
  const pageRows = rows.results.slice(0, options.limit);
  const sourceIds = pageRows.map((row) => row.id);
  const aliases = sourceIds.length === 0
    ? []
    : (await db.$client.prepare(
      `SELECT source_id, alias_type, normalized_value, display_value
       FROM ranking_source_aliases
       WHERE source_id IN (SELECT value FROM json_each(?))
       ORDER BY source_id, alias_type, normalized_value`,
    ).bind(JSON.stringify(sourceIds)).all<{
      source_id: string;
      alias_type: string;
      normalized_value: string;
      display_value: string;
    }>()).results;
  const aliasesBySource = new Map<string, typeof aliases>();
  for (const alias of aliases) {
    const current = aliasesBySource.get(alias.source_id) ?? [];
    current.push(alias);
    aliasesBySource.set(alias.source_id, current);
  }

  return {
    sources: pageRows.map((row) => ({
      id: row.id,
      canonicalKey: row.canonical_key,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      provider: row.provider,
      attributionUrl: row.attribution_url,
      aliases: (aliasesBySource.get(row.id) ?? []).map((alias) => ({
        type: alias.alias_type,
        value: alias.display_value,
        normalizedValue: alias.normalized_value,
      })),
      refresh: {
        mode: row.refresh_mode,
        intervalMinutes: row.refresh_interval_minutes,
        lastRequestedAt: row.last_refresh_requested_at ? new Date(row.last_refresh_requested_at) : null,
        lastCompletedAt: row.last_refresh_completed_at ? new Date(row.last_refresh_completed_at) : null,
        status: row.last_refresh_status,
        error: row.last_refresh_error,
      },
      provenance: parseJsonObject(row.provenance_json),
      metadata: parseJsonObject(row.metadata_json),
      snapshotCount: row.snapshot_count ?? 0,
      latestSnapshot: row.latest_snapshot_id ? {
        id: row.latest_snapshot_id,
        title: row.latest_snapshot_title,
        rankingType: row.latest_ranking_type,
        scoringFormat: row.latest_scoring_format,
        season: row.latest_season,
        week: row.latest_week,
        generatedAt: row.latest_generated_at ? new Date(row.latest_generated_at) : null,
      } : null,
    })),
    nextCursor: rows.results.length > options.limit
      ? pageRows.at(-1)?.canonical_key ?? null
      : null,
  };
}
