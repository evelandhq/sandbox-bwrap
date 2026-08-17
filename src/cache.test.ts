import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import * as cacheModule from "./cache.js";
import * as publicApi from "./index.js";
import { createBwrapSandboxBackend } from "./backend.js";
import type { ProcessRunner } from "./process.js";

const noProcessRunner: ProcessRunner = {
  spawn() {
    throw new Error("not used");
  },
};

describe("operator cache management", () => {
  test("exposes explicit list and prune operations", () => {
    expect(cacheModule).toHaveProperty("listBwrapCache");
    expect(cacheModule).toHaveProperty("pruneBwrapCache");
    expect(publicApi).toHaveProperty("listBwrapCache");
    expect(publicApi).toHaveProperty("pruneBwrapCache");
  });

  test("lists metadata-backed entries and dry-runs age pruning without deleting", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-list-"));
    const cacheDir = path.join(appRoot, "cache");
    const oldId = "1".repeat(32);
    const recentId = "2".repeat(32);
    for (const id of [oldId, recentId]) {
      await mkdir(path.join(cacheDir, "sessions", id), { recursive: true });
      await writeFile(path.join(cacheDir, "sessions", id, "payload.txt"), id);
    }
    await cacheModule.touchCacheMetadata({
      cacheRoot: cacheDir,
      kind: "session",
      id: oldId,
      now: new Date("2026-01-01T00:00:00.000Z"),
      cloneStrategy: "copy",
    });
    await cacheModule.touchCacheMetadata({
      cacheRoot: cacheDir,
      kind: "session",
      id: recentId,
      now: new Date("2026-01-09T00:00:00.000Z"),
      cloneStrategy: "reflink",
    });

    const entries = await cacheModule.listBwrapCache({ appRoot, cacheDir });
    expect(entries.map((entry) => entry.id)).toEqual([oldId, recentId]);
    expect(entries[0]).toMatchObject({
      kind: "session",
      metadataPresent: true,
      active: false,
      cloneStrategy: "copy",
    });
    expect(entries[0]!.sizeBytes).toBeGreaterThan(0);

    const result = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: true,
      sessions: { maxAgeMs: 2 * 24 * 60 * 60 * 1000 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(result.dryRun).toBe(true);
    expect((result as unknown as { candidates: Array<{ id: string }> }).candidates).toMatchObject([
      { id: oldId },
    ]);
    expect(result.removed).toEqual([]);
    expect(existsSync(path.join(cacheDir, "sessions", oldId))).toBe(true);
  });

  test("preserves metadata fields when a later use only updates last-used time", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-touch-"));
    const cacheDir = path.join(appRoot, "cache");
    const id = "3".repeat(32);
    await cacheModule.touchCacheMetadata({
      cacheRoot: cacheDir,
      kind: "session",
      id,
      tags: { project: "keep-me" },
      cloneStrategy: "reflink",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const metadata = await cacheModule.touchCacheMetadata({
      cacheRoot: cacheDir,
      kind: "session",
      id,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(metadata).toMatchObject({
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-02T00:00:00.000Z",
      tags: { project: "keep-me" },
      cloneStrategy: "reflink",
    });
  });

  test("applies explicit LRU pruning and never trusts a metadata-supplied path", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-prune-"));
    const cacheDir = path.join(appRoot, "cache");
    const outside = path.join(appRoot, "outside.txt");
    await writeFile(outside, "keep");
    const oldId = "a".repeat(32);
    const recentId = "b".repeat(32);
    for (const [id, used] of [
      [oldId, "2026-01-01T00:00:00.000Z"],
      [recentId, "2026-01-09T00:00:00.000Z"],
    ] as const) {
      await mkdir(path.join(cacheDir, "sessions", id), { recursive: true });
      await writeFile(path.join(cacheDir, "sessions", id, "payload.txt"), id);
      await cacheModule.touchCacheMetadata({
        cacheRoot: cacheDir,
        kind: "session",
        id,
        now: new Date(used),
      });
    }
    const oldMetadataPath = path.join(cacheDir, "metadata", "sessions", `${oldId}.json`);
    const oldMetadata = JSON.parse(await readFile(oldMetadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(oldMetadataPath, JSON.stringify({ ...oldMetadata, path: outside }));

    const result = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: false,
      sessions: { maxEntries: 1 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });

    expect(result.removed.map((entry) => entry.id)).toEqual([oldId]);
    expect(existsSync(path.join(cacheDir, "sessions", oldId))).toBe(false);
    expect(existsSync(path.join(cacheDir, "sessions", recentId))).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("keep");
  });

  test("refuses to prune a workspace owned by a live compute generation", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-active-"));
    const cacheDir = path.join(appRoot, "cache");
    const backend = createBwrapSandboxBackend({
      runner: noProcessRunner,
      createOptions: { cacheDir },
    });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "active-session",
      runtimeContext: { appRoot },
    });

    const protectedResult = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: false,
      sessions: { maxEntries: 0 },
    });
    expect(protectedResult.removed).toEqual([]);
    expect(protectedResult.skippedActive).toHaveLength(1);
    expect(protectedResult.retained.map((entry) => entry.id)).toEqual([
      protectedResult.skippedActive[0]!.id,
    ]);
    expect(existsSync(protectedResult.skippedActive[0]!.path)).toBe(true);

    await handle.stop();
    const afterStop = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: false,
      sessions: { maxEntries: 0 },
    });
    expect(afterStop.removed).toHaveLength(1);
  });

  test("keeps an active reference count across backend instances", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-active-refcount-"));
    const cacheDir = path.join(appRoot, "cache");
    const create = async () =>
      await createBwrapSandboxBackend({
        runner: noProcessRunner,
        createOptions: { cacheDir },
      }).create({
        templateKey: null,
        sessionKey: "shared-active-session",
        runtimeContext: { appRoot },
      });
    const first = await create();
    const second = await create();

    await first.stop();
    const stillProtected = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: false,
      sessions: { maxEntries: 0 },
    });
    expect(stillProtected.removed).toEqual([]);
    expect(stillProtected.skippedActive).toHaveLength(1);

    await second.stop();
    const released = await cacheModule.pruneBwrapCache({
      appRoot,
      cacheDir,
      dryRun: false,
      sessions: { maxEntries: 0 },
    });
    expect(released.removed).toHaveLength(1);
  });

  test("persists active leases outside workspaces for cross-process prune safety", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-lease-"));
    const cacheDir = path.join(appRoot, "cache");
    const backend = createBwrapSandboxBackend({
      runner: noProcessRunner,
      createOptions: { cacheDir },
    });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "leased-session",
      runtimeContext: { appRoot },
    });

    const leases = await cacheModule.listBwrapCacheLeases({ appRoot, cacheDir });
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ sessionId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(leases[0]!.path).toContain(path.join(cacheDir, "metadata", "active", "sessions"));

    await handle.stop();
    await expect(cacheModule.listBwrapCacheLeases({ appRoot, cacheDir })).resolves.toEqual([]);
  });
});
