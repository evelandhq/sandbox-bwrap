import { createHash } from "node:crypto";
import type { BwrapSandboxEventSink } from "./events.js";

/** Coarse egress control, matching what eve's Docker backend supports. */
export type BwrapNetworkPolicy = "allow-all" | "deny-all";

/** Options lifecycle hooks can apply when they open a template or live Session. */
export interface BwrapSandboxUseOptions {
  /** Network policy used by subsequent commands in this lifecycle callback. */
  readonly networkPolicy?: BwrapNetworkPolicy;
}

/** Commands executed through `run()` are bounded by default; use `spawn()` for daemons. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** Per-generation admission ceiling for transient bwrap commands. */
export const DEFAULT_MAX_CONCURRENT_PROCESSES = 64;

/** Combined stdout + stderr retained by one `run()` call. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Options accepted by `bwrap(opts)`. */
export interface BwrapSandboxCreateOptions {
  /** Environment variables set for every command the backend runs. */
  readonly env?: Readonly<Record<string, string>>;
  /** Initial network policy for sandboxed commands. Defaults to `"allow-all"`. */
  readonly networkPolicy?: BwrapNetworkPolicy;
  /** Extra host paths hidden from the sandbox (each mounted over with an empty tmpfs). */
  readonly hidePaths?: readonly string[];
  /** bwrap executable path. Defaults to `"bwrap"` resolved via PATH. */
  readonly bwrapPath?: string;
  /**
   * Absolute directory holding templates and durable session workspaces.
   * Defaults to `<appRoot>/.eve/sandbox-cache/bwrap`. Pin it outside the
   * release directory so a redeploy does not discard durable session state
   * (eve keys session sandboxes per durable session, not per deployment).
   */
  readonly cacheDir?: string;
  /**
   * Immutable release identity used to refresh workspace templates after a
   * deploy. It deliberately affects templates only; durable session paths
   * remain keyed solely by Eve's session key.
   */
  readonly templateRevision?: string;
  /**
   * Hard wall-clock limit for one `run()` command. Defaults to 10 minutes.
   * Set to `null` to disable. This does not apply to the deliberately
   * long-running `spawn()` API.
   */
  readonly runTimeoutMs?: number | null;
  /** Maximum live `run()`/`spawn()` processes in one compute generation. */
  readonly maxConcurrentProcesses?: number | null;
  /** Maximum combined stdout/stderr bytes retained by one `run()` call. */
  readonly maxOutputBytes?: number | null;
  /** Best-effort structured lifecycle events. Sink errors never affect commands. */
  readonly onEvent?: BwrapSandboxEventSink;
}

/** Fully-defaulted options consumed by the backend implementation. */
export interface ResolvedBwrapSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly networkPolicy: BwrapNetworkPolicy;
  readonly hidePaths: readonly string[];
  readonly bwrapPath: string;
  readonly cacheDir: string | null;
  readonly templateRevision: string | null;
  readonly runTimeoutMs: number | null;
  readonly maxConcurrentProcesses: number | null;
  readonly maxOutputBytes: number | null;
  readonly onEvent?: BwrapSandboxEventSink;
}

function resolveRunTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) return null;
  const resolved = value ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("bwrap sandbox: runTimeoutMs must be a positive safe integer or null");
  }
  return resolved;
}

function resolvePositiveLimit(
  name: string,
  value: number | null | undefined,
  fallback: number,
): number | null {
  if (value === null) return null;
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`bwrap sandbox: ${name} must be a positive safe integer or null`);
  }
  return resolved;
}

export function resolveBwrapSandboxOptions(
  options: BwrapSandboxCreateOptions = {},
): ResolvedBwrapSandboxOptions {
  return {
    env: options.env ?? {},
    networkPolicy: options.networkPolicy ?? "allow-all",
    hidePaths: options.hidePaths ?? [],
    bwrapPath: options.bwrapPath ?? "bwrap",
    cacheDir: options.cacheDir ?? null,
    templateRevision: options.templateRevision ?? null,
    runTimeoutMs: resolveRunTimeoutMs(options.runTimeoutMs),
    maxConcurrentProcesses: resolvePositiveLimit(
      "maxConcurrentProcesses",
      options.maxConcurrentProcesses,
      DEFAULT_MAX_CONCURRENT_PROCESSES,
    ),
    maxOutputBytes: resolvePositiveLimit(
      "maxOutputBytes",
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
    ),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
}

/**
 * Hash of the resolved options. Participates in template path derivation so
 * templates captured under different options never mix (parity with the
 * Docker backend's options hash).
 */
export function createBwrapOptionsHash(options: ResolvedBwrapSandboxOptions): string {
  const canonical = JSON.stringify({
    bwrapPath: options.bwrapPath,
    cacheDir: options.cacheDir,
    env: Object.fromEntries(Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    hidePaths: [...options.hidePaths],
    maxConcurrentProcesses: options.maxConcurrentProcesses,
    maxOutputBytes: options.maxOutputBytes,
    networkPolicy: options.networkPolicy,
    runTimeoutMs: options.runTimeoutMs,
    templateRevision: options.templateRevision,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
