import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type {
  SandboxProviderDefinition,
  SandboxProviderHandle,
  SandboxProviderResources,
  SandboxProviderSessionContext,
} from "eve/sandbox/provider";
import {
  cloneDirectoryAtomically,
  removeCacheMetadata,
  touchCacheMetadata,
  type BwrapCloneStrategy,
  type BwrapDirectoryCopier,
} from "./cache.js";
import { BwrapTemplateNotProvisionedError } from "./errors.js";
import type { BwrapNetworkPolicy, BwrapSandboxCreateOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveProviderCacheRoot, sessionPathIn, templatePathIn } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import type { BwrapSeed } from "./runtime.js";
import { createBwrapRuntime, writeSeedFiles } from "./runtime.js";
import type { BwrapSession } from "./session.js";

/**
 * Version of the session state this provider persists through eve. eve refuses
 * to resume state written under a different version, so bump it only together
 * with a reader for the old shape.
 */
export const BWRAP_PROVIDER_STATE_PROTOCOL_VERSION = 1;

/**
 * The session this provider hands eve: a `SandboxSession` whose egress can be
 * changed while it runs. eve exported this type itself until 0.66 removed it,
 * so it is declared here from the parts eve still exports, the same shape eve
 * now uses for its own `DockerSandboxSession`. `prepare` callbacks receive it.
 */
export type MutableNetworkSandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

/**
 * The handle this provider hands eve. eve 0.75 renamed the handle's lifecycle
 * hooks from `onSessionStop`/`onSessionDelete` to `onSandboxStop`/`onSandboxDelete`
 * and calls only the new names, while 0.64 through 0.74 call only the old ones.
 * One installed copy of this package serves every eve in the peer range, so the
 * handle answers to both names, each pair being the same function.
 */
export type BwrapProviderHandle = SandboxProviderHandle<MutableNetworkSandboxSession> & {
  onSessionStop(): Promise<void>;
  onSessionDelete(options?: BwrapSandboxDeleteOptions): Promise<void>;
};

/** What eve passes when it deletes a sandbox: at most an abort signal. */
export type BwrapSandboxDeleteOptions = Parameters<
  SandboxProviderHandle<MutableNetworkSandboxSession>["onSandboxDelete"]
>[0];

/** Options for `BwrapSandbox.environment(...)`. */
export type BwrapSandboxEnvironmentOptions = Omit<BwrapSandboxCreateOptions, "templateRevision"> & {
  /**
   * Setup every new sandbox inherits. eve runs it once, when `eve build`
   * prepares the template, not for each session. Commands it runs execute in
   * bwrap, so the build host needs bwrap too.
   */
  readonly prepare?: (sandbox: MutableNetworkSandboxSession) => Promise<void>;
};

/** Options for `environment.open(...)`, applied when a session's sandbox is first started. */
export interface BwrapSandboxOpenOptions {
  readonly networkPolicy?: BwrapNetworkPolicy;
}

/** What `eve build` records for a prepared template. */
export type BwrapPreparedArtifact = {
  readonly version: 1;
  readonly templatePath: string;
};

/** What eve persists for one durable session's sandbox. */
export type BwrapSessionState = {
  readonly version: 1;
  readonly sessionKey: string;
  readonly networkPolicy: BwrapNetworkPolicy;
};

export interface CreateBwrapSandboxProviderDefinitionInput {
  /** Injectable process launcher so provider logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
  /** Injectable clone primitive for filesystem-capability tests. */
  readonly copyDirectory?: BwrapDirectoryCopier;
}

export type BwrapSandboxProviderDefinition = SandboxProviderDefinition<
  BwrapSandboxEnvironmentOptions,
  BwrapSandboxOpenOptions,
  BwrapPreparedArtifact,
  BwrapSessionState,
  MutableNetworkSandboxSession
>;

/**
 * The bubblewrap sandbox provider for eve 0.64 and later, as a plain
 * definition. Pass it to eve's `defineSandboxProvider`, or import the ready
 * `BwrapSandbox` from `@evelandhq/sandbox-bwrap/provider`. This module imports
 * nothing from eve at runtime, so it loads on every eve in the peer range.
 */
