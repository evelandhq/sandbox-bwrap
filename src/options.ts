import { createHash } from "node:crypto";
import type { BwrapSandboxEventSink } from "./events.js";

/** Coarse egress control, matching what eve's Docker provider supports. */
export type BwrapNetworkPolicy = "allow-all" | "deny-all";

/** Default wall-clock limit for every sandboxed command, `spawn()` included. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** Per-generation admission ceiling for transient bwrap commands. */
export const DEFAULT_MAX_CONCURRENT_PROCESSES = 64;

/** Default limit on the combined stdout + stderr bytes one command delivers. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Options for `BwrapSandbox.environment(...)`. */
export interface BwrapSandboxEnvironmentOptions {
  /** Environment variables set for every sandboxed command. */
  readonly env?: Readonly<Record<string, string>>;
  /** Initial network policy for sandboxed commands. Defaults to `"allow-all"`. */
  readonly networkPolicy?: BwrapNetworkPolicy;
  /** Extra host paths hidden from the sandbox (each mounted over with an empty tmpfs). */
  readonly hidePaths?: readonly string[];
  /** bwrap executable path. Defaults to `"bwrap"` resolved via PATH. */
  readonly bwrapPath?: string;
  /**
   * Absolute directory holding durable session workspaces. Defaults to the
   * storage directory eve gives the provider, which belongs to one build. Pin
   * it outside the release directory so a redeploy does not discard durable
   * session state: eve keys sandboxes per durable session, not per deployment.
   */
  readonly cacheDir?: string;
  /**
   * Hard wall-clock limit for every sandboxed command, each `spawn()` and the
   * `run()` built on it. At the limit the command's process group is killed and
   * `wait()` rejects. Defaults to 10 minutes. Set to `null` to disable, which a
   * long-running spawned process such as a dev server needs.
   */
  readonly runTimeoutMs?: number | null;
  /** Maximum live commands in one compute generation. */
  readonly maxConcurrentProcesses?: number | null;
  /**
   * Maximum combined stdout/stderr bytes one command delivers to its caller.
   * At the limit its streams fail after the bytes that fit, the process group
   * is killed, and `wait()` rejects. Set to `null` to disable.
   */
  readonly maxOutputBytes?: number | null;
  /** Best-effort structured lifecycle events. Sink errors never affect commands. */
  readonly onEvent?: BwrapSandboxEventSink;
}

/** Fully-defaulted options. */
export interface ResolvedBwrapSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly networkPolicy: BwrapNetworkPolicy;
  readonly hidePaths: readonly string[];
  readonly bwrapPath: string;
  readonly cacheDir: string | null;
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
  options: BwrapSandboxEnvironmentOptions = {},
): ResolvedBwrapSandboxOptions {
  return {
    env: options.env ?? {},
    networkPolicy: options.networkPolicy ?? "allow-all",
    hidePaths: options.hidePaths ?? [],
    bwrapPath: options.bwrapPath ?? "bwrap",
    cacheDir: options.cacheDir ?? null,
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
 * templates captured under different options never mix.
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
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
