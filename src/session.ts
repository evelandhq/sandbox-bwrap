import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import {
  buildBwrapHolderArgs,
  buildSandboxJoinArgs,
  DEFAULT_SANDBOX_PATH,
  SANDBOX_AGENT_ENV,
} from "./args.js";
import { startBwrapHolder, type BwrapHolder } from "./holder.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import {
  isWithinWorkspaceReal,
  resolveWorkspacePath,
  toHostPath,
  WORKSPACE_ROOT,
} from "./paths.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";
import type {
  BwrapCommandFinishReason,
  BwrapSandboxEvent,
  BwrapSandboxEventPayload,
} from "./events.js";

export interface CreateBwrapSessionInput {
  readonly id: string;
  readonly workspaceDir: string;
  /**
   * Host directories holding templates and session workspaces. Every one is
   * masked with an empty tmpfs so a sandboxed command can never read another
   * session's workspace or a template it was not cloned from.
   */
  readonly cacheRoots: readonly string[];
  readonly runner: ProcessRunner;
  readonly options: ResolvedBwrapSandboxOptions;
  readonly generationId?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly onStopped?: () => void | Promise<void>;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** What `spawn` accepts: the connection's spawn options. */
export interface BwrapSpawnOptions {
  readonly command: string;
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /**
   * Pipe the command's stdin and return it as the process's `stdin`; closing
   * that stream sends EOF. Without it the command reads EOF at once.
   */
  readonly stdin?: boolean;
}

/**
 * One durable workspace's live compute generation: the sandbox its commands
 * share and host-side file access to its workspace.
 *
 * The sandbox is a holder, one long-lived bwrap that the first command
 * starts, and every command joins it. Commands therefore share `/tmp` and a
 * process table, and a process may outlive the command that started it: it
 * runs until the holder ends, which `killAll()` does.
 */
export interface BwrapSession {
  spawn(options: BwrapSpawnOptions): Promise<SpawnedProcess>;
  /** Resolves to a byte stream, or `null` when the path does not exist. */
  readFile(options: { readonly path: string }): Promise<ReadableStream<Uint8Array> | null>;
  writeFiles(options: {
    readonly files: readonly { readonly path: string; readonly content: Uint8Array }[];
  }): Promise<void>;
  removePath(options: {
    readonly path: string;
    readonly force?: boolean;
    readonly recursive?: boolean;
  }): Promise<void>;
  /**
   * Coarse egress switch. Only `"allow-all"` and `"deny-all"` are accepted,
   * checked at run time because callers can pass any of eve's policies. A
   * holder's network namespace cannot change, so a different policy ends the
   * holder and with it whatever was left running under the old one; commands
   * still in flight finish first.
   */
  setNetworkPolicy(policy: unknown): Promise<void>;
  /**
   * Ends the sandbox: kills every command still running and the holder, which
   * takes every other process in the sandbox with it. Idempotent.
   */
  killAll(): Promise<void>;
  /** Internal compute-generation state used to coordinate repeated opens. */
  lifecycleState(): "running" | "stopping" | "stopped";
}

export function createBwrapSession(input: CreateBwrapSessionInput): BwrapSession {
  const { id, workspaceDir, cacheRoots, runner, options } = input;
  const generationId = input.generationId ?? randomUUID();
  const tags = input.tags ?? {};
  let networkPolicy: "allow-all" | "deny-all" = options.networkPolicy;

  function emit(event: BwrapSandboxEventPayload) {
    try {
      const receipt = options.onEvent?.({
        ...event,
        timestamp: new Date().toISOString(),
        sessionId: id,
        generationId,
        tags,
      } as BwrapSandboxEvent);
      if (
        receipt !== null &&
        typeof receipt === "object" &&
        "then" in receipt &&
        typeof receipt.then === "function"
      ) {
        void Promise.resolve(receipt).catch(() => {});
      }
    } catch {
      // Observability is best effort and must never change sandbox behavior.
    }
  }

  const host = (path: string) => toHostPath(path, workspaceDir);

  function writableHostPath(path: string, operation: string): string {
    const hostPath = host(path);
    if (!isWithinWorkspaceReal(hostPath, workspaceDir)) {
      throw new Error(`bwrap sandbox: refusing to ${operation} outside ${WORKSPACE_ROOT}: ${path}`);
    }
    return hostPath;
  }

  type TrackedProcess = SpawnedProcess & {
    terminate(reason: "killed" | "cleanup"): Promise<void>;
  };
  const live = new Set<TrackedProcess>();
  /** Commands waiting for their holder: admitted, not yet a process. */
  let admitting = 0;
  let lifecycle: "running" | "stopping" | "stopped" = "running";
  let cleanupPromise: Promise<void> | undefined;
  let stoppedNotified = false;

  /**
   * A holder and the commands running in it. A slot is retired when the
   * network policy moves away from the one it was started under: it takes no
   * new commands and is stopped once the commands it has have exited.
   */
  interface HolderSlot {
    readonly shareNetwork: boolean;
    readonly ready: Promise<BwrapHolder>;
    commands: number;
    retired: boolean;
    stopping?: Promise<void>;
  }
  /** Every holder not yet stopped: the current one and any still draining. */
  const slots = new Set<HolderSlot>();
  let current: HolderSlot | undefined;

  function startSlot(shareNetwork: boolean): HolderSlot {
    // Evaluated when the sandbox starts, not per command: a path that appears
    // on the host afterwards is not hidden until the next holder.
    const hidePaths = [...new Set([...cacheRoots, ...options.hidePaths])].filter((path) =>
      existsSync(path),
    );
    const slot: HolderSlot = {
      shareNetwork,
      ready: startBwrapHolder({
        runner,
        shareNetwork,
        argv: buildBwrapHolderArgs({
          bwrapPath: options.bwrapPath,
          workspaceDir,
          hidePaths,
          shareNetwork,
        }),
      }),
      commands: 0,
      retired: false,
    };
    slot.ready.catch(() => {});
    slots.add(slot);
    return slot;
  }

  async function stopSlot(slot: HolderSlot): Promise<void> {
    slot.stopping ??= (async () => {
      // A holder that never started has nothing to stop.
      const holder = await slot.ready.catch(() => undefined);
      await holder?.stop();
      slots.delete(slot);
    })();
    try {
      await slot.stopping;
    } catch (error) {
      slot.stopping = undefined;
      throw error;
    }
  }

  /**
   * Takes a slot out of service. With no command running in it the holder is
   * stopped now, and the returned promise settles with that stop; otherwise
   * the last of its commands to exit stops it. A failed stop leaves the slot
   * for `killAll()` to retry.
   */
  async function retireSlot(slot: HolderSlot): Promise<void> {
    slot.retired = true;
    if (current === slot) current = undefined;
    if (slot.commands === 0) await stopSlot(slot);
  }

  function releaseSlot(slot: HolderSlot) {
    slot.commands -= 1;
    if (slot.retired && slot.commands === 0) void stopSlot(slot).catch(() => {});
  }

  /**
   * The holder for the current network policy, started on first use, with one
   * command counted against it. A holder that has died -- a sandboxed command
   * can kill it, and so can the host under memory pressure -- is replaced
   * once, since its workspace is intact and only its processes are gone.
   */
  async function acquireHolder(): Promise<{ slot: HolderSlot; holder: BwrapHolder }> {
    for (let attempt = 0; ; attempt += 1) {
      const shareNetwork = networkPolicy === "allow-all";
      if (current && current.shareNetwork !== shareNetwork) {
        void retireSlot(current).catch(() => {});
      }
      current ??= startSlot(shareNetwork);
      const slot = current;
      slot.commands += 1;
      let holder: BwrapHolder;
      try {
        holder = await slot.ready;
      } catch (error) {
        slot.commands -= 1;
        slots.delete(slot);
        if (current === slot) current = undefined;
        throw error;
      }
      if (holder.alive()) return { slot, holder };
      slot.commands -= 1;
      slots.delete(slot);
      if (current === slot) current = undefined;
      if (attempt > 0) {
        throw new Error("bwrap sandbox: the sandbox exited as soon as it started");
      }
    }
  }

  emit({ type: "generation.started" });

  /**
   * Applies `runTimeoutMs` and `maxOutputBytes` to one spawned process.
   *
   * Every command reaches this package as a spawn -- eve builds `run()`
   * from `spawn()` itself -- so these limits bound every command a caller is
   * waiting on. They do not bound a process a command left running in its own
   * process group: that one runs until the holder ends. A timeout kills the
   * command's process group and rejects `wait()`.
   * Output is counted as the caller reads it: both streams together deliver at
   * most `maxOutputBytes`, after which they fail with the limit error, the
   * process group is killed, and `wait()` rejects with the same error. The
   * streams fail rather than end so a caller that reads them never mistakes
   * truncated output for a command's complete output, whichever of the
   * streams and `wait()` it observes first.
   */
  function limitProcess(limit: AbortController) {
    let reason: "timeout" | "output-limit" | undefined;
    let error: Error | undefined;
    let delivered = 0;
    let truncated = false;
    const trip = (kind: "timeout" | "output-limit", message: string) => {
      if (error) return;
      reason = kind;
      error = new Error(message);
      limit.abort(error);
    };
    const timer =
      options.runTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              trip("timeout", `bwrap sandbox: command timed out after ${options.runTimeoutMs} ms`),
            options.runTimeoutMs,
          );
    timer?.unref?.();

    function bounded(
      stream: ReadableStream<Uint8Array>,
      onBytes: (count: number) => void,
    ): ReadableStream<Uint8Array> {
      const reader = stream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (truncated) {
            controller.error(error);
            await reader.cancel(error).catch(() => {});
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          const room =
            options.maxOutputBytes === null
              ? value.byteLength
              : Math.max(0, options.maxOutputBytes - delivered);
          const chunk = value.byteLength > room ? value.subarray(0, room) : value;
          delivered += chunk.byteLength;
          onBytes(chunk.byteLength);
          if (chunk.byteLength > 0) controller.enqueue(chunk);
          if (chunk !== value) {
            truncated = true;
            trip(
              "output-limit",
              `bwrap sandbox: command output exceeded ${options.maxOutputBytes} bytes`,
            );
            if (chunk.byteLength === 0) {
              controller.error(error);
              await reader.cancel(error).catch(() => {});
            }
          }
        },
        async cancel(cancelReason) {
          await reader.cancel(cancelReason);
          reader.releaseLock();
        },
      });
    }

    return {
      bounded,
      settle: () => clearTimeout(timer),
      reason: () => reason,
      error: () => error,
    };
  }

  function track(proc: SpawnedProcess, limit: AbortController, onExit: () => void): SpawnedProcess {
    const commandId = randomUUID();
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationReason: "killed" | "cleanup" | undefined;
    const limits = limitProcess(limit);
    const exit = proc.wait();
    const finishReason = (failed: boolean): BwrapCommandFinishReason =>
      limits.reason() ?? terminationReason ?? (failed ? "abort" : "exit");
    const wrapped: TrackedProcess = {
      pid: proc.pid,
      ...(proc.stdin === undefined ? {} : { stdin: proc.stdin }),
      stdout: limits.bounded(proc.stdout, (count) => (stdoutBytes += count)),
      stderr: limits.bounded(proc.stderr, (count) => (stderrBytes += count)),
      async wait() {
        const result = await exit;
        const limitError = limits.error();
        if (limitError) throw limitError;
        return result;
      },
      async kill() {
        await wrapped.terminate("killed");
      },
      async terminate(reason) {
        terminationReason = reason;
        await proc.kill();
        live.delete(wrapped);
      },
    };
    live.add(wrapped);
    emit({
      type: "command.started",
      commandId,
      ...(proc.pid === undefined ? {} : { pid: proc.pid, pgid: proc.pid }),
      liveProcesses: live.size,
    });
    // Process ownership ends when the process actually exits, independently
    // of whether the caller ever collects the returned handle.
    void exit
      .then(
        (result) => {
          limits.settle();
          live.delete(wrapped);
          onExit();
          emit({
            type: "command.finished",
            commandId,
            ...(proc.pid === undefined ? {} : { pid: proc.pid }),
            reason: finishReason(false),
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            liveProcesses: live.size,
          });
        },
        (error: unknown) => {
          limits.settle();
          live.delete(wrapped);
          onExit();
          emit({
            type: "command.finished",
            commandId,
            ...(proc.pid === undefined ? {} : { pid: proc.pid }),
            reason: finishReason(true),
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            liveProcesses: live.size,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .catch(() => {});
    return wrapped;
  }

  async function spawnProcess(spawnOptions: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly stdin?: boolean;
  }) {
    if (lifecycle !== "running") {
      throw new Error(`bwrap sandbox: compute generation is ${lifecycle}; refusing to spawn`);
    }
    if (
      options.maxConcurrentProcesses !== null &&
      live.size + admitting >= options.maxConcurrentProcesses
    ) {
      throw new Error(
        `bwrap sandbox: concurrent process limit of ${options.maxConcurrentProcesses} reached`,
      );
    }
    const env = {
      PATH: DEFAULT_SANDBOX_PATH,
      HOME: WORKSPACE_ROOT,
      LANG: "C.UTF-8",
      ...SANDBOX_AGENT_ENV,
      ...options.env,
      ...spawnOptions.env,
    };
    const chdir = resolveWorkspacePath(spawnOptions.workingDirectory ?? WORKSPACE_ROOT);
    // Counted from here, before the holder is ready, so commands issued
    // together are admitted against the limit together.
    admitting += 1;
    let acquired: { slot: HolderSlot; holder: BwrapHolder };
    try {
      acquired = await acquireHolder();
    } finally {
      admitting -= 1;
    }
    const { slot, holder } = acquired;
    if (lifecycle !== "running") {
      releaseSlot(slot);
      throw new Error(`bwrap sandbox: compute generation is ${lifecycle}; refusing to spawn`);
    }
    const argv = buildSandboxJoinArgs({
      pythonPath: options.pythonPath,
      targetPid: holder.targetPid,
      ...(holder.mountNamespace === undefined ? {} : { mountNamespace: holder.mountNamespace }),
      joinNetwork: !holder.shareNetwork,
      env,
      chdir,
      command: spawnOptions.command,
    });
    const limit = new AbortController();
    const abortSignal =
      spawnOptions.signal === undefined
        ? limit.signal
        : AbortSignal.any([spawnOptions.signal, limit.signal]);
    let proc: SpawnedProcess;
    try {
      proc = runner.spawn(argv, {
        abortSignal,
        ...(spawnOptions.stdin === true ? { stdin: true } : {}),
      });
    } catch (error) {
      releaseSlot(slot);
      throw error;
    }
    return track(proc, limit, () => releaseSlot(slot));
  }

  return {
    lifecycleState() {
      return lifecycle;
    },

    async killAll() {
      if (lifecycle === "stopped") return;
      if (cleanupPromise) return await cleanupPromise;
      lifecycle = "stopping";
      cleanupPromise = (async () => {
        const pending = [...live];
        const startedAt = Date.now();
        emit({ type: "cleanup.started", requestedProcesses: pending.length });
        const results = await Promise.allSettled(
          pending.map(async (proc) => await proc.terminate("cleanup")),
        );
        // The holders go last and take with them every process no handle
        // tracks: whatever a command left running in the sandbox.
        current = undefined;
        results.push(
          ...(await Promise.allSettled([...slots].map(async (slot) => await stopSlot(slot)))),
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          const errorMessages = failures.map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          );
          emit({
            type: "cleanup.failed",
            requestedProcesses: pending.length,
            remainingProcesses: live.size,
            durationMs: Date.now() - startedAt,
            errors: errorMessages,
          });
          throw new AggregateError(
            failures,
            `bwrap sandbox: failed to stop all live processes: ${errorMessages.join("; ")}`,
          );
        }
        if (!stoppedNotified) {
          try {
            await input.onStopped?.();
            stoppedNotified = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit({
              type: "cleanup.failed",
              requestedProcesses: pending.length,
              remainingProcesses: live.size,
              durationMs: Date.now() - startedAt,
              errors: [message],
            });
            throw error;
          }
        }
        lifecycle = "stopped";
        emit({
          type: "cleanup.completed",
          requestedProcesses: pending.length,
          remainingProcesses: live.size,
          durationMs: Date.now() - startedAt,
        });
      })();
      try {
        await cleanupPromise;
      } catch (error) {
        cleanupPromise = undefined;
        throw error;
      }
    },

    async spawn(spawnOptions) {
      return await spawnProcess(spawnOptions);
    },

    async setNetworkPolicy(policy: unknown) {
      if (policy !== "allow-all" && policy !== "deny-all") {
        throw new Error(
          'bwrap sandbox supports only the "allow-all" and "deny-all" network policies',
        );
      }
      networkPolicy = policy;
      // Awaited, so that once `deny-all` has resolved nothing an earlier
      // command left running still has the network.
      if (current && current.shareNetwork !== (policy === "allow-all")) await retireSlot(current);
    },

    async readFile({ path }) {
      const hostPath = host(path);
      // Only a missing path reads as null; a directory rejects up front rather
      // than as a stream that fails on its first read.
      const entry = await stat(hostPath).catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
      if (entry === null) return null;
      if (entry.isDirectory()) {
        throw new Error(`bwrap sandbox: cannot read a directory as a file: ${path}`);
      }
      return Readable.toWeb(createReadStream(hostPath)) as unknown as ReadableStream<Uint8Array>;
    },

    async writeFiles({ files }) {
      // Every target is checked before anything is written, so a batch with
      // one path outside the workspace writes none of them.
      const targets = files.map((file) => ({
        hostPath: writableHostPath(file.path, "write"),
        content: file.content,
      }));
      for (const { hostPath, content } of targets) {
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, content);
      }
    },

    async removePath({ path, force, recursive }) {
      const hostPath = writableHostPath(path, "remove");
      if (force !== true && !existsSync(hostPath)) {
        throw new Error(`bwrap sandbox: path does not exist: ${path}`);
      }
      await rm(hostPath, { force: force === true, recursive: recursive === true });
    },
  };
}
