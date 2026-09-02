import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

type CredentialRow = {
  id: string;
  owner_identity: string;
  device_id: string;
  runner_id: string;
  name: string;
  token_hint: string;
  metadata_json: string;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};

export type AuthenticatedRunnerCredential = {
  credentialId: string;
  ownerIdentity: string;
  deviceId: string;
  runnerId: string;
  name: string;
};

const deviceId = z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/);
const metadata = z.record(z.string().trim().min(1).max(60), z.string().trim().max(300))
  .refine((value) => JSON.stringify(value).length <= 2_048, "Runner metadata is too large");

export const enrollRunnerCredentialInput = z.object({
  deviceId,
  name: z.string().trim().min(2).max(100),
  metadata: metadata.optional().default({}),
});

export class RunnerCredentialError extends Error {
  constructor(
    public readonly code:
      | "credential_not_found"
      | "device_limit_reached"
      | "credential_in_use"
      | "enrollment_conflict",
    message: string,
    public readonly status: 404 | 409,
  ) {
    super(message);
  }
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

function toPublicCredential(row: CredentialRow) {
  return {
    id: row.id,
    deviceId: row.device_id,
    runnerId: row.runner_id,
    name: row.name,
    tokenHint: row.token_hint,
    metadata: parseMetadata(row.metadata_json),
    active: row.revoked_at === null,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function createRunnerSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function hashRunnerToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secureTokenEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([hashRunnerToken(left), hashRunnerToken(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

export async function enrollRunnerCredential(
  db: Database,
  input: z.infer<typeof enrollRunnerCredentialInput>,
  ownerIdentity = "primary-owner",
) {
  const now = Date.now();
  const authoritativeRunnerId = `desktop-${(await hashRunnerToken(input.deviceId)).slice(0, 16)}`;
  const prior = await db.$client.prepare(
    "SELECT id, token_hash, revoked_at FROM runner_credentials WHERE owner_identity = ? AND device_id = ?",
  ).bind(ownerIdentity, input.deviceId).first<{
    id: string;
    token_hash: string;
    revoked_at: number | null;
  }>();
  if (!prior || prior.revoked_at !== null) {
    const active = await db.$client.prepare(
      "SELECT COUNT(*) AS count FROM runner_credentials WHERE owner_identity = ? AND revoked_at IS NULL",
    ).bind(ownerIdentity).first<{ count: number }>();
    if ((active?.count ?? 0) >= 10) {
      throw new RunnerCredentialError(
        "device_limit_reached",
        "Revoke an existing runner before enrolling another computer",
        409,
      );
    }
  }
  if (prior?.revoked_at === null) {
    const activeJob = await db.$client.prepare(
      `SELECT jobs.id
       FROM research_runners runners
       JOIN research_jobs jobs ON jobs.id = runners.current_job_id
       WHERE runners.id = ? AND jobs.status = 'running' AND jobs.lease_expires_at >= ?
       LIMIT 1`,
    ).bind(authoritativeRunnerId, now).first<{ id: string }>();
    if (activeJob) {
      throw new RunnerCredentialError(
        "credential_in_use",
        "Let this runner finish or stop its current job before replacing its credential",
        409,
      );
    }
  }
  const id = prior?.id ?? crypto.randomUUID();
  // The ID is public and lets authentication do one indexed lookup. Security
  // comes from the independent 256-bit secret; only its SHA-256 hash is stored.
  const token = `spfr_${id}.${createRunnerSecret()}`;
  const tokenHash = await hashRunnerToken(token);
  const tokenHint = `spfr_${id.slice(0, 8)}...${token.slice(-4)}`;

  if (prior) {
    const updated = await db.$client.prepare(
      `UPDATE runner_credentials SET
         runner_id = ?, name = ?, token_hash = ?, token_hint = ?, metadata_json = ?,
         last_used_at = NULL, revoked_at = NULL, updated_at = ?
       WHERE id = ? AND owner_identity = ? AND token_hash = ?`,
    ).bind(
      authoritativeRunnerId,
      input.name,
      tokenHash,
      tokenHint,
      JSON.stringify(input.metadata),
      now,
      id,
      ownerIdentity,
      prior.token_hash,
    ).run();
    if ((updated.meta.changes ?? 0) === 0) {
      throw new RunnerCredentialError(
        "enrollment_conflict",
        "This runner credential changed during enrollment; try again",
        409,
      );
    }
  } else {
    try {
      await db.$client.prepare(
        `INSERT INTO runner_credentials
           (id, owner_identity, device_id, runner_id, name, token_hash, token_hint, metadata_json,
            last_used_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).bind(
        id,
        ownerIdentity,
        input.deviceId,
        authoritativeRunnerId,
        input.name,
        tokenHash,
        tokenHint,
        JSON.stringify(input.metadata),
        now,
        now,
      ).run();
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
      throw new RunnerCredentialError(
        "enrollment_conflict",
        "This runner was enrolled by another request; try again",
        409,
      );
    }
  }

  const row = await db.$client.prepare(
    "SELECT * FROM runner_credentials WHERE id = ? AND owner_identity = ?",
  ).bind(id, ownerIdentity).first<CredentialRow>();
  return { credential: toPublicCredential(row!), token, created: !prior };
}

export async function listRunnerCredentials(db: Database, ownerIdentity = "primary-owner") {
  const result = await db.$client.prepare(
    `SELECT id, owner_identity, device_id, runner_id, name, token_hint, metadata_json, last_used_at,
            revoked_at, created_at, updated_at
     FROM runner_credentials
     WHERE owner_identity = ?
     ORDER BY created_at DESC, id DESC`,
  ).bind(ownerIdentity).all<CredentialRow>();
  return result.results.map(toPublicCredential);
}

export async function revokeRunnerCredential(
  db: Database,
  credentialId: string,
  ownerIdentity = "primary-owner",
) {
  const now = Date.now();
  const result = await db.$client.prepare(
    `UPDATE runner_credentials SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE id = ? AND owner_identity = ?`,
  ).bind(now, now, credentialId, ownerIdentity).run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new RunnerCredentialError("credential_not_found", "Runner credential not found", 404);
  }
}

export async function authenticateRunnerCredential(
  db: Database,
  token: string,
): Promise<AuthenticatedRunnerCredential | null> {
  const match = /^spfr_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const tokenHash = await hashRunnerToken(token);
  const row = await db.$client.prepare(
    `SELECT id, owner_identity, device_id, runner_id, name, last_used_at
     FROM runner_credentials
     WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`,
  ).bind(match[1], tokenHash).first<{
    id: string;
    owner_identity: string;
    device_id: string;
    runner_id: string;
    name: string;
    last_used_at: number | null;
  }>();
  if (!row) return null;

  const now = Date.now();
  if (row.last_used_at === null || row.last_used_at < now - 5 * 60_000) {
    await db.$client.prepare(
      "UPDATE runner_credentials SET last_used_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(now, now, row.id).run();
  }
  return {
    credentialId: row.id,
    ownerIdentity: row.owner_identity,
    deviceId: row.device_id,
    runnerId: row.runner_id,
    name: row.name,
  };
}

export async function hasEnrolledRunnerCredentials(db: Database) {
  const row = await db.$client.prepare(
    "SELECT 1 AS present FROM runner_credentials LIMIT 1",
  ).first<{ present: number }>();
  return row?.present === 1;
}
