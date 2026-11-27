/**
 * The package root: the provider as a plain definition, its types, the cache
 * tools, and host checks. Nothing here imports eve at run time; the ready
 * `BwrapSandbox` is in `@evelandhq/sandbox-bwrap/provider`.
 */
export { BwrapSandboxSessionGoneError, BwrapTemplateNotProvisionedError } from "./errors.js";
export {
  BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
  createBwrapSandboxProviderDefinition,
  type BwrapPreparedArtifact,
  type BwrapSandboxOpenOptions,
  type BwrapSandboxProviderDefinition,
  type BwrapSandboxProviderImplementation,
  type BwrapSessionState,
  type CreateBwrapSandboxProviderDefinitionInput,
} from "./provider-definition.js";
export type {
  BwrapConnectionExtensions,
  BwrapPrepareContext,
  BwrapSandboxConnection,
  BwrapSessionContext,
  BwrapSessionEndOptions,
  BwrapSessionIdleOptions,
} from "./provider-contract.js";
export type { BwrapNetworkPolicy, BwrapSandboxEnvironmentOptions } from "./options.js";
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
export { isBwrapAvailable, isPythonAvailable } from "./process.js";
export type { ProcessRunner, ProcessRunnerSpawnOptions, SpawnedProcess } from "./process.js";
