import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { WORKSPACE_ROOT } from "./paths.js";

/** Mirrors the AI SDK SandboxProcess surface so sessions can return it directly. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

/** Injectable process launcher so backend logic is unit-testable without bwrap. */
export interface ProcessRunner {
  spawn(argv: readonly string[], options?: { readonly abortSignal?: AbortSignal }): SpawnedProcess;
}

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

export function isBwrapAvailable(bwrapPath = "bwrap"): boolean {
  return spawnSync(bwrapPath, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Explains missing host prerequisites, or null when the host is ready. */
export function describeMissingPrereqs(probes: {
  readonly bwrapPresent: boolean;
  readonly workspaceMountpointPresent: boolean;
  readonly bwrapPath: string;
}): string | null {
  const problems: string[] = [];
  if (!probes.bwrapPresent) {
    problems.push(
      `bubblewrap is not available (tried "${probes.bwrapPath} --version"). ` +
        "Install it with your distro package manager (Ubuntu/Debian: apt-get install bubblewrap), " +
        "or select a different backend outside Linux, e.g. " +
        "backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()).",
    );
  }
  if (!probes.workspaceMountpointPresent) {
    problems.push(
      `${WORKSPACE_ROOT} does not exist on the host. bwrap binds each session directory onto ` +
        `${WORKSPACE_ROOT} inside the sandbox, but it cannot create that mountpoint itself because the ` +
        `host root is bind-mounted read-only first. Create it once: sudo install -d -m 0755 ${WORKSPACE_ROOT}`,
    );
  }
  return problems.length === 0 ? null : problems.join(" ");
}

export function createNodeProcessRunner(): ProcessRunner {
  return {
    spawn(argv, options) {
      const [command, ...rest] = argv;
      if (!command) {
        throw new Error("ProcessRunner.spawn requires a non-empty argv");
      }
      // detached: the child leads its own process group, so kill(-pid) reaps
      // the entire sandboxed tree (bwrap and everything inside it).
      const child = spawn(command, rest, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolvePromise({ exitCode: code ?? (signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1) });
        });
      });
      exit.catch(() => {});
      const killTree = (): unknown => {
        if (child.exitCode !== null || child.signalCode !== null) return undefined;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return undefined;
          } catch (error) {
            // ESRCH can mean the process group was not established yet; kill
            // the direct child. Other failures (notably EPERM) are cleanup
            // failures even if the direct-child fallback succeeds, because
            // descendants may have escaped the signal.
            child.kill("SIGKILL");
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") return error;
            return undefined;
          }
        }
        child.kill("SIGKILL");
        return undefined;
      };
      let aborted = false;
      let abortReason: unknown;
      let abortKillError: unknown;
      const signal = options?.abortSignal;
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          aborted = true;
          abortReason = signal.reason;
          abortKillError = killTree();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const removeAbortListener = () => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      void exit.then(removeAbortListener, removeAbortListener);
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
        async wait() {
          const result = await exit;
          if (abortKillError !== undefined) {
            const cleanupMessage =
              abortKillError instanceof Error ? abortKillError.message : String(abortKillError);
            const abortMessage =
              abortReason instanceof Error ? abortReason.message : String(abortReason);
            throw new AggregateError(
              [abortKillError, abortReason],
              `bwrap process abort cleanup failed: ${cleanupMessage}; abort reason: ${abortMessage}`,
            );
          }
          if (aborted) throw abortReason;
          return result;
        },
        async kill() {
          const killError = killTree();
          await exit.catch(() => {});
          if (killError !== undefined) throw killError;
        },
      };
    },
  };
}
