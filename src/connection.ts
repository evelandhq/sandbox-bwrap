import type { SandboxProcess } from "eve/sandbox";
import { WORKSPACE_ROOT } from "./paths.js";
import type { BwrapSandboxConnection, ConnectionAbortOptions } from "./provider-contract.js";
import type { BwrapSession } from "./session.js";

/**
 * The exact command eve 0.83 and later run to find the sandbox's `$HOME`
 * before seeding skills under `$HOME/.agents/skills`. A test pins it against
 * the installed eve, so a change in eve fails here instead of silently
 * seeding skills where the runtime never looks.
 */
export const EVE_SANDBOX_HOME_PROBE = `printf '%s\\n' "$HOME"`;

export interface CreateBwrapConnectionInput {
  readonly session: BwrapSession;
  /**
   * Set for the throwaway session over a template being captured. Its `$HOME`
   * probe is answered from the session's resolved environment without
   * launching bwrap, so a build with no authored `prepare` still needs no bwrap
   * on the build host, as it did before eve 0.83.
   */
  readonly template?: { readonly home: string; readonly assertBwrapAvailable: () => void };
}

/**
 * Adapts a bwrap session to the byte-level connection eve 0.83 and later
 * derive the full sandbox session from.
 */
export function createBwrapConnection(input: CreateBwrapConnectionInput): BwrapSandboxConnection {
  const { session, template } = input;
  return {
    workspaceRoot: WORKSPACE_ROOT,

    async spawn(options) {
      if (template && options.command === EVE_SANDBOX_HOME_PROBE) {
        return answeredProcess(`${template.home}\n`);
      }
      template?.assertBwrapAvailable();
      return await session.spawn({
        command: options.command,
        env: { ...options.env },
        workingDirectory: options.workingDirectory,
        abortSignal: abortSignalOf(options),
      });
    },

    async readFile(options) {
      abortSignalOf(options)?.throwIfAborted();
      return await session.readFile({ path: options.path });
    },

    async writeFiles(options) {
      abortSignalOf(options)?.throwIfAborted();
      await session.writeFiles({ files: options.files });
    },

    async removePath(options) {
      abortSignalOf(options)?.throwIfAborted();
      await session.removePath({
        path: options.path,
        force: options.force,
        recursive: options.recursive,
      });
    },

    // The processes are the compute and the workspace directory is the
    // durable session: stopping kills the processes and keeps the files.
    async stop() {
      await session.killAll();
    },

    // eve closes a connection when the step that opened it ends and resumes
    // through a new one. The compute generation is shared by every connection
    // over this workspace and outlives the step, so closing releases nothing;
    // `stop()`, server exit, and bwrap's `--die-with-parent` end the processes.
    async close() {},

    // A plain object of closures: eve merges own enumerable properties only.
    extensions: {
      setNetworkPolicy: async (policy) => await session.setNetworkPolicy(policy),
    },
  };
}

/** The sandbox `$HOME` every bwrap command sees. */
export function sandboxHome(env: Readonly<Record<string, string>>): string {
  return env.HOME ?? WORKSPACE_ROOT;
}

function abortSignalOf(options: ConnectionAbortOptions): AbortSignal | undefined {
  return options.signal ?? options.abortSignal;
}

function answeredProcess(stdout: string): SandboxProcess {
  const bytes = new TextEncoder().encode(stdout);
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  };
}
