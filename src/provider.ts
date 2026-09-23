import { defineSandboxProvider } from "eve/sandbox/provider";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";

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
export { isBwrapAvailable } from "./process.js";

/**
 * The bubblewrap sandbox provider for eve 0.64 and later.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { BwrapSandbox } from "@evelandhq/sandbox-bwrap/provider";
 *
 * export const environment = BwrapSandbox.environment();
 * export default defineSandbox(() => environment.open());
 * ```
 *
 * This entry point imports `eve/sandbox/provider`, which exists only from eve
 * 0.64 on. On eve 0.62 and 0.63 use `bwrap()` from the package root.
 */
export const BwrapSandbox = defineSandboxProvider(createBwrapSandboxProviderDefinition());
