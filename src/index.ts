import type { SandboxBackend } from "eve/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";
import type { BwrapSandboxCreateOptions, BwrapSandboxUseOptions } from "./options.js";

export {
  BWRAP_BACKEND_NAME,
  createBwrapSandboxBackend,
  type CreateBwrapSandboxBackendInput,
} from "./backend.js";
export type {
  BwrapNetworkPolicy,
  BwrapSandboxCreateOptions,
  BwrapSandboxUseOptions,
} from "./options.js";
export type {
  BwrapCommandFinishReason,
  BwrapSandboxEvent,
  BwrapSandboxEventSink,
} from "./events.js";
export { listBwrapCache, listBwrapCacheLeases, pruneBwrapCache } from "./cache.js";
export type {
  BwrapCacheEntry,
  BwrapCacheEntryKind,
  BwrapCacheLocation,
  BwrapCacheLease,
  BwrapCacheMetadata,
  BwrapCachePruneInput,
  BwrapCachePrunePolicy,
  BwrapCachePruneResult,
  BwrapCloneStrategy,
} from "./cache.js";
export {
  DEFAULT_MAX_CONCURRENT_PROCESSES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
} from "./options.js";
export { isBwrapAvailable } from "./process.js";
export type { ProcessRunner, SpawnedProcess } from "./process.js";

/**
 * Creates the bubblewrap sandbox backend for `defineSandbox({ backend })`.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox, defaultBackend } from "eve/sandbox";
 * import { bwrap, isBwrapAvailable } from "@evelandhq/sandbox-bwrap";
 *
 * export default defineSandbox({
 *   backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
 * });
 * ```
 */
export function bwrap(
  options?: BwrapSandboxCreateOptions,
): SandboxBackend<BwrapSandboxUseOptions, BwrapSandboxUseOptions> {
  return createBwrapSandboxBackend({ createOptions: options });
}
