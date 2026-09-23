import type { BwrapSandboxUseOptions } from "./options.js";
import type { BwrapSession } from "./session.js";

/*
 * The SandboxBackend contract eve 0.62 and 0.63 call, declared here rather
 * than imported. eve 0.64 replaced backends with providers and removed these
 * types from `eve/sandbox`, so importing them would break this package's own
 * build and its published declarations on every eve that has the provider
 * API. What keeps these copies honest is src/eve-compatibility.test.ts, which
 * assigns the backend to the real `SandboxBackend` of the peer range's floor
 * (0.62; 0.63 ships byte-identical sandbox types).
 */

export interface BwrapSeedFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface BwrapBackendRuntimeContext {
  readonly appRoot: string;
}

export interface BwrapBackendCreateInput {
  readonly templateKey: string | null;
  readonly sessionKey: string;
  readonly existingMetadata?: Record<string, unknown>;
  readonly tags?: Readonly<Record<string, string>>;
  readonly runtimeContext: BwrapBackendRuntimeContext;
}

export interface BwrapBackendBootstrapContext {
  use(options?: BwrapSandboxUseOptions): Promise<BwrapSession>;
}

export interface BwrapBackendPrewarmInput {
  readonly templateKey: string;
  readonly bootstrap?: (input: BwrapBackendBootstrapContext) => void | Promise<void>;
  readonly log?: (message: string) => void;
  readonly runtimeContext: BwrapBackendRuntimeContext;
  readonly seedFiles: ReadonlyArray<BwrapSeedFile>;
}

export interface BwrapBackendSessionState {
  readonly backendName: string;
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
}

export interface BwrapBackendHandle {
  readonly session: BwrapSession;
  readonly useSessionFn: (options?: BwrapSandboxUseOptions) => Promise<BwrapSession>;
  captureState(): Promise<BwrapBackendSessionState>;
  delete(options?: { readonly abortSignal?: AbortSignal }): Promise<void>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
}

/** The bubblewrap sandbox backend, for eve 0.62 and 0.63. */
export interface BwrapSandboxBackend {
  readonly name: string;
  create(input: BwrapBackendCreateInput): Promise<BwrapBackendHandle>;
  prewarm(input: BwrapBackendPrewarmInput): Promise<{ readonly reused: boolean }>;
}
