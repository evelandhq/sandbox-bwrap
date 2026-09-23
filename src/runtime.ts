import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createBwrapCacheLease, registerActiveCachePath } from "./cache.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import { WORKSPACE_ROOT } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import { createNodeProcessRunner, describeMissingPrereqs, isBwrapAvailable } from "./process.js";
import type { BwrapSession } from "./session.js";
import { createBwrapSession } from "./session.js";

const EVE_MODEL_SKILL_ROOT = "$HOME/.agents/skills";

export interface BwrapSeed {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface BwrapSessionLocation {
  readonly id: string;
  readonly workspaceDir: string;
  /** Hidden from every sandboxed command; see `CreateBwrapSessionInput.cacheRoots`. */
  readonly cacheRoots: readonly string[];
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * The session machinery the backend and the provider share: one live compute
 * generation per workspace directory, each holding a cache lease so pruning
 * never removes a workspace in use.
 */
export interface BwrapRuntime {
  /** Throws a setup message when the host cannot run bwrap. Probed once. */
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
}

export function createBwrapRuntime(input: {
  readonly options: ResolvedBwrapSandboxOptions;
  /** Injectable process launcher so logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
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
    });
  }

  return {
    assertBwrapAvailable() {
      if (!shouldProbe || probed) return;
      const missing = describeMissingPrereqs({
        bwrapPresent: isBwrapAvailable(options.bwrapPath),
        workspaceMountpointPresent: existsSync(WORKSPACE_ROOT),
        bwrapPath: options.bwrapPath,
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
  };
}

function resolveSeedPath(seedPath: string): string {
  if (seedPath === EVE_MODEL_SKILL_ROOT || seedPath.startsWith(`${EVE_MODEL_SKILL_ROOT}/`)) {
    return `${WORKSPACE_ROOT}/.agents/skills${seedPath.slice(EVE_MODEL_SKILL_ROOT.length)}`;
  }
  return seedPath;
}

/** Writes seeds into a session; eve's `$HOME/.agents/skills` lands under the sandbox HOME. */
export async function writeSeedFiles(
  session: BwrapSession,
  seedFiles: ReadonlyArray<BwrapSeed>,
): Promise<void> {
  for (const seed of seedFiles) {
    const seedPath = resolveSeedPath(seed.path);
    if (typeof seed.content === "string") {
      await session.writeTextFile({ path: seedPath, content: seed.content });
    } else {
      await session.writeBinaryFile({ path: seedPath, content: seed.content });
    }
  }
}
