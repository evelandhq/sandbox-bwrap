import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import {
  cloneDirectoryAtomically,
  removeCacheMetadata,
  touchCacheMetadata,
  type BwrapCloneStrategy,
  type BwrapDirectoryCopier,
} from "./cache.js";
import { createBwrapConnection, sandboxHome } from "./connection.js";
import { BwrapSandboxSessionGoneError, BwrapTemplateNotProvisionedError } from "./errors.js";
import type { BwrapNetworkPolicy, BwrapSandboxCreateOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveProviderCacheRoot, sessionPathIn, templatePathIn } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import {
  isConnectionPrepareContext,
  isConnectionSessionContext,
  type BwrapSandboxConnection,
  type ConnectionProviderPrepareContext,
  type ConnectionProviderSessionContext,
  type ConnectionSessionEndOptions,
  type HandleProviderHandle,
  type HandleProviderPrepareContext,
  type HandleProviderResourceTree,
  type HandleProviderSessionContext,
  type HandleSandboxDeleteOptions,
  type HandleSessionEndOptions,
} from "./provider-contract.js";
import type { BwrapSeed } from "./runtime.js";
import { createBwrapRuntime, writeSeedFiles } from "./runtime.js";
import type { BwrapSession } from "./session.js";

/**
 * Version of the session state this provider persists through eve. eve refuses
 * to resume state written under a different version, so bump it only together
 * with a reader for the old shape. Both provider contracts record the same
 * state, so a Deployment rolled back across eve 0.83 still opens it.
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

/** The handle this provider hands eve 0.64 through 0.82. */
export type BwrapProviderHandle = HandleProviderHandle<MutableNetworkSandboxSession>;

/** What eve 0.64 through 0.82 pass when they delete a sandbox: at most an abort signal. */
export type BwrapSandboxDeleteOptions = HandleSandboxDeleteOptions;

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

/**
 * One environment's lifecycle, answering both eve provider contracts. Each
 * method is overloaded once per contract; the context eve passes decides which
 * one runs (`populate` on a prepare context, `kind` on a session context mark
 * eve 0.83 and later), so a single definition serves the whole peer range.
 */
export interface BwrapSandboxProviderImplementation {
  prepare(ctx: ConnectionProviderPrepareContext): Promise<BwrapPreparedArtifact>;
  prepare(ctx: HandleProviderPrepareContext): Promise<BwrapPreparedArtifact>;
  start(
    ctx: ConnectionProviderSessionContext,
    options: Readonly<BwrapSandboxOpenOptions> | undefined,
    artifact: Readonly<BwrapPreparedArtifact>,
  ): Promise<{ readonly connection: BwrapSandboxConnection; readonly state: BwrapSessionState }>;
  start(
    ctx: HandleProviderSessionContext,
    options: Readonly<BwrapSandboxOpenOptions> | undefined,
    artifact: Readonly<BwrapPreparedArtifact>,
  ): Promise<{ readonly handle: BwrapProviderHandle; readonly state: BwrapSessionState }>;
  resume(
    ctx: ConnectionProviderSessionContext,
    artifact: Readonly<BwrapPreparedArtifact>,
    state: Readonly<BwrapSessionState>,
  ): Promise<BwrapSandboxConnection>;
  resume(
    ctx: HandleProviderSessionContext,
    artifact: Readonly<BwrapPreparedArtifact>,
    state: Readonly<BwrapSessionState>,
  ): Promise<BwrapProviderHandle>;
  onSessionEnd(
    ctx: ConnectionProviderSessionContext,
    state: Readonly<BwrapSessionState> | null,
    options: ConnectionSessionEndOptions,
  ): Promise<void>;
  onSessionEnd(
    ctx: HandleProviderSessionContext,
    artifact: Readonly<BwrapPreparedArtifact>,
    state: Readonly<BwrapSessionState>,
    options: HandleSessionEndOptions,
  ): Promise<void>;
}

