import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import {
  cloneDirectoryAtomically,
  removeCacheMetadata,
  touchCacheMetadata,
  type BwrapCloneStrategy,
  type BwrapDirectoryCopier,
} from "./cache.js";
import { createBwrapConnection, sandboxHome } from "./connection.js";
import { BwrapSandboxSessionGoneError, BwrapTemplateNotProvisionedError } from "./errors.js";
import type { BwrapNetworkPolicy, BwrapSandboxEnvironmentOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveProviderCacheRoot, sessionPathIn, templatePathIn } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import type {
  BwrapPrepareContext,
  BwrapSandboxConnection,
  BwrapSessionContext,
  BwrapSessionEndOptions,
} from "./provider-contract.js";
import { createBwrapRuntime } from "./runtime.js";
import type { BwrapSession } from "./session.js";

/**
 * Version of the session state this provider persists through eve. eve starts
 * a fresh sandbox for state recorded under a different version, so bump it
 * only when the state's shape changes incompatibly.
 */
export const BWRAP_PROVIDER_STATE_PROTOCOL_VERSION = 1;

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

/** One environment's lifecycle, as eve's sandbox provider contract calls it. */
export interface BwrapSandboxProviderImplementation {
  prepare(ctx: BwrapPrepareContext): Promise<BwrapPreparedArtifact>;
  start(
    ctx: BwrapSessionContext,
    options: Readonly<BwrapSandboxOpenOptions> | undefined,
    artifact: Readonly<BwrapPreparedArtifact>,
  ): Promise<{ readonly connection: BwrapSandboxConnection; readonly state: BwrapSessionState }>;
  resume(
    ctx: BwrapSessionContext,
    artifact: Readonly<BwrapPreparedArtifact>,
    state: Readonly<BwrapSessionState>,
  ): Promise<BwrapSandboxConnection>;
  onSessionEnd(
    ctx: BwrapSessionContext,
    state: Readonly<BwrapSessionState> | null,
    options: BwrapSessionEndOptions,
  ): Promise<void>;
}

export interface BwrapSandboxProviderDefinition {
  readonly name: "bwrap";
  readonly stateProtocolVersion: number;
  environment(options?: BwrapSandboxEnvironmentOptions): BwrapSandboxProviderImplementation;
}

/**
 * The bubblewrap sandbox provider as a plain definition. Pass it to eve's
 * `defineSandboxProvider`, or import the ready `BwrapSandbox` from
 * `@evelandhq/sandbox-bwrap/provider`. It imports nothing from eve at run
 * time, so a host can also drive it directly, for example to check that bwrap
 * works before serving traffic.
 */
export function createBwrapSandboxProviderDefinition(
  input: CreateBwrapSandboxProviderDefinitionInput = {},
): BwrapSandboxProviderDefinition {
  return {
    name: "bwrap",
    stateProtocolVersion: BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
    environment(environmentOptions) {
      // eve strips the authored `prepare` before calling this and runs it
      // itself through `ctx.populate`.
      const options = resolveBwrapSandboxOptions(environmentOptions);
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

      async function prepare(ctx: BwrapPrepareContext): Promise<BwrapPreparedArtifact> {
        // eve hashes the workspace and skill files and the sandbox module's
        // source revision into the key itself; the identity adds what only
        // this provider knows.
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

      async function start(
        ctx: BwrapSessionContext,
        openOptions: Readonly<BwrapSandboxOpenOptions> | undefined,
        preparedArtifact: Readonly<BwrapPreparedArtifact>,
      ): Promise<{
        readonly connection: BwrapSandboxConnection;
        readonly state: BwrapSessionState;
      }> {
        const workspace = await ensureWorkspace(ctx.storagePath, ctx.session.id, preparedArtifact);
        const networkPolicy = openOptions?.networkPolicy ?? options.networkPolicy;
        const state: BwrapSessionState = {
          version: 1,
          sessionKey: workspace.sessionKey,
          networkPolicy,
        };
        // `start` is an idempotent upsert: open options apply only to a
        // sandbox this call creates. A live generation another caller started,
        // such as a subagent sharing the sandbox, keeps the policy it has.
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

      // eve resumes at every durable step, and after a restart or a move to
      // another deployment. Only the session workspace is needed, never the
      // template, so the artifact passed here may belong to a newer build.
      async function resume(
        ctx: BwrapSessionContext,
        preparedArtifact: Readonly<BwrapPreparedArtifact>,
        sessionState: Readonly<BwrapSessionState>,
      ): Promise<BwrapSandboxConnection> {
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
        return connectionFor(session);
      }

      // eve releases a durable session's sandbox once the session has ended,
      // and routes `sandbox.delete()` here too. Only the workspace is touched,
      // never the template, and nothing is resumed to do it: a live generation
      // in this process is stopped, and a workspace that is already gone is
      // left gone, so eve may retry. `state` is null for a sandbox the session
      // never recorded; its workspace key derives from the session id alone.
      async function onSessionEnd(
        ctx: BwrapSessionContext,
        recorded: Readonly<BwrapSessionState> | null,
        _options: BwrapSessionEndOptions,
      ): Promise<void> {
        const sessionKey =
          recorded === null
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
