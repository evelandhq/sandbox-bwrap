import { createBwrapSandboxBackend } from "./backend.js";
import type { BwrapSandboxBackend } from "./backend-contract.js";
import type { BwrapSandboxCreateOptions } from "./options.js";

export {
  BWRAP_BACKEND_NAME,
  createBwrapSandboxBackend,
  type CreateBwrapSandboxBackendInput,
} from "./backend.js";
export type {
  BwrapBackendBootstrapContext,
  BwrapBackendCreateInput,
  BwrapBackendHandle,
  BwrapBackendPrewarmInput,
  BwrapBackendRuntimeContext,
  BwrapBackendSessionState,
  BwrapSandboxBackend,
  BwrapSeedFile,
} from "./backend-contract.js";
export { BwrapTemplateNotProvisionedError } from "./errors.js";
export {
  BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
  createBwrapSandboxProviderDefinition,
  type BwrapPreparedArtifact,
  type BwrapSandboxEnvironmentOptions,
  type BwrapSandboxOpenOptions,
  type BwrapSandboxProviderDefinition,
  type BwrapSessionState,
  type CreateBwrapSandboxProviderDefinitionInput,
} from "./provider-definition.js";
export type { BwrapSession } from "./session.js";
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
 * Creates the bubblewrap sandbox backend for `defineSandbox({ backend })`, the
 * sandbox API of eve 0.62 and 0.63. On eve 0.64 and later use `BwrapSandbox`
 * from `@evelandhq/sandbox-bwrap/provider` instead.
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
export function bwrap(options?: BwrapSandboxCreateOptions): BwrapSandboxBackend {
  return createBwrapSandboxBackend({ createOptions: options });
}
