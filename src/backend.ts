import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { SandboxBackend, SandboxSeedFile } from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import type { BwrapSandboxCreateOptions, BwrapSandboxUseOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import {
  resolveBwrapCacheRoot,
  resolveSessionPath,
  resolveTemplatePath,
  WORKSPACE_ROOT,
} from "./paths.js";
import type { ProcessRunner } from "./process.js";
import { createNodeProcessRunner, describeMissingPrereqs, isBwrapAvailable } from "./process.js";
import type { BwrapSession } from "./session.js";
import { createBwrapSession } from "./session.js";
import {
  cloneDirectoryAtomically,
  createBwrapCacheLease,
  registerActiveCachePath,
  removeCacheMetadata,
  touchCacheMetadata,
  type BwrapCloneStrategy,
  type BwrapDirectoryCopier,
} from "./cache.js";

const EVE_MODEL_SKILL_ROOT = "$HOME/.agents/skills";

/**
 * Stable backend name. Participates in eve's template/session cache-key
 * derivation and persisted reconnect state — never change it.
 */
export const BWRAP_BACKEND_NAME = "bwrap";

export interface CreateBwrapSandboxBackendInput {
  readonly createOptions?: BwrapSandboxCreateOptions;
  /** Injectable process launcher so backend logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
  /** Injectable clone primitive for filesystem-capability tests. */
  readonly copyDirectory?: BwrapDirectoryCopier;
}

export function createBwrapSandboxBackend(
  input: CreateBwrapSandboxBackendInput = {},
): SandboxBackend<BwrapSandboxUseOptions, BwrapSandboxUseOptions> {
  const options = resolveBwrapSandboxOptions(input.createOptions);
  const optionsHash = createBwrapOptionsHash(options);
  const runner = input.runner ?? createNodeProcessRunner();
  const generations = new Map<string, BwrapSession>();
  // Probe only when running against the real bwrap; injected runners skip it.
  const shouldProbe = input.runner === undefined;
  let probed = false;

  function assertBwrapAvailable(): void {
    if (!shouldProbe || probed) return;
    const missing = describeMissingPrereqs({
      bwrapPresent: isBwrapAvailable(options.bwrapPath),
      workspaceMountpointPresent: existsSync(WORKSPACE_ROOT),
      bwrapPath: options.bwrapPath,
    });
    if (missing) throw new Error(missing);
    probed = true;
  }

  function openSession(
    id: string,
    workspaceDir: string,
    appRoot: string,
    tags?: Readonly<Record<string, string>>,
    generationId?: string,
    onStopped?: () => void | Promise<void>,
  ): BwrapSession {
    return createBwrapSession({
      id,
      workspaceDir,
      appRoot,
      runner,
      options,
      tags,
      generationId,
      onStopped,
    });
  }

  async function openRuntimeSession(
    id: string,
    workspaceDir: string,
    appRoot: string,
    tags?: Readonly<Record<string, string>>,
  ): Promise<BwrapSession> {
    const current = generations.get(workspaceDir);
    if (current && current.lifecycleState() !== "stopped") return current;
    const releaseActive = registerActiveCachePath(workspaceDir);
    const cacheRoot = resolveBwrapCacheRoot(appRoot, options.cacheDir);
    const activeLease = await createBwrapCacheLease({
      cacheRoot,
      sessionId: basename(workspaceDir),
    });
    let session: BwrapSession;
    try {
      session = openSession(
        id,
        workspaceDir,
        appRoot,
        tags,
        activeLease.lease.generationId,
        async () => {
          releaseActive();
          await activeLease.release();
        },
      );
    } catch (error) {
      releaseActive();
      await activeLease.release();
      throw error;
    }
    generations.set(workspaceDir, session);
    return session;
  }

  function resolveSeedPath(seedPath: string): string {
    if (seedPath === EVE_MODEL_SKILL_ROOT || seedPath.startsWith(`${EVE_MODEL_SKILL_ROOT}/`)) {
      return `${WORKSPACE_ROOT}/.agents/skills${seedPath.slice(EVE_MODEL_SKILL_ROOT.length)}`;
    }
    return seedPath;
  }

  async function writeSeedFiles(
    session: BwrapSession,
    seedFiles: ReadonlyArray<SandboxSeedFile>,
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

  async function useSession(
    session: BwrapSession,
    useOptions?: BwrapSandboxUseOptions,
  ): Promise<BwrapSession> {
    if (useOptions?.networkPolicy !== undefined) {
      await session.setNetworkPolicy(useOptions.networkPolicy);
    }
    return session;
  }

  return {
    name: BWRAP_BACKEND_NAME,

    async prewarm({ templateKey, bootstrap, seedFiles, log, runtimeContext }) {
      assertBwrapAvailable();
      const templatePath = resolveTemplatePath(
        runtimeContext.appRoot,
        templateKey,
        optionsHash,
        options.cacheDir,
      );
      const touchTemplate = async () =>
        await touchCacheMetadata({
          cacheRoot: resolveBwrapCacheRoot(runtimeContext.appRoot, options.cacheDir),
          kind: "template",
          id: basename(templatePath),
          templateRevision: options.templateRevision,
        });
      if (existsSync(templatePath)) {
        await touchTemplate();
        return { reused: true };
      }

      log?.(`bwrap: capturing template for ${templateKey}`);
      const stagingPath = `${templatePath}.staging-${randomUUID()}`;
      await mkdir(stagingPath, { recursive: true });
      try {
        const session = openSession(templateKey, stagingPath, runtimeContext.appRoot);
        await writeSeedFiles(session, seedFiles);
        if (bootstrap) {
          await bootstrap({ use: async (useOptions) => await useSession(session, useOptions) });
        }
        await rename(stagingPath, templatePath);
      } catch (error) {
        await rm(stagingPath, { force: true, recursive: true }).catch(() => {});
        // A concurrent prewarm winning the race is reuse, not failure.
        if (existsSync(templatePath)) {
          await touchTemplate();
          return { reused: true };
        }
        throw error;
      }
      await touchTemplate();
      return { reused: false };
    },

    async create({ templateKey, sessionKey, runtimeContext, tags }) {
      assertBwrapAvailable();
      const sessionPath = resolveSessionPath(runtimeContext.appRoot, sessionKey, options.cacheDir);
      let cloneStrategy: BwrapCloneStrategy = "existing";
      if (!existsSync(sessionPath)) {
        if (templateKey === null) {
          await mkdir(sessionPath, { recursive: true });
          cloneStrategy = "empty";
        } else {
          const templatePath = resolveTemplatePath(
            runtimeContext.appRoot,
            templateKey,
            optionsHash,
            options.cacheDir,
          );
          if (!existsSync(templatePath)) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: BWRAP_BACKEND_NAME,
              templateKey,
            });
          }
          cloneStrategy = await cloneDirectoryAtomically({
            sourcePath: templatePath,
            targetPath: sessionPath,
            copyDirectory: input.copyDirectory,
          });
        }
      }
      await touchCacheMetadata({
        cacheRoot: resolveBwrapCacheRoot(runtimeContext.appRoot, options.cacheDir),
        kind: "session",
        id: basename(sessionPath),
        tags,
        cloneStrategy,
      });
      const session = await openRuntimeSession(
        sessionKey,
        sessionPath,
        runtimeContext.appRoot,
        tags,
      );
      return {
        session,
        useSessionFn: async (useOptions) => await useSession(session, useOptions),
        async captureState() {
          return { backendName: BWRAP_BACKEND_NAME, metadata: {}, sessionKey };
        },
        // eve (>=0.32) calls this when authored code runs
        // `ctx.getSandbox().stop()` mid-run: stop the compute, keep the durable
        // session. Backends with provider-side compute distinguish this from
        // shutdown() — a container to pause, a VM to snapshot. bwrap has no such
        // resource: the processes are the compute and the workspace directory is
        // the session, so stopping is killing the processes, and the next
        // create() reopens the same workspace.
        async stop() {
          await session.killAll();
        },
        // eve calls this when the server is shutting down: nothing may be left
        // running afterwards. The workspace directory IS the durable state, so
        // it stays on disk and the session reattaches on the next start.
        async shutdown() {
          await session.killAll();
        },
        // eve (>=0.47) calls this when authored code runs
        // `ctx.getSandbox().delete()`: the sandbox and its disposable state are
        // gone for good, and the next access reprovisions from the template.
        // For bwrap the disposable state is the session workspace directory and
        // its metadata sidecar; the template it was cloned from is shared and
        // must survive.
        async delete(deleteOptions) {
          deleteOptions?.abortSignal?.throwIfAborted();
          await session.killAll();
          generations.delete(sessionPath);
          await rm(sessionPath, { force: true, recursive: true });
          await removeCacheMetadata({
            cacheRoot: resolveBwrapCacheRoot(runtimeContext.appRoot, options.cacheDir),
            kind: "session",
            id: basename(sessionPath),
          });
        },
      };
    },
  };
}