export interface BwrapSandboxProviderDefinition {
  readonly name: "bwrap";
  readonly stateProtocolVersion: number;
  environment(options?: BwrapSandboxEnvironmentOptions): BwrapSandboxProviderImplementation;
}

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
      // eve 0.83 and later strip `prepare` before calling this and run it
      // themselves through `ctx.populate`; earlier lines pass it here.
      const { prepare: environmentPrepare, ...createOptions } = environmentOptions ?? {};
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

      /**
       * Returns this workspace's live compute generation, or starts one.
       * `applyNetworkPolicy` learns whether the generation is new, since only
       * a new one starts from the configured default policy.
       */
      async function openGeneration(
        storagePath: string,
        sessionId: string,
        sessionKey: string,
        cloneStrategy: BwrapCloneStrategy,
        applyNetworkPolicy: (session: BwrapSession, created: boolean) => Promise<void>,
      ): Promise<BwrapSession> {
        const roots = cacheRoots(storagePath);
        const sessionPath = sessionPathIn(roots.sessionRoot, sessionKey);
        await touchCacheMetadata({
          cacheRoot: roots.sessionRoot,
          kind: "session",
          id: basename(sessionPath),
          tags: { sessionId },
          cloneStrategy,
        });
        const { session, created } = await runtime.openRuntimeSession({
          id: sessionId,
          workspaceDir: sessionPath,
          cacheRoots: roots.hidden,
          leaseRoot: roots.sessionRoot,
        });
        await applyNetworkPolicy(session, created);
        return session;
      }

      function handleFor(
        storagePath: string,
        session: BwrapSession,
        sessionPath: string,
      ): BwrapProviderHandle {
        const stop = async () => {
          await session.killAll();
        };
        // The session's own workspace is disposable; the template it was
        // cloned from is shared by every other session and must survive.
        const remove = async (deleteOptions?: BwrapSandboxDeleteOptions) => {
          deleteOptions?.abortSignal?.throwIfAborted();
          await session.killAll();
          runtime.forgetRuntimeSession(sessionPath);
          await removeSessionWorkspace(cacheRoots(storagePath).sessionRoot, sessionPath);
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

      /**
       * Captures a template at `templateKey` once: an existing one is reused,
       * and a concurrent capture winning the race is reuse, not failure.
       */
      async function captureTemplate(
        storagePath: string,
        templateKey: string,
        log: ((message: string) => void) | undefined,
        fill: (session: BwrapSession) => Promise<void>,
      ): Promise<BwrapPreparedArtifact> {
        const roots = cacheRoots(storagePath);
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
          log?.("bwrap: reusing the prepared template");
          return artifact;
        }

        log?.("bwrap: capturing the template");
        const stagingPath = `${templatePath}.staging-${randomUUID()}`;
        await mkdir(stagingPath, { recursive: true });
        try {
          const session = runtime.openTemplateSession({
            id: basename(templatePath),
            workspaceDir: stagingPath,
            cacheRoots: roots.hidden,
          });
          try {
            await fill(session);
          } finally {
            // Nothing authored preparation started may outlive the capture.
            await session.killAll();
          }
          await rename(stagingPath, templatePath);
        } catch (error) {
          await rm(stagingPath, { force: true, recursive: true }).catch(() => {});
          if (existsSync(templatePath)) {
            await touchTemplate();
            return artifact;
          }
          throw error;
        }
        await touchTemplate();
        return artifact;
      }

      /**
       * The session's workspace, cloned from the template when it does not
       * exist yet. Its identity derives from the session id alone, so every
       * call for one session -- concurrent, cross-process, or from a newer
       * build -- lands on the same workspace.
       */
      async function ensureWorkspace(
        storagePath: string,
        sessionId: string,
        preparedArtifact: unknown,
      ) {
        runtime.assertBwrapAvailable();
        const { templatePath } = requireArtifact(preparedArtifact);
        const sessionKey = `session:${sessionId}`;
        const sessionPath = sessionPathIn(cacheRoots(storagePath).sessionRoot, sessionKey);
        if (existsSync(sessionPath)) {
          return { sessionKey, sessionPath, cloneStrategy: "existing" as const, cloned: false };
        }
        if (!existsSync(templatePath)) {
          throw new BwrapTemplateNotProvisionedError({ templateKey: templatePath });
        }
        const cloneStrategy = await cloneDirectoryAtomically({
          sourcePath: templatePath,
          targetPath: sessionPath,
          copyDirectory: input.copyDirectory,
        });
        return { sessionKey, sessionPath, cloneStrategy, cloned: true };
      }

      function connectionFor(session: BwrapSession): BwrapSandboxConnection {
        return createBwrapConnection({ session });
      }

      function prepare(ctx: ConnectionProviderPrepareContext): Promise<BwrapPreparedArtifact>;
      function prepare(ctx: HandleProviderPrepareContext): Promise<BwrapPreparedArtifact>;
      async function prepare(
        ctx: ConnectionProviderPrepareContext | HandleProviderPrepareContext,
      ): Promise<BwrapPreparedArtifact> {
        if (isConnectionPrepareContext(ctx)) {
          // eve hashes the workspace and skill files and the sandbox module's
          // source revision into the key itself; the identity adds what only
          // this provider knows. eve runs the authored `prepare` inside
          // `populate`, so its source is no longer this provider's to hash.
          const templateKey = ctx.templateKey({ provider: "bwrap", version: 2 });
          return await captureTemplate(ctx.storagePath, templateKey, ctx.log, async (session) => {
            await ctx.populate(
              createBwrapConnection({
                session,
                template: {
                  home: sandboxHome(options.env),
                  assertBwrapAvailable: () => runtime.assertBwrapAvailable(),
                },
              }),
            );
          });
        }
        const templateKey = JSON.stringify({
          version: 1,
          sourceRevision: ctx.sourceRevision,
          workspace: ctx.resources.workspace?.key ?? null,
          skills: ctx.resources.skills?.key ?? null,
          // eve's source revision covers the sandbox module, not helpers it
          // imports, so the preparation's own source joins the key.
          prepare: environmentPrepare?.toString() ?? null,
        });
        return await captureTemplate(ctx.storagePath, templateKey, ctx.log, async (session) => {
          await writeSeedFiles(session, resourceSeeds(ctx.resources));
          if (environmentPrepare) {
            runtime.assertBwrapAvailable();
            ctx.log?.("bwrap: running sandbox preparation");
            await environmentPrepare(session);
          }
        });
      }

      function start(
        ctx: ConnectionProviderSessionContext,
        openOptions: Readonly<BwrapSandboxOpenOptions> | undefined,
        artifact: Readonly<BwrapPreparedArtifact>,
      ): Promise<{
        readonly connection: BwrapSandboxConnection;
        readonly state: BwrapSessionState;
      }>;
      function start(
        ctx: HandleProviderSessionContext,
        openOptions: Readonly<BwrapSandboxOpenOptions> | undefined,
        artifact: Readonly<BwrapPreparedArtifact>,
      ): Promise<{ readonly handle: BwrapProviderHandle; readonly state: BwrapSessionState }>;
      async function start(
        ctx: ConnectionProviderSessionContext | HandleProviderSessionContext,
        openOptions: Readonly<BwrapSandboxOpenOptions> | undefined,
        preparedArtifact: Readonly<BwrapPreparedArtifact>,
      ): Promise<
        | { readonly connection: BwrapSandboxConnection; readonly state: BwrapSessionState }
        | { readonly handle: BwrapProviderHandle; readonly state: BwrapSessionState }
      > {
        const workspace = await ensureWorkspace(ctx.storagePath, ctx.session.id, preparedArtifact);
        const networkPolicy = openOptions?.networkPolicy ?? options.networkPolicy;
        const state: BwrapSessionState = {
          version: 1,
          sessionKey: workspace.sessionKey,
          networkPolicy,
        };
        if (isConnectionSessionContext(ctx)) {
          // eve 0.83 makes `start` an idempotent upsert: open options apply
          // only to a sandbox this call creates. A live generation another
          // caller started, such as a subagent sharing the sandbox, keeps the
          // policy it has.
          const session = await openGeneration(
            ctx.storagePath,
            ctx.session.id,
            workspace.sessionKey,
            workspace.cloneStrategy,
            async (opened, created) => {
              if (workspace.cloned || created) await opened.setNetworkPolicy(networkPolicy);
            },
          );
          return { connection: connectionFor(session), state };
        }
        const session = await openGeneration(
          ctx.storagePath,
          ctx.session.id,
          workspace.sessionKey,
          workspace.cloneStrategy,
          async (opened) => {
            await opened.setNetworkPolicy(networkPolicy);
          },
        );
        return { handle: handleFor(ctx.storagePath, session, workspace.sessionPath), state };
      }

      function resume(
        ctx: ConnectionProviderSessionContext,
        artifact: Readonly<BwrapPreparedArtifact>,
        state: Readonly<BwrapSessionState>,
      ): Promise<BwrapSandboxConnection>;
      function resume(
        ctx: HandleProviderSessionContext,
        artifact: Readonly<BwrapPreparedArtifact>,
        state: Readonly<BwrapSessionState>,
      ): Promise<BwrapProviderHandle>;
      // eve resumes at every durable step, and after a restart or a move to
      // another deployment. Only the session workspace is needed, never the
      // template, so the artifact passed here may belong to a newer build.
      async function resume(
        ctx: ConnectionProviderSessionContext | HandleProviderSessionContext,
        preparedArtifact: Readonly<BwrapPreparedArtifact>,
        sessionState: Readonly<BwrapSessionState>,
      ): Promise<BwrapSandboxConnection | BwrapProviderHandle> {
        runtime.assertBwrapAvailable();
        requireArtifact(preparedArtifact);
        const state = requireSessionState(sessionState);
        const sessionPath = sessionPathIn(
          cacheRoots(ctx.storagePath).sessionRoot,
          state.sessionKey,
        );
        if (!existsSync(sessionPath)) {
          throw new BwrapSandboxSessionGoneError(
            `bwrap sandbox: session workspace ${sessionPath} no longer exists, so the sandbox cannot be resumed`,
          );
        }
        // A live generation keeps whatever policy the session set since;
        // only a new generation starts over from the recorded one.
        const session = await openGeneration(
          ctx.storagePath,
          ctx.session.id,
          state.sessionKey,
          "existing",
          async (opened, created) => {
            if (created) await opened.setNetworkPolicy(state.networkPolicy);
          },
        );
        return isConnectionSessionContext(ctx)
          ? connectionFor(session)
          : handleFor(ctx.storagePath, session, sessionPath);
      }

      function onSessionEnd(
        ctx: ConnectionProviderSessionContext,
        state: Readonly<BwrapSessionState> | null,
        options: ConnectionSessionEndOptions,
      ): Promise<void>;
      function onSessionEnd(
        ctx: HandleProviderSessionContext,
        artifact: Readonly<BwrapPreparedArtifact>,
        state: Readonly<BwrapSessionState>,
        options: HandleSessionEndOptions,
      ): Promise<void>;
      // eve releases a durable session's sandbox once the session has ended,
      // from persisted state alone. Only the workspace is touched, never the
      // template, and nothing is resumed to do it: a live generation in this
      // process is stopped, a workspace that is already gone is left gone, so
      // the step may retry. eve 0.83 passes no artifact, may pass no state for
      // a sandbox the session never recorded, and also routes
      // `sandbox.delete()` here.
      async function onSessionEnd(
        ctx: ConnectionProviderSessionContext | HandleProviderSessionContext,
        ...rest: readonly unknown[]
      ): Promise<void> {
        const recorded = isConnectionSessionContext(ctx) ? rest[0] : rest[1];
        const sessionKey =
          recorded === null && isConnectionSessionContext(ctx)
            ? `session:${ctx.session.id}`
            : requireSessionState(recorded).sessionKey;
        const roots = cacheRoots(ctx.storagePath);
        const sessionPath = sessionPathIn(roots.sessionRoot, sessionKey);
        await runtime.closeRuntimeSession(sessionPath);
        await removeSessionWorkspace(roots.sessionRoot, sessionPath);
      }

      return { prepare, start, resume, onSessionEnd };
    },
  };
}

/** eve's workspace and skill trees as seeds at their sandbox target paths. */
function resourceSeeds(resources: HandleProviderPrepareContext["resources"]): BwrapSeed[] {
  return [resources.workspace, resources.skills].flatMap(
    (tree: HandleProviderResourceTree | undefined) =>
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
