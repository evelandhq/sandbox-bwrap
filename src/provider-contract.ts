import type { SpawnedProcess } from "./process.js";

/**
 * The two sandbox provider contracts this package answers, declared locally.
 *
 * eve 0.64 through 0.82 hand a provider a session object of its own making
 * (the "handle" contract below); eve 0.83 replaced that with a byte-level
 * connection from which eve derives the session itself, and removed every
 * handle-era type. One installed copy of this package serves every eve in the
 * peer range, so neither contract can be imported from the installed eve:
 * `src/eve-compatibility.test.ts` proves these copies against a real eve of
 * each era instead. eve 0.84 then changed the connection's options in place
 * (`abortSignal` became `signal`, and 0.84.1 added `spawn`'s `stdin`), so the
 * connection declares both sides of that rename too.
 */

/** One tree of authored files eve 0.64-0.82 asks `prepare` to seed. */
export interface HandleProviderResourceTree {
  readonly files: readonly {
    readonly content: string | Uint8Array;
    readonly relativePath: string;
  }[];
  readonly key: string;
  readonly targetPath: string;
}

/** eve 0.64-0.82 `prepare` context: the provider seeds the template itself. */
export interface HandleProviderPrepareContext {
  readonly log?: (message: string) => void;
  readonly resources: {
    readonly skills?: HandleProviderResourceTree;
    readonly workspace?: HandleProviderResourceTree;
  };
  readonly sourceRevision: string;
  readonly storagePath: string;
}

/** eve 0.64-0.82 `start`/`resume`/`onSessionEnd` context; `host` marks the era. */
export interface HandleProviderSessionContext {
  readonly host: unknown;
  readonly session: { readonly id: string };
  readonly storagePath: string;
}

/** What eve 0.64-0.82 passes when it deletes a sandbox: at most an abort signal. */
export interface HandleSandboxDeleteOptions {
  readonly abortSignal?: AbortSignal;
}

/**
 * The eve 0.64-0.82 handle. eve 0.75 renamed its lifecycle hooks from
 * `onSessionStop`/`onSessionDelete` to `onSandboxStop`/`onSandboxDelete` and
 * calls only the new names, while 0.64 through 0.74 call only the old ones,
 * so the handle answers to both names, each pair being the same function.
 */
export interface HandleProviderHandle<Session> {
  readonly sandbox: Session;
  onRuntimeShutdown(): Promise<void>;
  onSandboxStop(): Promise<void>;
  onSessionStop(): Promise<void>;
  onSandboxDelete(options?: HandleSandboxDeleteOptions): Promise<void>;
  onSessionDelete(options?: HandleSandboxDeleteOptions): Promise<void>;
}

/**
 * eve 0.84 renamed every sandbox `abortSignal` option to `signal`; eve 0.62
 * through 0.83 -- backends, handles, and 0.83's connection alike -- pass only
 * the old name. Every call this package answers reads whichever arrived, via
 * `abortSignalOf`, so the same build serves both sides of the rename.
 */
export interface EveAbortOptions {
  readonly abortSignal?: AbortSignal;
  readonly signal?: AbortSignal;
}

/** The caller's abort signal, under eve 0.84's name or the older one. */
export function abortSignalOf(options: EveAbortOptions): AbortSignal | undefined {
  return options.signal ?? options.abortSignal;
}

/** Capabilities merged onto the session eve derives from a connection. */
export interface BwrapConnectionExtensions {
  setNetworkPolicy(policy: "allow-all" | "deny-all"): Promise<void>;
}

/** The byte-level connection eve 0.83 and later derive a sandbox session from. */
export interface BwrapSandboxConnection {
  readonly workspaceRoot: string;
  spawn(
    options: EveAbortOptions & {
      readonly command: string;
      readonly env: Readonly<Record<string, string>>;
      /**
       * eve 0.84.1 and later: return the process's stdin as a writable stream.
       * eve kills the process and fails the call when a requested stdin is
       * missing, so this is honored, never ignored.
       */
      readonly stdin?: boolean;
      readonly workingDirectory: string;
    },
  ): Promise<SpawnedProcess>;
  readFile(
    options: EveAbortOptions & { readonly path: string },
  ): Promise<ReadableStream<Uint8Array> | null>;
  writeFiles(
    options: EveAbortOptions & {
      readonly files: readonly { readonly content: Uint8Array; readonly path: string }[];
    },
  ): Promise<void>;
  removePath(
    options: EveAbortOptions & {
      readonly force?: boolean;
      readonly path: string;
      readonly recursive?: boolean;
    },
  ): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  readonly extensions: BwrapConnectionExtensions;
}

/** eve 0.83+ `prepare` context: eve seeds the template through `populate`. */
export interface ConnectionProviderPrepareContext {
  readonly storagePath: string;
  log(message: string): void;
  populate(connection: BwrapSandboxConnection): Promise<void>;
  templateKey(identity: { readonly [key: string]: unknown }): string;
}

/**
 * eve 0.83+ `start`/`resume`/`onSessionEnd` context; `kind` marks the era.
 * Only its presence is checked: eve 1.0's stability policy lets a minor add
 * kinds, so nothing here may branch on the value itself.
 */
export interface ConnectionProviderSessionContext {
  readonly kind: "session" | "tool-session" | (string & {});
  readonly session: { readonly id: string };
  readonly storagePath: string;
}

/**
 * What eve 0.83+ passes to `onSessionEnd`. Every reason releases the session
 * the same way, so an end reason a later eve minor adds is handled already.
 */
export interface ConnectionSessionEndOptions extends EveAbortOptions {
  readonly reason: "completed" | "expired" | "failed" | "deleted" | (string & {});
}

/** What eve 0.64-0.82 passes to `onSessionEnd`. */
export interface HandleSessionEndOptions {
  readonly reason: "completed" | "expired" | "failed";
}

export function isConnectionPrepareContext(
  ctx: ConnectionProviderPrepareContext | HandleProviderPrepareContext,
): ctx is ConnectionProviderPrepareContext {
  return typeof (ctx as Partial<ConnectionProviderPrepareContext>).populate === "function";
}

export function isConnectionSessionContext(
  ctx: ConnectionProviderSessionContext | HandleProviderSessionContext,
): ctx is ConnectionProviderSessionContext {
  return typeof (ctx as Partial<ConnectionProviderSessionContext>).kind === "string";
}
