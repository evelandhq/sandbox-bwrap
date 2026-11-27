import type { BwrapNetworkPolicy } from "./network-policy.js";
import type { SpawnedProcess } from "./process.js";

/**
 * The parts of eve's sandbox provider contract (`eve/sandbox/provider`) this
 * package reads and returns. They are declared here, narrower than eve's own
 * types, so the definition can also be driven directly with only what it
 * uses -- a host self-check, for example, passes a context of three fields.
 * `src/eve-compatibility.test.ts` proves the definition satisfies eve's types.
 */

/** Capabilities merged onto the session eve derives from a connection. */
export interface BwrapConnectionExtensions {
  setNetworkPolicy(policy: BwrapNetworkPolicy): Promise<void>;
}

/** The byte-level connection eve derives a sandbox session from. */
export interface BwrapSandboxConnection {
  readonly workspaceRoot: string;
  spawn(options: {
    readonly signal?: AbortSignal;
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
    /**
     * Return the process's stdin as a writable stream. eve kills the process
     * and fails the call when a requested stdin is missing, so this is
     * honored, never ignored.
     */
    readonly stdin?: boolean;
    readonly workingDirectory: string;
  }): Promise<SpawnedProcess>;
  readFile(options: {
    readonly signal?: AbortSignal;
    readonly path: string;
  }): Promise<ReadableStream<Uint8Array> | null>;
  writeFiles(options: {
    readonly signal?: AbortSignal;
    readonly files: readonly { readonly content: Uint8Array; readonly path: string }[];
  }): Promise<void>;
  removePath(options: {
    readonly signal?: AbortSignal;
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  readonly extensions: BwrapConnectionExtensions;
}

/** What `prepare` reads from eve's prepare context: eve seeds the template through `populate`. */
export interface BwrapPrepareContext {
  readonly storagePath: string;
  log(message: string): void;
  populate(connection: BwrapSandboxConnection): Promise<void>;
  templateKey(identity: { readonly [key: string]: unknown }): string;
}

/**
 * What `start`, `resume`, and `onSessionEnd` read from eve's session context.
 * eve's stability policy lets a minor add kinds, so `kind` stays open and
 * nothing here branches on it.
 */
export interface BwrapSessionContext {
  readonly kind: "session" | "tool-session" | (string & {});
  readonly session: { readonly id: string };
  readonly storagePath: string;
}

/**
 * What eve passes to `onSessionIdle`, from eve 1.1 on: it aborts `signal`
 * when it stops waiting for the call.
 */
export interface BwrapSessionIdleOptions {
  readonly signal?: AbortSignal;
}

/**
 * What eve passes to `onSessionEnd`. Every reason releases the session the
 * same way, so an end reason a later eve minor adds is handled already.
 */
export interface BwrapSessionEndOptions {
  readonly signal?: AbortSignal;
  readonly reason: "completed" | "expired" | "failed" | "deleted" | (string & {});
}
