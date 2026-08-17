import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { buildBwrapExecArgs, DEFAULT_SANDBOX_PATH } from "./args.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import {
  isWithinWorkspaceReal,
  resolveBwrapCacheRoot,
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
  readonly appRoot: string;
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

interface OutputBudget {
  readonly limit: number | null;
  used: number;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  budget: OutputBudget,
  abort: (reason: Error) => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.used += value.byteLength;
      if (budget.limit !== null && budget.used > budget.limit) {
        const error = new Error(`bwrap sandbox: run output exceeded ${budget.limit} bytes`);
        abort(error);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeText(bytes: Buffer, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return bytes.toString(encoding as BufferEncoding);
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
}

function createRunAbortSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | null,
  outputSignal: AbortSignal,
): { signal: AbortSignal | undefined; clear(): void } {
  const signals = [outputSignal, ...(callerSignal ? [callerSignal] : [])];
  if (timeoutMs === null) {
    return { signal: AbortSignal.any(signals), clear() {} };
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new Error(`bwrap sandbox: run timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: AbortSignal.any([...signals, timeout.signal]),
    clear: () => clearTimeout(timer),
  };
}

/**
 * A sandbox session plus the lifecycle hook the backend handle needs.
 * eve's `shutdown()` contract requires that nothing is left running, so the
 * session tracks the processes it spawned and can terminate them on demand.
 */
export type BwrapSession = SandboxSession & {
  /** Kills every process this session spawned that has not yet exited. Idempotent. */
  killAll(): Promise<void>;
  /** Internal compute-generation state used to coordinate repeated handles. */
  lifecycleState(): "running" | "stopping" | "stopped";
};

export function createBwrapSession(input: CreateBwrapSessionInput): BwrapSession {
  const { id, workspaceDir, appRoot, runner, options } = input;
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
  let lifecycle: "running" | "stopping" | "stopped" = "running";
  let cleanupPromise: Promise<void> | undefined;
  let stoppedNotified = false;

  emit({ type: "generation.started" });

  function countedStream(
    stream: ReadableStream<Uint8Array>,
    onBytes: (count: number) => void,
  ): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        onBytes(value.byteLength);
        controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    });
  }

  function finishReason(
    error: unknown,
    terminationReason: "killed" | "cleanup" | undefined,
  ): BwrapCommandFinishReason {
    if (terminationReason) return terminationReason;
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("timed out")) return "timeout";
    if (message.includes("output exceeded")) return "output-limit";
    return error === undefined ? "exit" : "abort";
  }

  function track(proc: SpawnedProcess): SpawnedProcess {
    const commandId = randomUUID();
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationReason: "killed" | "cleanup" | undefined;
    const exit = proc.wait();
    const wrapped: TrackedProcess = {
      pid: proc.pid,
      stdout: countedStream(proc.stdout, (count) => (stdoutBytes += count)),
      stderr: countedStream(proc.stderr, (count) => (stderrBytes += count)),
      async wait() {
        return await exit;
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
          live.delete(wrapped);
          emit({
            type: "command.finished",
            commandId,
            ...(proc.pid === undefined ? {} : { pid: proc.pid }),
            reason: finishReason(undefined, terminationReason),
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            liveProcesses: live.size,
          });
        },
        (error: unknown) => {
          live.delete(wrapped);
          emit({
            type: "command.finished",
            commandId,
            ...(proc.pid === undefined ? {} : { pid: proc.pid }),
            reason: finishReason(error, terminationReason),
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
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }) {
    if (lifecycle !== "running") {
      throw new Error(`bwrap sandbox: compute generation is ${lifecycle}; refusing to spawn`);
    }
    if (options.maxConcurrentProcesses !== null && live.size >= options.maxConcurrentProcesses) {
      throw new Error(
        `bwrap sandbox: concurrent process limit of ${options.maxConcurrentProcesses} reached`,
      );
    }
    const env = {
      PATH: DEFAULT_SANDBOX_PATH,
      HOME: WORKSPACE_ROOT,
      LANG: "C.UTF-8",
      ...options.env,
      ...spawnOptions.env,
    };
    const hidePaths = [
      resolveBwrapCacheRoot(appRoot, options.cacheDir),
      ...options.hidePaths,
    ].filter((path) => existsSync(path));
    const argv = buildBwrapExecArgs({
      bwrapPath: options.bwrapPath,
      workspaceDir,
      hidePaths,
      shareNetwork: networkPolicy === "allow-all",
      env,
      chdir: resolveWorkspacePath(spawnOptions.workingDirectory ?? WORKSPACE_ROOT),
      command: spawnOptions.command,
    });
    return track(runner.spawn(argv, { abortSignal: spawnOptions.abortSignal }));
  }

  return {
    id,
    resolvePath: resolveWorkspacePath,

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

    async run(runOptions) {
      const outputAbort = new AbortController();
      const runAbort = createRunAbortSignal(
        runOptions.abortSignal,
        options.runTimeoutMs,
        outputAbort.signal,
      );
      const budget: OutputBudget = { limit: options.maxOutputBytes, used: 0 };
      try {
        const proc = await spawnProcess({ ...runOptions, abortSignal: runAbort.signal });
        const [stdout, stderr, { exitCode }] = await Promise.all([
          collectStream(proc.stdout, budget, (reason) => outputAbort.abort(reason)),
          collectStream(proc.stderr, budget, (reason) => outputAbort.abort(reason)),
          proc.wait(),
        ]);
        return { exitCode, stdout, stderr };
      } finally {
        runAbort.clear();
      }
    },

    async setNetworkPolicy(policy: SandboxNetworkPolicy) {
      if (policy !== "allow-all" && policy !== "deny-all") {
        throw new Error(
          'bwrap backend supports only the "allow-all" and "deny-all" network policies',
        );
      }
      networkPolicy = policy;
    },

    async readFile({ path }) {
      const hostPath = host(path);
      if (!existsSync(hostPath)) return null;
      return Readable.toWeb(createReadStream(hostPath)) as unknown as ReadableStream<Uint8Array>;
    },

    async readBinaryFile({ path }) {
      try {
        const bytes = await readFile(host(path));
        return new Uint8Array(bytes);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async readTextFile({ path, encoding, startLine, endLine }) {
      try {
        const bytes = await readFile(host(path));
        return sliceLines(decodeText(bytes, encoding ?? "utf-8"), startLine, endLine);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async writeFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await pipeline(Readable.fromWeb(content as never), createWriteStream(hostPath));
    },

    async writeBinaryFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, content);
    },

    async writeTextFile({ path, content, encoding }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      const enc = encoding === undefined || encoding === "utf-8" ? "utf8" : encoding;
      await writeFile(hostPath, Buffer.from(content, enc as BufferEncoding));
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
