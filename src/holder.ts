import { EGRESS_READY_MARKER, HOLDER_READY_MARKER } from "./args.js";
import type { ProcessRunner } from "./process.js";

/** How long a holder may take to report its pid and readiness before it is given up on. */
export const DEFAULT_HOLDER_START_TIMEOUT_MS = 10_000;

/** Cap on the holder stderr kept for a start failure's message. */
const MAX_DIAGNOSTIC_CHARS = 4_096;

/** How long a failed start waits for the holder's own exit before killing it. */
const FAILURE_SETTLE_MS = 250;

/**
 * One sandbox's long-lived bwrap. It owns the namespaces every command of a
 * compute generation joins; when it ends, the kernel ends every process in its
 * PID namespace with it.
 */
export interface BwrapHolder {
  /** Whether this holder shares the host network or has its own, empty, namespace. */
  readonly shareNetwork: boolean;
  /** Host pid of bwrap's in-sandbox init: the process whose namespaces commands join. */
  readonly targetPid: number;
  /**
   * The sandbox's mount namespace id, when bwrap reported one. A command
   * checks it before joining, so a reused pid is never mistaken for the holder.
   */
  readonly mountNamespace?: number;
  /** False once the holder process has exited, however it ended. */
  alive(): boolean;
  /**
   * Starts the egress forwarder inside the sandbox and resolves once it
   * accepts connections. Only a holder started with an egress socket has one.
   * It is started once; later calls wait for, or return, the same start.
   */
  startEgress(): Promise<void>;
  /** Kills the holder and, through its PID namespace, everything running in the sandbox. Idempotent. */
  stop(): Promise<void>;
}

