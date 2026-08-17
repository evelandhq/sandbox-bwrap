import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type BwrapCacheEntryKind = "session" | "template";
export type BwrapCloneStrategy = "empty" | "reflink" | "copy" | "existing";

export interface BwrapCacheMetadata {
  readonly schemaVersion: 1;
  readonly kind: BwrapCacheEntryKind;
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly cloneStrategy?: BwrapCloneStrategy;
  readonly templateRevision?: string;
}

export interface BwrapCacheEntry extends BwrapCacheMetadata {
  readonly path: string;
  readonly sizeBytes: number;
  readonly active: boolean;
  readonly metadataPresent: boolean;
}

export interface BwrapCacheLocation {
  readonly appRoot: string;
  readonly cacheDir?: string | null;
}

export interface BwrapCachePrunePolicy {
  readonly maxAgeMs?: number;
  readonly maxEntries?: number;
}

export interface BwrapCachePruneInput extends BwrapCacheLocation {
  readonly dryRun?: boolean;
  readonly sessions?: BwrapCachePrunePolicy;
  readonly templates?: BwrapCachePrunePolicy;
  readonly now?: Date;
}

export interface BwrapCachePruneResult {
  readonly dryRun: boolean;
  readonly candidates: readonly BwrapCacheEntry[];
  readonly removed: readonly BwrapCacheEntry[];
  readonly skippedActive: readonly BwrapCacheEntry[];
  readonly retained: readonly BwrapCacheEntry[];
}

export interface BwrapCacheLease {
  readonly sessionId: string;
  readonly generationId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly path: string;
}

const activeCachePaths = new Map<string, number>();

export function registerActiveCachePath(path: string): () => void {
  const resolved = resolve(path);
  activeCachePaths.set(resolved, (activeCachePaths.get(resolved) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeCachePaths.get(resolved) ?? 1) - 1;
    if (remaining <= 0) activeCachePaths.delete(resolved);
    else activeCachePaths.set(resolved, remaining);
  };
}

function resolveCacheRoot(input: BwrapCacheLocation): string {
  return resolve(input.cacheDir ?? join(input.appRoot, ".eve", "sandbox-cache", "bwrap"));
}

function leaseDirectory(cacheRoot: string): string {
  return join(cacheRoot, "metadata", "active", "sessions");
}

