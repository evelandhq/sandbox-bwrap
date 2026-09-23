import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { BwrapSandboxBackend } from "./backend-contract.js";
import { BwrapTemplateNotProvisionedError } from "./errors.js";
import type { BwrapSandboxCreateOptions, BwrapSandboxUseOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveBwrapCacheRoot, resolveSessionPath, resolveTemplatePath } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import { createBwrapRuntime, writeSeedFiles } from "./runtime.js";
import type { BwrapSession } from "./session.js";
import {
  cloneDirectoryAtomically,
  removeCacheMetadata,
  touchCacheMetadata,
  type BwrapCloneStrategy,
  type BwrapDirectoryCopier,
} from "./cache.js";

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

/** The backend for eve 0.62 and 0.63. eve 0.64 and later use `BwrapSandbox` instead. */
export function createBwrapSandboxBackend(
  input: CreateBwrapSandboxBackendInput = {},
): BwrapSandboxBackend {
  const options = resolveBwrapSandboxOptions(input.createOptions);
  const optionsHash = createBwrapOptionsHash(options);
  const runtime = createBwrapRuntime({ options, runner: input.runner });

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
      runtime.assertBwrapAvailable();
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
        const session = runtime.openTemplateSession({
          id: templateKey,
          workspaceDir: stagingPath,
          cacheRoots: [resolveBwrapCacheRoot(runtimeContext.appRoot, options.cacheDir)],
        });
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
      runtime.assertBwrapAvailable();
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
            throw new BwrapTemplateNotProvisionedError({ templateKey });
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
      const cacheRoot = resolveBwrapCacheRoot(runtimeContext.appRoot, options.cacheDir);
      const { session } = await runtime.openRuntimeSession({
        id: sessionKey,
        workspaceDir: sessionPath,
        cacheRoots: [cacheRoot],
        leaseRoot: cacheRoot,
        tags,
      });
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
          runtime.forgetRuntimeSession(sessionPath);
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
