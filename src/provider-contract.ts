import type { SandboxProcess } from "eve/sandbox";

/**
 * The two sandbox provider contracts this package answers, declared locally.
 *
 * eve 0.64 through 0.82 hand a provider a session object of its own making
 * (the "handle" contract below); eve 0.83 replaced that with a byte-level
 * connection from which eve derives the session itself, and removed every
 * handle-era type. One installed copy of this package serves every eve in the
 * peer range, so neither contract can be imported from the installed eve:
 * `src/eve-compatibility.test.ts` proves these copies against a real eve of
 * each era instead.
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
 * eve 0.84 renamed every `abortSignal` option to `signal`; 0.83 passes only the
 * old name. A connection reads whichever arrived.
 */
export interface ConnectionAbortOptions {
  readonly abortSignal?: AbortSignal;
  readonly signal?: AbortSignal;
}

/** Capabilities merged onto the session eve derives from a connection. */
export interface BwrapConnectionExtensions {
  setNetworkPolicy(policy: "allow-all" | "deny-all"): Promise<void>;
}

/** The byte-level connection eve 0.83 and later derive a sandbox session from. */
export interface BwrapSandboxConnection {
  readonly workspaceRoot: string;
  spawn(
    options: ConnectionAbortOptions & {
      readonly command: string;
      readonly env: Readonly<Record<string, string>>;
      readonly workingDirectory: string;
    },
  ): Promise<SandboxProcess>;
  readFile(
    options: ConnectionAbortOptions & { readonly path: string },
  ): Promise<ReadableStream<Uint8Array> | null>;
  writeFiles(
    options: ConnectionAbortOptions & {
      readonly files: readonly { readonly content: Uint8Array; readonly path: string }[];
    },
  ): Promise<void>;
  removePath(
    options: ConnectionAbortOptions & {
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

/** eve 0.83+ `start`/`resume`/`onSessionEnd` context; `kind` marks the era. */
export interface ConnectionProviderSessionContext {
  readonly kind: "session" | "tool-session";
  readonly session: { readonly id: string };
  readonly storagePath: string;
}

/** What eve 0.83+ passes to `onSessionEnd`. */
export interface ConnectionSessionEndOptions extends ConnectionAbortOptions {
  readonly reason: "completed" | "expired" | "failed" | "deleted";
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