export function createBwrapSandboxProviderDefinition(
  input: CreateBwrapSandboxProviderDefinitionInput = {},
): BwrapSandboxProviderDefinition {
  return {
    name: "bwrap",
    stateProtocolVersion: BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
    environment(environmentOptions) {
      const { prepare, ...createOptions } = environmentOptions ?? {};
      const options = resolveBwrapSandboxOptions(createOptions);
      const optionsHash = createBwrapOptionsHash(options);
      const runtime = createBwrapRuntime({ options, runner: input.runner });

      // Templates live beside eve's own prepared artifacts; sessions follow
      // `cacheDir` when it is set, so they outlive the release that made them.
      const cacheRoots = (storagePath: string) => {
        const templateRoot = resolveProviderCacheRoot(storagePath);
        const sessionRoot = options.cacheDir ?? templateRoot;
        return { templateRoot, sessionRoot, hidden: [templateRoot, sessionRoot] };
      };

      async function openHandle(
        ctx: SandboxProviderSessionContext,
        sessionKey: string,
        cloneStrategy: BwrapCloneStrategy,
        applyNetworkPolicy: (session: BwrapSession, created: boolean) => Promise<void>,
      ): Promise<BwrapProviderHandle> {
        const roots = cacheRoots(ctx.storagePath);
        const sessionPath = sessionPathIn(roots.sessionRoot, sessionKey);
        await touchCacheMetadata({
          cacheRoot: roots.sessionRoot,
          kind: "session",
          id: basename(sessionPath),
          tags: { sessionId: ctx.session.id },
          cloneStrategy,
        });
        const { session, created } = await runtime.openRuntimeSession({
          id: ctx.session.id,
          workspaceDir: sessionPath,
          cacheRoots: roots.hidden,
          leaseRoot: roots.sessionRoot,
        });
        await applyNetworkPolicy(session, created);
        // The processes are the compute and the workspace directory is the
        // durable session: stopping kills the processes and keeps the files.
        const stop = async () => {
          await session.killAll();
        };
        // The session's own workspace is disposable; the template it was
        // cloned from is shared by every other session and must survive.
        const remove = async (deleteOptions?: BwrapSandboxDeleteOptions) => {
          deleteOptions?.abortSignal?.throwIfAborted();
          await session.killAll();
          runtime.forgetRuntimeSession(sessionPath);
          await removeSessionWorkspace(roots.sessionRoot, sessionPath);
        };
        return {
          sandbox: session,
          onSandboxStop: stop,
          onSessionStop: stop,
          async onRuntimeShutdown() {
            await session.killAll();
          },
          onSandboxDelete: remove,
          onSessionDelete: remove,
        };
      }

      async function removeSessionWorkspace(sessionRoot: string, sessionPath: string) {
        await rm(sessionPath, { force: true, recursive: true });
        await removeCacheMetadata({
          cacheRoot: sessionRoot,
          kind: "session",
          id: basename(sessionPath),
        });
      }

      return {
        async prepare(ctx) {
          const templateKey = JSON.stringify({
            version: 1,
            sourceRevision: ctx.sourceRevision,
            workspace: ctx.resources.workspace?.key ?? null,
            skills: ctx.resources.skills?.key ?? null,
            // eve's source revision covers the sandbox module, not helpers it
            // imports, so the preparation's own source joins the key.
            prepare: prepare?.toString() ?? null,
          });
          const roots = cacheRoots(ctx.storagePath);
          const templatePath = templatePathIn(roots.templateRoot, templateKey, optionsHash);
          const artifact: BwrapPreparedArtifact = { version: 1, templatePath };
          const touchTemplate = async () =>
            await touchCacheMetadata({
              cacheRoot: roots.templateRoot,
              kind: "template",
              id: basename(templatePath),
            });
          if (existsSync(templatePath)) {
            await touchTemplate();
            ctx.log?.("bwrap: reusing the prepared template");
            return artifact;
          }

          ctx.log?.("bwrap: capturing the template");
          const stagingPath = `${templatePath}.staging-${randomUUID()}`;
          await mkdir(stagingPath, { recursive: true });
          try {
            const session = runtime.openTemplateSession({
              id: basename(templatePath),
              workspaceDir: stagingPath,
              cacheRoots: roots.hidden,
            });
            try {
              await writeSeedFiles(session, resourceSeeds(ctx.resources));
              if (prepare) {
                runtime.assertBwrapAvailable();
                ctx.log?.("bwrap: running sandbox preparation");
                await prepare(session);
              }
            } finally {
              // Nothing authored preparation started may outlive the capture.
              await session.killAll();
            }
            await rename(stagingPath, templatePath);
          } catch (error) {
            await rm(stagingPath, { force: true, recursive: true }).catch(() => {});
            // A concurrent preparation winning the race is reuse, not failure.
            if (existsSync(templatePath)) {
              await touchTemplate();
              return artifact;
            }
            throw error;
          }
          await touchTemplate();
          return artifact;
        },

        async start(ctx, openOptions, preparedArtifact) {
          runtime.assertBwrapAvailable();
          const { templatePath } = requireArtifact(preparedArtifact);
          const sessionKey = `session:${ctx.session.id}`;
          const sessionPath = sessionPathIn(cacheRoots(ctx.storagePath).sessionRoot, sessionKey);
          let cloneStrategy: BwrapCloneStrategy = "existing";
          if (!existsSync(sessionPath)) {
            if (!existsSync(templatePath)) {
              throw new BwrapTemplateNotProvisionedError({ templateKey: templatePath });
            }
            cloneStrategy = await cloneDirectoryAtomically({
              sourcePath: templatePath,
              targetPath: sessionPath,
              copyDirectory: input.copyDirectory,
            });
          }
          const networkPolicy = openOptions?.networkPolicy ?? options.networkPolicy;
          const handle = await openHandle(ctx, sessionKey, cloneStrategy, async (session) => {
            await session.setNetworkPolicy(networkPolicy);
          });
          return { handle, state: { version: 1, sessionKey, networkPolicy } };
        },

        // eve resumes at every durable step, and after a restart or a move to
        // another deployment. Only the session workspace is needed, never the
        // template, so the artifact passed here may belong to a newer build.
        async resume(ctx, preparedArtifact, sessionState) {
          runtime.assertBwrapAvailable();
          requireArtifact(preparedArtifact);
          const state = requireSessionState(sessionState);
          const sessionPath = sessionPathIn(
            cacheRoots(ctx.storagePath).sessionRoot,
            state.sessionKey,
          );
          if (!existsSync(sessionPath)) {
            throw new Error(
              `bwrap sandbox: session workspace ${sessionPath} no longer exists, so the sandbox cannot be resumed`,
            );
          }
          // A live generation keeps whatever policy the session set since;
          // only a new generation starts over from the recorded one.
          return await openHandle(ctx, state.sessionKey, "existing", async (session, created) => {
            if (created) await session.setNetworkPolicy(state.networkPolicy);
          });
        },

        // eve 0.75 releases a durable session's sandbox once the session has
        // completed, expired or failed, from persisted state alone. Only the
        // workspace is touched, never the template, and nothing is resumed to
        // do it: a live generation in this process is stopped, a workspace that
        // is already gone is left gone, so the step may retry.
        async onSessionEnd(ctx, _preparedArtifact, sessionState) {
          const state = requireSessionState(sessionState);
          const roots = cacheRoots(ctx.storagePath);
          const sessionPath = sessionPathIn(roots.sessionRoot, state.sessionKey);
          await runtime.closeRuntimeSession(sessionPath);
          await removeSessionWorkspace(roots.sessionRoot, sessionPath);
        },
      };
    },
  };
}

/** eve's workspace and skill trees as seeds at their sandbox target paths. */
function resourceSeeds(resources: SandboxProviderResources): BwrapSeed[] {
  return [resources.workspace, resources.skills].flatMap((tree) =>
    tree === undefined
      ? []
      : tree.files.map((file) => ({
          path: `${tree.targetPath}/${file.relativePath}`,
          content: file.content,
        })),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArtifact(value: unknown): BwrapPreparedArtifact {
  if (!isRecord(value) || value.version !== 1 || typeof value.templatePath !== "string") {
    throw new Error("bwrap sandbox: invalid prepared artifact; rebuild the agent with `eve build`");
  }
  return { version: 1, templatePath: value.templatePath };
}

function isNetworkPolicy(value: unknown): value is BwrapNetworkPolicy {
  return value === "allow-all" || value === "deny-all";
}

function requireSessionState(value: unknown): BwrapSessionState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.sessionKey !== "string" ||
    !isNetworkPolicy(value.networkPolicy)
  ) {
    throw new Error("bwrap sandbox: invalid session state");
  }
  return { version: 1, sessionKey: value.sessionKey, networkPolicy: value.networkPolicy };
}
