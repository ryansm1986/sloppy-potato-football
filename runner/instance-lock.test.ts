import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunnerInstanceLock, RunnerAlreadyRunningError, runnerLockPath } from "./instance-lock.js";

const testRoot = join(tmpdir(), `sloppy-potato-instance-lock-test-${process.pid}`);
const config = {
  runnerId: "codex-test",
  workspace: join(testRoot, "workspace"),
};

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("runner single-instance lock", () => {
  it("acquires an atomic lock with non-secret owner metadata", async () => {
    const lock = await acquireRunnerInstanceLock(config, { lockRoot: testRoot });
    const metadataText = await readFile(resolve(lock.lockPath, "owner.json"), "utf8");
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      pid: process.pid,
      runnerId: config.runnerId,
      startedAt: expect.any(String),
      ownerId: expect.any(String),
    });
    expect(metadataText).not.toContain("token");
    expect(Number.isNaN(Date.parse(metadata.startedAt as string))).toBe(false);
    await lock.release();
  });

  it("rejects a second live owner quickly and reports its PID", async () => {
    const lock = await acquireRunnerInstanceLock(config, { lockRoot: testRoot });
    const started = Date.now();

    await expect(acquireRunnerInstanceLock(config, { lockRoot: testRoot })).rejects.toEqual(
      expect.objectContaining<Partial<RunnerAlreadyRunningError>>({
        name: "RunnerAlreadyRunningError",
        message: expect.stringContaining(String(process.pid)),
      }),
    );
    expect(Date.now() - started).toBeLessThan(500);
    await lock.release();
  });

  it("removes a stale dead-process lock and reacquires it", async () => {
    const lockPath = runnerLockPath(config, testRoot);
    await mkdir(lockPath, { recursive: true });
    await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({
      pid: 999_999_999,
      runnerId: config.runnerId,
      startedAt: "2025-01-01T00:00:00.000Z",
      ownerId: "stale-owner",
    }));

    const lock = await acquireRunnerInstanceLock(config, {
      lockRoot: testRoot,
      isProcessAlive: () => false,
    });
    expect(lock.metadata.ownerId).not.toBe("stale-owner");
    expect(JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("releases its lock and permits the next acquisition", async () => {
    const first = await acquireRunnerInstanceLock(config, { lockRoot: testRoot });
    await first.release();
    await expect(stat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await acquireRunnerInstanceLock(config, { lockRoot: testRoot });
    await second.release();
  });

  it("never removes a lock whose ownership metadata changed", async () => {
    const first = await acquireRunnerInstanceLock(config, { lockRoot: testRoot });
    const ownerPath = resolve(first.lockPath, "owner.json");
    const replacement = {
      ...first.metadata,
      pid: 424_242,
      ownerId: "replacement-owner",
    };
    await writeFile(ownerPath, JSON.stringify(replacement));

    await first.release();
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toMatchObject(replacement);
  });

  it("recovers an abandoned lock directory after the initialization grace period", async () => {
    const lockPath = runnerLockPath(config, testRoot);
    await mkdir(lockPath, { recursive: true });
    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);

    const lock = await acquireRunnerInstanceLock(config, {
      lockRoot: testRoot,
      initializationGraceMs: 100,
    });
    expect(lock.metadata.pid).toBe(process.pid);
    await lock.release();
  });
});
