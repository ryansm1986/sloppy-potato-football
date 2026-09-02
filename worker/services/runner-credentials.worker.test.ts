import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../index";
import { enrollRunnerCredential, hashRunnerToken } from "./runner-credentials";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

const bindings = {
  DB: env.DB,
  RESEARCH_OWNER_TOKEN: "owner-secret",
  AGENT_RUNNER_TOKEN: "legacy-runner-secret",
};

function request(method: string, token?: string, body?: unknown) {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function enroll(deviceId: string, name = "Kitchen desktop") {
  const runnerId = `desktop-${(await hashRunnerToken(deviceId)).slice(0, 16)}`;
  const response = await app.request(
    "https://potato.example/api/research/runner-credentials",
    request("POST", "owner-secret", { deviceId, name, metadata: { platform: "win32" } }),
    bindings,
  );
  const body = await response.json<{
    credential: { id: string; deviceId: string; tokenHint: string; active: boolean };
    token: string;
  }>();
  return { response, runnerId, ...body };
}

describe("per-device runner credentials", () => {
  it("requires owner authorization and returns a strongly random token only once", async () => {
    const legacyBeforeEnrollment = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", "legacy-runner-secret", {
        runnerId: `legacy-${crypto.randomUUID()}`,
        name: "Legacy runner",
        provider: "codex",
        status: "idle",
      }),
      bindings,
    );
    expect(legacyBeforeEnrollment.status).toBe(200);

    const unauthorized = await app.request(
      "https://potato.example/api/research/runner-credentials",
      request("POST", "wrong", { deviceId: "runner-a", name: "Runner A" }),
      bindings,
    );
    expect(unauthorized.status).toBe(401);

    const issued = await enroll(`runner-${crypto.randomUUID()}`);
    expect(issued.response.status).toBe(201);
    expect(issued.response.headers.get("Cache-Control")).toBe("no-store");
    expect(issued.token).toMatch(new RegExp(`^spfr_${issued.credential.id}\\.[A-Za-z0-9_-]{43}$`));
    expect(issued.credential.active).toBe(true);

    const stored = await env.DB.prepare(
      "SELECT token_hash, token_hint, metadata_json FROM runner_credentials WHERE id = ?",
    ).bind(issued.credential.id).first<{
      token_hash: string;
      token_hint: string;
      metadata_json: string;
    }>();
    expect(stored?.token_hash).toBe(await hashRunnerToken(issued.token));
    expect(stored?.token_hash).not.toContain(issued.token);
    expect(stored?.token_hint).not.toBe(issued.token);
    expect(JSON.parse(stored?.metadata_json ?? "{}")).toEqual({ platform: "win32" });

    const legacyAfterEnrollment = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", "legacy-runner-secret", {
        runnerId: `legacy-${crypto.randomUUID()}`,
        name: "Legacy runner",
        provider: "codex",
        status: "idle",
      }),
      bindings,
    );
    expect(legacyAfterEnrollment.status).toBe(401);

    const list = await app.request(
      "https://potato.example/api/research/runner-credentials",
      request("GET", "owner-secret"),
      bindings,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    const text = await list.text();
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain(stored?.token_hash ?? "missing-hash");
  });

  it("authenticates the bound runner, retains legacy migration auth, and rejects invalid tokens", async () => {
    const issued = await enroll(crypto.randomUUID());
    const runnerId = issued.runnerId;
    const heartbeatBody = {
      runnerId,
      name: "Kitchen desktop",
      provider: "codex",
      version: "1.0.0",
      status: "idle",
    };
    const accepted = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", issued.token, heartbeatBody),
      bindings,
    );
    expect(accepted.status).toBe(200);

    const invalid = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", `${issued.token}x`, heartbeatBody),
      bindings,
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ error: "unauthorized" });
  });

  it("blocks a device credential from impersonating another runner on every runner write route", async () => {
    const issued = await enroll(crypto.randomUUID());
    const runnerId = issued.runnerId;
    const other = `${runnerId}-other`;
    const jobId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    const calls = [
      ["/api/runners/heartbeat", {
        runnerId: other, name: "Other", provider: "codex", status: "idle",
      }],
      ["/api/runners/jobs/claim", { runnerId: other }],
      [`/api/runners/jobs/${jobId}/result`, {
        runnerId: other,
        leaseToken,
        resultId: `result-${crypto.randomUUID()}`,
        result: { summary: "A valid-shaped result that must never reach the job service." },
      }],
      [`/api/runners/jobs/${jobId}/fail`, {
        runnerId: other,
        leaseToken,
        error: { code: "agent_failed", message: "Nope", retryable: false },
      }],
    ] as const;

    for (const [path, body] of calls) {
      const response = await app.request(
        `https://potato.example${path}`,
        request("POST", issued.token, body),
        bindings,
      );
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ error: "runner_identity_mismatch" });
    }
  });

  it("rotates a device token and revokes it individually", async () => {
    const deviceId = crypto.randomUUID();
    const first = await enroll(deviceId, "First name");
    const second = await enroll(deviceId, "Updated name");
    const runnerId = first.runnerId;
    expect(second.response.status).toBe(200);
    expect(second.credential.id).toBe(first.credential.id);
    expect(second.token).not.toBe(first.token);

    const body = { runnerId, name: "Updated name", provider: "codex", status: "idle" };
    const obsolete = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", first.token, body),
      bindings,
    );
    expect(obsolete.status).toBe(401);
    const current = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", second.token, body),
      bindings,
    );
    expect(current.status).toBe(200);

    const revoked = await app.request(
      `https://potato.example/api/research/runner-credentials/${second.credential.id}`,
      request("DELETE", "owner-secret"),
      bindings,
    );
    expect(revoked.status).toBe(204);
    const rejected = await app.request(
      "https://potato.example/api/runners/heartbeat",
      request("POST", second.token, body),
      bindings,
    );
    expect(rejected.status).toBe(401);

    const missing = await app.request(
      `https://potato.example/api/research/runner-credentials/${crypto.randomUUID()}`,
      request("DELETE", "owner-secret"),
      bindings,
    );
    expect(missing.status).toBe(404);
  });

  it("caps active credentials per owner", async () => {
    const db = drizzle(env.DB, { schema });
    const owner = `owner-${crypto.randomUUID()}`;
    for (let index = 0; index < 10; index += 1) {
      await enrollRunnerCredential(
        db,
        {
          deviceId: `device-${index}`,
          name: `Device ${index}`,
          metadata: {},
        },
        owner,
      );
    }
    await expect(enrollRunnerCredential(
      db,
      {
        deviceId: "device-11",
        name: "Device 11",
        metadata: {},
      },
      owner,
    )).rejects.toMatchObject({ code: "device_limit_reached", status: 409 });
  });
});
