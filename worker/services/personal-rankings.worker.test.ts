import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import app from "../index";
import * as schema from "../db/schema";
import { getPersonalRankingBoard, savePersonalRankingBoard } from "./personal-rankings";

const bindings = { DB: env.DB, RESEARCH_OWNER_TOKEN: "owner-secret" };
const db = drizzle(env.DB, { schema });

function request(method: string, body?: unknown, token = "owner-secret") {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function scope(season: string) {
  return { season, scoringFormat: "ppr" as const, rankingType: "redraft" as const };
}

function payload(season: string, playerIds: string[], expectedRevision?: number) {
  return {
    ...scope(season),
    playerIds,
    leagueSize: 12 as const,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

async function addPlayer(name: string, position: string, team: string | null = "ATL") {
  const id = `test-player:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO players (id, full_name, search_name, position, nfl_team)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, name, name.toLowerCase().replace(/[^a-z0-9]/g, ""), position, team).run();
  return id;
}

describe("personal rankings API", () => {
  it("requires owner authentication for reads and writes", async () => {
    const query = new URLSearchParams(scope("2091"));
    const read = await app.request(
      `https://potato.example/api/research/personal-rankings?${query}`,
      request("GET", undefined, "wrong-token"),
      bindings,
    );
    const write = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2091", []), "wrong-token"),
      bindings,
    );
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
  });

  it("returns null for an unsaved scope and validates bounded unique input", async () => {
    const query = new URLSearchParams(scope("2092"));
    const response = await app.request(
      `https://potato.example/api/research/personal-rankings?${query}`,
      request("GET"),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ board: null });

    const duplicate = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2092", ["same", "same"])),
      bindings,
    );
    expect(duplicate.status).toBe(400);

    const oversized = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2092", Array.from({ length: 1_501 }, (_, index) => `player-${index}`))),
      bindings,
    );
    expect(oversized.status).toBe(400);
  });

  it("persists canonical players in requested order and reports ignored IDs", async () => {
    const first = await addPlayer("Test Receiver", "WR", "BUF");
    const second = await addPlayer("Test Defense", "DEF", null);
    const response = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2093", [second, "old-custom-player", first])),
      bindings,
    );
    expect(response.status).toBe(200);
    const result = await response.json<{
      board: { revision: number; entries: Array<Record<string, unknown>> };
      savedCount: number;
      ignoredPlayerIds: string[];
    }>();
    expect(result.savedCount).toBe(2);
    expect(result.ignoredPlayerIds).toEqual(["old-custom-player"]);
    expect(result.board.revision).toBe(1);
    expect(result.board.entries).toEqual([
      { id: second, name: "Test Defense", position: "DST", team: "FA", consensusRank: null, trend: null },
      { id: first, name: "Test Receiver", position: "WR", team: "BUF", consensusRank: null, trend: null },
    ]);

    const query = new URLSearchParams(scope("2093"));
    const loaded = await app.request(
      `https://potato.example/api/research/personal-rankings?${query}`,
      request("GET"),
      bindings,
    );
    expect((await loaded.json<{ board: { entries: { id: string }[] } }>()).board.entries.map((entry) => entry.id))
      .toEqual([second, first]);
  });

  it("is idempotent for a repeated save and detects conflicting revisions without changing order", async () => {
    const first = await addPlayer("Idempotent One", "RB");
    const second = await addPlayer("Idempotent Two", "TE");
    const created = await savePersonalRankingBoard(db, payload("2094", [first, second]), "owner-idempotency");
    expect(created.board.revision).toBe(1);

    const retry = await savePersonalRankingBoard(db, payload("2094", [first, second], 0), "owner-idempotency");
    expect(retry.board.revision).toBe(1);
    expect(retry.board.updatedAt).toBe(created.board.updatedAt);

    const updated = await savePersonalRankingBoard(db, payload("2094", [second, first], 1), "owner-idempotency");
    expect(updated.board.revision).toBe(2);
    expect(updated.board.entries.map((entry) => entry.id)).toEqual([second, first]);

    await expect(savePersonalRankingBoard(
      db,
      payload("2094", [first, second], 1),
      "owner-idempotency",
    )).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect((await getPersonalRankingBoard(db, scope("2094"), "owner-idempotency"))?.entries.map((entry) => entry.id))
      .toEqual([second, first]);
  });

  it("maps stale API writes to a 409 conflict", async () => {
    const first = await addPlayer("API Conflict One", "WR");
    const second = await addPlayer("API Conflict Two", "RB");
    const created = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2096", [first, second])),
      bindings,
    );
    expect(created.status).toBe(200);
    const stale = await app.request(
      "https://potato.example/api/research/personal-rankings",
      request("PUT", payload("2096", [second, first], 0)),
      bindings,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "revision_conflict" });
  });

  it("allows only one of two concurrent edits based on the same revision", async () => {
    const first = await addPlayer("Concurrent One", "WR");
    const second = await addPlayer("Concurrent Two", "RB");
    const third = await addPlayer("Concurrent Three", "TE");
    const owner = `concurrent-owner-${crypto.randomUUID()}`;
    const created = await savePersonalRankingBoard(db, payload("2097", [first, second, third]), owner);
    expect(created.board.revision).toBe(1);

    const results = await Promise.allSettled([
      savePersonalRankingBoard(db, payload("2097", [second, first, third], 1), owner),
      savePersonalRankingBoard(db, payload("2097", [third, second, first], 1), owner),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "revision_conflict", status: 409 }),
    });

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof savePersonalRankingBoard>>>).value;
    const persisted = await getPersonalRankingBoard(db, scope("2097"), owner);
    expect(persisted?.revision).toBe(2);
    expect(persisted?.entries.map((entry) => entry.id))
      .toEqual(winner.board.entries.map((entry) => entry.id));
  });

  it("keeps boards isolated by owner and enforces one active board per owner scope", async () => {
    const first = await addPlayer("Owner One", "QB");
    const second = await addPlayer("Owner Two", "RB");
    await savePersonalRankingBoard(db, payload("2095", [first]), "owner-a");
    await savePersonalRankingBoard(db, payload("2095", [second]), "owner-b");
    expect((await getPersonalRankingBoard(db, scope("2095"), "owner-a"))?.entries[0]?.id).toBe(first);
    expect((await getPersonalRankingBoard(db, scope("2095"), "owner-b"))?.entries[0]?.id).toBe(second);

    await expect(env.DB.prepare(
      `INSERT INTO ranking_lists (
         id, owner_identity, name, ranking_type, scoring_format, season, revision, list_kind
       ) VALUES (?, 'owner-a', 'Duplicate', 'redraft', 'ppr', '2095', 0, 'personal')`,
    ).bind(crypto.randomUUID()).run()).rejects.toThrow();
  });
});
