import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxProvider,
  type WithPrepareOption,
} from "eve/sandbox/provider";
import type { BwrapSandboxEnvironmentOptions } from "./options.js";
import type { BwrapConnectionExtensions } from "./provider-contract.js";
import {
  createBwrapSandboxProviderDefinition,
  type BwrapPreparedArtifact,
  type BwrapSandboxOpenOptions,
  type BwrapSessionState,
} from "./provider-definition.js";

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
export type { BwrapConnectionExtensions, BwrapSandboxConnection } from "./provider-contract.js";
export type { BwrapNetworkPolicy, BwrapSandboxEnvironmentOptions } from "./options.js";
export { isBwrapAvailable } from "./process.js";

/** The sandbox eve hands an agent from a bwrap environment: eve's session plus `setNetworkPolicy`. */
export type BwrapSandboxSession = SandboxSession & BwrapConnectionExtensions;

/**
 * The bubblewrap sandbox provider.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { BwrapSandbox } from "@evelandhq/sandbox-bwrap/provider";
 *
 * export const environment = BwrapSandbox.environment();
 * export default defineSandbox(() => environment.open());
 * ```
 */
export const BwrapSandbox: SandboxProvider<
  WithPrepareOption<BwrapSandboxEnvironmentOptions, BwrapSandboxSession>,
  BwrapSandboxOpenOptions,
  BwrapSandboxSession
> = defineSandboxProvider<
  BwrapSandboxEnvironmentOptions,
  BwrapSandboxOpenOptions,
  BwrapPreparedArtifact,
  BwrapSessionState,
  BwrapConnectionExtensions
>(createBwrapSandboxProviderDefinition());
