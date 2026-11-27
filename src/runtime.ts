import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createBwrapCacheLease, registerActiveCachePath } from "./cache.js";
import type { EgressLookup } from "./egress-proxy.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import { WORKSPACE_ROOT } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import {
  createNodeProcessRunner,
  describeMissingPrereqs,
  isBwrapAvailable,
  isPythonAvailable,
} from "./process.js";
import type { BwrapSession } from "./session.js";
import { createBwrapSession } from "./session.js";

export interface BwrapSessionLocation {
  readonly id: string;
  readonly workspaceDir: string;
  /** Hidden from every sandboxed command; see `CreateBwrapSessionInput.cacheRoots`. */
  readonly cacheRoots: readonly string[];
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * The provider's session machinery: one live compute generation per
 * workspace directory, each holding a cache lease so pruning never removes a
 * workspace in use.
 */
export interface BwrapRuntime {
  /** Throws a setup message when the host cannot run bwrap or join its sandboxes. Probed once. */
  assertBwrapAvailable(): void;
  /** A throwaway session over a template being captured; it holds no lease. */
  openTemplateSession(location: BwrapSessionLocation): BwrapSession;
  /**
   * Returns the live generation for this workspace, or starts a new one.
   * `created` tells the caller whether per-generation state such as the
   * network policy still needs to be applied.
   */
  openRuntimeSession(
    location: BwrapSessionLocation & { readonly leaseRoot: string },
  ): Promise<{ readonly session: BwrapSession; readonly created: boolean }>;
  /** Drops a deleted workspace's generation so the next open starts fresh. */
  forgetRuntimeSession(workspaceDir: string): void;
  /**
   * Stops the live generation over this workspace, if there is one, and drops
   * it. Nothing is started for a workspace that has no generation, so this is
   * safe to call for a session whose sandbox was never resumed in this process.
   */
  closeRuntimeSession(workspaceDir: string): Promise<void>;
}

export function createBwrapRuntime(input: {
  readonly options: ResolvedBwrapSandboxOptions;
  /** Injectable process launcher so logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
  /** Injectable resolver for the egress proxy, so tests need no DNS. */
  readonly egressLookup?: EgressLookup;
}): BwrapRuntime {
  const { options } = input;
  const runner = input.runner ?? createNodeProcessRunner();
  const generations = new Map<string, BwrapSession>();
  // Probe only when running against the real bwrap; injected runners skip it.
  const shouldProbe = input.runner === undefined;
  let probed = false;

  function openSession(
    location: BwrapSessionLocation,
    generationId?: string,
    onStopped?: () => void | Promise<void>,
  ): BwrapSession {
    return createBwrapSession({
      id: location.id,
      workspaceDir: location.workspaceDir,
      cacheRoots: location.cacheRoots,
      runner,
      options,
      tags: location.tags,
      generationId,
      onStopped,
      ...(input.egressLookup ? { egressLookup: input.egressLookup } : {}),
    });
  }

  return {
    assertBwrapAvailable() {
      if (!shouldProbe || probed) return;
      const missing = describeMissingPrereqs({
        bwrapPresent: isBwrapAvailable(options.bwrapPath),
        pythonPresent: isPythonAvailable(options.pythonPath),
        workspaceMountpointPresent: existsSync(WORKSPACE_ROOT),
        bwrapPath: options.bwrapPath,
        pythonPath: options.pythonPath,
      });
      if (missing) throw new Error(missing);
      probed = true;
    },

    openTemplateSession(location) {
      return openSession(location);
    },

    async openRuntimeSession(location) {
      const current = generations.get(location.workspaceDir);
      if (current && current.lifecycleState() !== "stopped") {
        return { session: current, created: false };
      }
      const releaseActive = registerActiveCachePath(location.workspaceDir);
      const activeLease = await createBwrapCacheLease({
        cacheRoot: location.leaseRoot,
        sessionId: basename(location.workspaceDir),
      });
      let session: BwrapSession;
      try {
        session = openSession(location, activeLease.lease.generationId, async () => {
          releaseActive();
          await activeLease.release();
        });
      } catch (error) {
        releaseActive();
        await activeLease.release();
        throw error;
      }
      generations.set(location.workspaceDir, session);
      return { session, created: true };
    },

    forgetRuntimeSession(workspaceDir) {
      generations.delete(workspaceDir);
    },

    async closeRuntimeSession(workspaceDir) {
      const current = generations.get(workspaceDir);
      generations.delete(workspaceDir);
      await current?.killAll();
    },
  };
}
