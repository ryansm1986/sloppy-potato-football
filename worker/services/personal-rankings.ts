import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

const scopeFields = {
  season: z.string().regex(/^20\d{2}$/),
  scoringFormat: z.literal("ppr"),
  rankingType: z.literal("redraft"),
};

export const personalRankingQueryInput = z.object(scopeFields).strict();

export const savePersonalRankingInput = z.object({
  ...scopeFields,
  playerIds: z.array(z.string().trim().min(1).max(100)).max(1_500),
  expectedRevision: z.number().int().min(0).optional(),
  leagueSize: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(14), z.literal(16)]).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.playerIds).size !== value.playerIds.length) {
    context.addIssue({ code: "custom", path: ["playerIds"], message: "Player IDs must be unique" });
  }
});

export type PersonalRankingScope = z.infer<typeof personalRankingQueryInput>;
export type SavePersonalRankingInput = z.infer<typeof savePersonalRankingInput>;

type BoardRow = {
  id: string;
  name: string;
  season: string;
  revision: number;
  settings_json: string;
  write_token: string | null;
  updated_at: number;
};

type EntryRow = {
  id: string;
  name: string;
  position: string | null;
  team: string | null;
};

export class PersonalRankingError extends Error {
  constructor(
    readonly code: "revision_conflict" | "write_conflict",
    message: string,
    readonly status: 409 = 409,
  ) {
    super(message);
    this.name = "PersonalRankingError";
  }
}

function findBoard(db: Database, ownerIdentity: string, scope: PersonalRankingScope) {
  return db.$client.prepare(
    `SELECT id, name, season, revision, settings_json, write_token, updated_at
     FROM ranking_lists
     WHERE owner_identity = ? AND list_kind = 'personal' AND league_id IS NULL AND ranking_type = ?
       AND scoring_format = ? AND season = ? AND week IS NULL AND archived_at IS NULL
     LIMIT 1`,
  ).bind(ownerIdentity, scope.rankingType, scope.scoringFormat, scope.season).first<BoardRow>();
}

async function loadEntryRows(db: Database, listId: string): Promise<EntryRow[]> {
  const result = await db.$client.prepare(
    `SELECT p.id, p.full_name AS name, p.position, p.nfl_team AS team
     FROM ranking_list_entries e
     JOIN players p ON p.id = e.player_id
     WHERE e.list_id = ?
     ORDER BY e.sort_key, e.player_id`,
  ).bind(listId).all<EntryRow>();
  return result.results;
}

function publicPosition(position: string | null) {
  return position === "DEF" ? "DST" : position ?? "N/A";
}

function publicBoard(row: BoardRow, entries: EntryRow[]) {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    season: row.season,
    updatedAt: new Date(row.updated_at).toISOString(),
    entries: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      position: publicPosition(entry.position),
      team: entry.team ?? "FA",
      consensusRank: null,
      trend: null,
    })),
  };
}

export async function getPersonalRankingBoard(
  db: Database,
  scope: PersonalRankingScope,
  ownerIdentity = "primary-owner",
) {
  const row = await findBoard(db, ownerIdentity, scope);
  if (!row) return null;
  return publicBoard(row, await loadEntryRows(db, row.id));
}