export async function createBwrapCacheLease(input: {
  cacheRoot: string;
  sessionId: string;
}): Promise<{ lease: BwrapCacheLease; release(): Promise<void> }> {
  const generationId = randomUUID();
  const directory = leaseDirectory(input.cacheRoot);
  const path = join(directory, `${input.sessionId}.${generationId}.json`);
  const lease: BwrapCacheLease = {
    sessionId: input.sessionId,
    generationId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    path,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let released = false;
  return {
    lease,
    async release() {
      if (released) return;
      await rm(path, { force: true });
      released = true;
    },
  };
}

export async function listBwrapCacheLeases(input: BwrapCacheLocation): Promise<BwrapCacheLease[]> {
  const cacheRoot = resolveCacheRoot(input);
  const directory = leaseDirectory(cacheRoot);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const leases = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name): Promise<BwrapCacheLease | null> => {
        const path = join(directory, name);
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as Partial<BwrapCacheLease>;
          if (
            typeof value.sessionId !== "string" ||
            !validEntryId("session", value.sessionId) ||
            typeof value.generationId !== "string" ||
            typeof value.pid !== "number" ||
            typeof value.createdAt !== "string"
          ) {
            return null;
          }
          return { ...value, path } as BwrapCacheLease;
        } catch {
          return null;
        }
      }),
  );
  return leases
    .filter((lease): lease is BwrapCacheLease => lease !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function validEntryId(kind: BwrapCacheEntryKind, id: string): boolean {
  return kind === "session" ? /^[0-9a-f]{32}$/.test(id) : /^[0-9a-f]{32}-[0-9a-f]{16}$/.test(id);
}

async function directorySize(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  const children = await readdir(path);
  const sizes = await Promise.all(
    children.map(async (child) => await directorySize(join(path, child))),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function listKind(
  cacheRoot: string,
  kind: BwrapCacheEntryKind,
  leasedSessionIds: ReadonlySet<string>,
): Promise<BwrapCacheEntry[]> {
  const directory = join(cacheRoot, `${kind}s`);
  const children = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const entries = await Promise.all(
    children
      .filter((child) => child.isDirectory() && validEntryId(kind, child.name))
      .map(async (child): Promise<BwrapCacheEntry> => {
        const entryPath = join(directory, child.name);
        const info = await lstat(entryPath);
        const stored = await readMetadata(metadataPath(cacheRoot, kind, child.name));
        const metadata =
          stored?.kind === kind && stored.id === child.name
            ? stored
            : {
                schemaVersion: 1 as const,
                kind,
                id: child.name,
                createdAt: info.birthtime.toISOString(),
                lastUsedAt: info.mtime.toISOString(),
              };
        return {
          ...metadata,
          path: entryPath,
          sizeBytes: await directorySize(entryPath),
          active: activeCachePaths.has(entryPath) || leasedSessionIds.has(child.name),
          metadataPresent: stored !== null && stored.kind === kind && stored.id === child.name,
        };
      }),
  );
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listBwrapCache(input: BwrapCacheLocation): Promise<BwrapCacheEntry[]> {
  const cacheRoot = resolveCacheRoot(input);
  const leases = await listBwrapCacheLeases(input);
  const leasedSessionIds = new Set(leases.map((lease) => lease.sessionId));
  const [sessions, templates] = await Promise.all([
    listKind(cacheRoot, "session", leasedSessionIds),
    listKind(cacheRoot, "template", leasedSessionIds),
  ]);
  return [...sessions, ...templates];
}

function validatePolicy(kind: BwrapCacheEntryKind, policy: BwrapCachePrunePolicy): void {
  if (
    policy.maxAgeMs !== undefined &&
    (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0)
  ) {
    throw new Error(`bwrap sandbox: ${kind} maxAgeMs must be a non-negative safe integer`);
  }
  if (
    policy.maxEntries !== undefined &&
    (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 0)
  ) {
    throw new Error(`bwrap sandbox: ${kind} maxEntries must be a non-negative safe integer`);
  }
  if (policy.maxAgeMs === undefined && policy.maxEntries === undefined) {
    throw new Error(`bwrap sandbox: ${kind} prune policy must set maxAgeMs or maxEntries`);
  }
}

function selectCandidates(
  entries: readonly BwrapCacheEntry[],
  policy: BwrapCachePrunePolicy,
  nowMs: number,
): Set<BwrapCacheEntry> {
  const selected = new Set<BwrapCacheEntry>();
  if (policy.maxAgeMs !== undefined) {
    for (const entry of entries) {
      if (nowMs - Date.parse(entry.lastUsedAt) > policy.maxAgeMs) selected.add(entry);
    }
  }
  if (policy.maxEntries !== undefined && entries.length > policy.maxEntries) {
    const oldestFirst = [...entries].sort(
      (a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt) || a.id.localeCompare(b.id),
    );
    for (const entry of oldestFirst.slice(0, entries.length - policy.maxEntries)) {
      selected.add(entry);
    }
  }
  return selected;
}

export async function pruneBwrapCache(input: BwrapCachePruneInput): Promise<BwrapCachePruneResult> {
  if (!input.sessions && !input.templates) {
    throw new Error("bwrap sandbox: cache prune requires a sessions or templates policy");
  }
  if (input.sessions) validatePolicy("session", input.sessions);
  if (input.templates) validatePolicy("template", input.templates);
  const entries = await listBwrapCache(input);
  const nowMs = (input.now ?? new Date()).getTime();
  const selected = new Set<BwrapCacheEntry>();
  for (const [kind, policy] of [
    ["session", input.sessions],
    ["template", input.templates],
  ] as const) {
    if (!policy) continue;
    const matches = entries.filter((entry) => entry.kind === kind);
    for (const entry of selectCandidates(matches, policy, nowMs)) selected.add(entry);
  }
  const candidates = [...selected].sort((a, b) => a.path.localeCompare(b.path));
  const skippedActive = candidates.filter(
    (entry) => entry.active || activeCachePaths.has(entry.path),
  );
  const removable = candidates.filter((entry) => !skippedActive.includes(entry));
  const removed: BwrapCacheEntry[] = [];
  if (input.dryRun === false) {
    const cacheRoot = resolveCacheRoot(input);
    for (const entry of removable) {
      const leased = (await listBwrapCacheLeases(input)).some(
        (lease) => lease.sessionId === entry.id,
      );
      if (activeCachePaths.has(entry.path) || leased) {
        skippedActive.push(entry);
        continue;
      }
      await rm(entry.path, { force: true, recursive: true });
      await rm(metadataPath(cacheRoot, entry.kind, entry.id), { force: true });
      removed.push(entry);
    }
  }
  return {
    dryRun: input.dryRun !== false,
    candidates,
    removed,
    skippedActive,
    retained: entries.filter(
      (entry) =>
        !removed.includes(entry) && (!selected.has(entry) || skippedActive.includes(entry)),
    ),
  };
}

export type BwrapDirectoryCopier = (
  source: string,
  target: string,
  options: { recursive: true; mode?: number },
) => Promise<void>;

const reflinkFallbackCodes = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

export async function cloneDirectoryAtomically(input: {
  sourcePath: string;
  targetPath: string;
  copyDirectory?: BwrapDirectoryCopier;
}): Promise<BwrapCloneStrategy> {
  const copyDirectory: BwrapDirectoryCopier =
    input.copyDirectory ?? (async (source, target, options) => await cp(source, target, options));
  const temporary = `${input.targetPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(input.targetPath), { recursive: true });
  try {
    let strategy: BwrapCloneStrategy = "reflink";
    try {
      await copyDirectory(input.sourcePath, temporary, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE_FORCE,
      });
    } catch (error) {
      if (!reflinkFallbackCodes.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      strategy = "copy";
      await rm(temporary, { force: true, recursive: true });
      await copyDirectory(input.sourcePath, temporary, { recursive: true });
    }
    await rename(temporary, input.targetPath);
    return strategy;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true }).catch(() => {});
    if (existsSync(input.targetPath)) return "existing";
    throw error;
  }
}

function metadataPath(cacheRoot: string, kind: BwrapCacheEntryKind, id: string): string {
  return join(cacheRoot, "metadata", `${kind}s`, `${id}.json`);
}

async function readMetadata(path: string): Promise<BwrapCacheMetadata | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<BwrapCacheMetadata>;
    return value.schemaVersion === 1 ? (value as BwrapCacheMetadata) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function touchCacheMetadata(input: {
  cacheRoot: string;
  kind: BwrapCacheEntryKind;
  id: string;
  tags?: Readonly<Record<string, string>>;
  cloneStrategy?: BwrapCloneStrategy;
  templateRevision?: string | null;
  now?: Date;
}): Promise<BwrapCacheMetadata> {
  const target = metadataPath(input.cacheRoot, input.kind, input.id);
  const existing = await readMetadata(target);
  const now = (input.now ?? new Date()).toISOString();
  const tags = input.tags ?? existing?.tags;
  const cloneStrategy =
    input.cloneStrategy === "existing"
      ? (existing?.cloneStrategy ?? "existing")
      : (input.cloneStrategy ?? existing?.cloneStrategy);
  const templateRevision = input.templateRevision ?? existing?.templateRevision;
  const metadata: BwrapCacheMetadata = {
    schemaVersion: 1,
    kind: input.kind,
    id: input.id,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
    ...(cloneStrategy ? { cloneStrategy } : {}),
    ...(templateRevision ? { templateRevision } : {}),
  };
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return metadata;
}