export interface StartBwrapHolderInput {
  readonly runner: ProcessRunner;
  /** From `buildBwrapHolderArgs`. */
  readonly argv: readonly string[];
  readonly shareNetwork: boolean;
  /** Whether the argv gave the holder an egress socket, so it can start a forwarder. */
  readonly egress?: boolean;
  readonly startTimeoutMs?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chain(first: (() => void) | undefined, second: () => void): () => void {
  return () => {
    first?.();
    second();
  };
}

/**
 * Starts a holder and resolves once it can be joined: bwrap has reported the
 * pid of its in-sandbox init and its namespace ids on stdout, and the holder
 * script has written the ready marker to stderr, which it can only do after
 * bwrap finished building the sandbox's mounts. A holder that exits first, or reports neither in time,
 * is killed and the failure carries what bwrap wrote to stderr.
 */
export async function startBwrapHolder(input: StartBwrapHolderInput): Promise<BwrapHolder> {
  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_HOLDER_START_TIMEOUT_MS;
  // The stdin pipe is the holder's lifeline: it blocks reading it, so it ends
  // when this process does even where `--die-with-parent` cannot reach it.
  const proc = input.runner.spawn(input.argv, { stdin: true });
  let exited = false;
  const exit = proc.wait().then(
    (result) => {
      exited = true;
      return result;
    },
    (error: unknown) => {
      exited = true;
      throw error;
    },
  );
  exit.catch(() => {});

  let diagnostics = "";
  const decoder = new TextDecoder();

  async function readInfo(): Promise<{ targetPid: number; mountNamespace?: number }> {
    let info = "";
    for await (const chunk of proc.stdout) info += decoder.decode(chunk, { stream: true });
    const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(info)?.[1];
    const targetPid = field("child-pid");
    if (targetPid === undefined) throw new Error("bwrap reported no child pid");
    const mountNamespace = field("mnt-namespace");
    return {
      targetPid: Number(targetPid),
      ...(mountNamespace === undefined ? {} : { mountNamespace: Number(mountNamespace) }),
    };
  }

  // The holder's stderr carries two markers over its life: ready, once, and
  // the egress forwarder's, if that is ever started. One reader serves both
  // and keeps draining afterwards, since a pipe nobody reads would block
  // whoever wrote to it next.
  let egressSeen = false;
  let stderrClosed = false;
  let onStderr: (() => void) | undefined;
  const stderrChanged = () => {
    const notify = onStderr;
    onStderr = undefined;
    notify?.();
  };
  void (async () => {
    const reader = proc.stderr.getReader();
    const errors = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = errors.decode(value, { stream: true });
        if ((diagnostics + text).includes(EGRESS_READY_MARKER)) egressSeen = true;
        diagnostics = (diagnostics + text).slice(-MAX_DIAGNOSTIC_CHARS);
        stderrChanged();
      }
    } catch {
      // The stream fails when the holder is killed; nothing to report.
    }
    stderrClosed = true;
    stderrChanged();
  })();

  /** Resolves true once `seen()` holds, or false if stderr closed first. */
  async function stderrShows(seen: () => boolean): Promise<boolean> {
    while (!seen()) {
      if (stderrClosed) return false;
      await new Promise<void>((resolve) => (onStderr = chain(onStderr, resolve)));
    }
    return true;
  }

  async function readReady(): Promise<void> {
    if (!(await stderrShows(() => diagnostics.includes(HOLDER_READY_MARKER)))) {
      throw new Error("the sandbox exited before it was ready");
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the sandbox was not ready after ${startTimeoutMs} ms`)),
      startTimeoutMs,
    );
    timer.unref?.();
  });
  const reported = readInfo();
  const ready = readReady();
  reported.catch(() => {});
  ready.catch(() => {});

  let info: { targetPid: number; mountNamespace?: number };
  try {
    [info] = await Promise.race([Promise.all([reported, ready]), timedOut]);
  } catch (error) {
    // A holder that failed is usually already exiting. Give it a moment to
    // finish, so the message carries its exit code and all it wrote to stderr.
    const exitDetail = await Promise.race([
      Promise.allSettled([ready]).then(async () => {
        try {
          return `bwrap exited with code ${(await exit).exitCode}`;
        } catch (exitError) {
          return describeError(exitError);
        }
      }),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), FAILURE_SETTLE_MS).unref?.();
      }),
    ]);
    await proc.kill().catch(() => {});
    const detail = [exitDetail, diagnostics.replace(HOLDER_READY_MARKER, "").trim()]
      .filter((part) => part !== undefined && part !== "")
      .join(": ");
    throw new Error(
      `bwrap sandbox: failed to start the sandbox: ${describeError(error)}` +
        (detail === "" ? "" : ` (${detail})`),
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  // From here on the holder idles for as long as the sandbox lives. It must
  // not hold the host process open: a host that exits takes the holder with
  // it, through the stdin pipe and `--die-with-parent`. Not before this point,
  // or a short-lived host could exit while the holder was still starting.
  proc.unref?.();

  let egress: Promise<void> | undefined;
  async function startEgress(): Promise<void> {
    if (input.egress !== true) {
      throw new Error("bwrap sandbox: this sandbox was started without an egress proxy");
    }
    if (proc.stdin === undefined) {
      throw new Error("bwrap sandbox: the sandbox has no control pipe to start egress through");
    }
    // Any line starts the forwarder. The writer is released, not closed:
    // closing the pipe is what tells the holder to exit.
    const writer = proc.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode("egress\n"));
    } finally {
      writer.releaseLock();
    }
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      stderrShows(() => egressSeen),
      new Promise<false>((resolve) => {
        giveUp = setTimeout(() => {
          resolve(false);
          stderrChanged();
        }, startTimeoutMs);
        giveUp.unref?.();
      }),
    ]);
    clearTimeout(giveUp);
    if (!started) {
      const detail = diagnostics.replace(HOLDER_READY_MARKER, "").trim();
      throw new Error(
        "bwrap sandbox: the egress forwarder did not start, so the sandbox has no network" +
          (detail === "" ? "" : `: ${detail}`),
      );
    }
  }

  return {
    shareNetwork: input.shareNetwork,
    ...info,
    alive: () => !exited,
    async startEgress() {
      egress ??= startEgress();
      try {
        await egress;
      } catch (error) {
        egress = undefined;
        throw error;
      }
    },
    async stop() {
      if (exited) return;
      await proc.kill();
    },
  };
}