async function resolveCanonicalIds(db: Database, requestedIds: string[]) {
  if (requestedIds.length === 0) return { knownIds: [] as string[], ignoredPlayerIds: [] as string[] };
  const result = await db.$client.prepare(
    "SELECT id FROM players WHERE id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(requestedIds)).all<{ id: string }>();
  const known = new Set(result.results.map((row) => row.id));
  return {
    knownIds: requestedIds.filter((id) => known.has(id)),
    ignoredPlayerIds: requestedIds.filter((id) => !known.has(id)),
  };
}

function parsedSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writeEntries(db: Database, listId: string, writeToken: string, playerIds: string[], now: number) {
  const statements: D1PreparedStatement[] = [db.$client.prepare(
    `DELETE FROM ranking_list_entries
     WHERE list_id = ? AND EXISTS (
       SELECT 1 FROM ranking_lists WHERE id = ? AND write_token = ?
     )`,
  ).bind(listId, listId, writeToken)];

  for (let offset = 0; offset < playerIds.length; offset += 100) {
    const chunk = playerIds.slice(offset, offset + 100);
    statements.push(db.$client.prepare(
      `INSERT INTO ranking_list_entries (list_id, player_id, sort_key, created_at, updated_at)
       SELECT ?, CAST(value AS text), ? + CAST(key AS integer), ?, ?
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM ranking_lists WHERE id = ? AND write_token = ?)`,
    ).bind(listId, offset + 1, now, now, JSON.stringify(chunk), listId, writeToken));
  }
  await db.$client.batch(statements);
}

export async function savePersonalRankingBoard(
  db: Database,
  input: SavePersonalRankingInput,
  ownerIdentity = "primary-owner",
) {
  const { knownIds, ignoredPlayerIds } = await resolveCanonicalIds(db, input.playerIds);
  const scope: PersonalRankingScope = input;
  let existing = await findBoard(db, ownerIdentity, scope);
  const existingEntries = existing ? await loadEntryRows(db, existing.id) : [];
  const settings = existing ? parsedSettings(existing.settings_json) : {};
  if (input.leagueSize !== undefined) settings.leagueSize = input.leagueSize;
  const settingsJson = JSON.stringify(settings);
  const orderIsUnchanged = existing !== null
    && existingEntries.length === knownIds.length
    && existingEntries.every((entry, index) => entry.id === knownIds[index]);
  const settingsAreUnchanged = existing?.settings_json === settingsJson;

  // Retried explicit saves are idempotent, even if their expected revision has
  // become stale because the first response was lost.
  if (existing && orderIsUnchanged && settingsAreUnchanged) {
    return {
      board: publicBoard(existing, existingEntries),
      savedCount: knownIds.length,
      ignoredPlayerIds,
    };
  }
  if (existing && input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw new PersonalRankingError(
      "revision_conflict",
      `Personal rankings changed since revision ${input.expectedRevision}; reload before saving`,
    );
  }
  if (!existing && input.expectedRevision !== undefined && input.expectedRevision !== 0) {
    throw new PersonalRankingError("revision_conflict", "Personal rankings do not exist at the expected revision");
  }

  const now = Date.now();
  const writeToken = crypto.randomUUID();
  let listId: string;
  let nextRevision: number;
  if (!existing) {
    listId = crypto.randomUUID();
    nextRevision = 1;
    try {
      await db.$client.prepare(
        `INSERT INTO ranking_lists (
           id, owner_identity, league_id, name, ranking_type, scoring_format, season,
           week, revision, settings_json, write_token, list_kind, created_at, updated_at
         ) VALUES (?, ?, NULL, 'My Rankings', ?, ?, ?, NULL, ?, ?, ?, 'personal', ?, ?)`,
      ).bind(
        listId, ownerIdentity, input.rankingType, input.scoringFormat, input.season,
        nextRevision, settingsJson, writeToken, now, now,
      ).run();
    } catch {
      existing = await findBoard(db, ownerIdentity, scope);
      if (!existing) throw new PersonalRankingError("write_conflict", "Personal rankings could not be created");
      throw new PersonalRankingError("revision_conflict", "Personal rankings were created by another request; reload before saving");
    }
  } else {
    listId = existing.id;
    nextRevision = existing.revision + 1;
    const update = await db.$client.prepare(
      `UPDATE ranking_lists
       SET revision = ?, settings_json = ?, write_token = ?, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ).bind(nextRevision, settingsJson, writeToken, now, listId, existing.revision).run();
    if ((update.meta.changes ?? 0) !== 1) {
      throw new PersonalRankingError("revision_conflict", "Personal rankings changed while saving; reload and try again");
    }
  }

  await writeEntries(db, listId, writeToken, knownIds, now);
  const saved = await findBoard(db, ownerIdentity, scope);
  if (!saved || saved.write_token !== writeToken || saved.revision !== nextRevision) {
    throw new PersonalRankingError("write_conflict", "A newer personal ranking save won; reload before trying again");
  }
  const entries = await loadEntryRows(db, listId);
  return {
    board: publicBoard(saved, entries),
    savedCount: entries.length,
    ignoredPlayerIds,
  };
}
