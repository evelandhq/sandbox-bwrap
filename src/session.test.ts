import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveBwrapSandboxOptions } from "./options.js";
import type { BwrapSandboxEvent } from "./events.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";
import { readUntilSettled } from "./provider.test-support.js";
import { createBwrapSession } from "./session.js";

function stringStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function createFakeRunner(result: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    spawn(argv): SpawnedProcess {
      calls.push([...argv]);
      return {
        pid: 1234,
        stdout: stringStream(result.stdout ?? ""),
        stderr: stringStream(result.stderr ?? ""),
        wait: async () => ({ exitCode: result.exitCode ?? 0 }),
        kill: async () => {},
      };
    },
  };
  return { runner, calls };
}

async function makeSession(result?: { exitCode?: number; stdout?: string; stderr?: string }) {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-session-"));
  const workspaceDir = path.join(appRoot, ".eve", "sandbox-cache", "bwrap", "sessions", "s1");
  await mkdir(workspaceDir, { recursive: true });
  const { runner, calls } = createFakeRunner(result);
  const session = createBwrapSession({
    id: "s1",
    workspaceDir,
    cacheRoots: [path.join(appRoot, ".eve", "sandbox-cache", "bwrap")],
    runner,
    options: resolveBwrapSandboxOptions({ env: { FACTORY: "yes" } }),
  });
  return { session, calls, workspaceDir, appRoot };
}

describe("run and spawn", () => {
  test("run collects streams and the exit code without throwing on failure", async () => {
    const { session } = await makeSession({ exitCode: 3, stdout: "so", stderr: "se" });
    const result = await session.run({ command: "boom" });
    expect(result).toEqual({ exitCode: 3, stdout: "so", stderr: "se" });
  });

  test("spawn builds a hardened bwrap argv: clearenv, hidden cache root, workspace bind", async () => {
    const { session, calls, workspaceDir, appRoot } = await makeSession();
    await session.spawn({ command: "echo hi", env: { CALL: "1" } });
    const argv = calls[0]!;
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--clearenv");
    const cacheRoot = path.join(appRoot, ".eve", "sandbox-cache", "bwrap");
    // second --tmpfs: the first is /tmp, the next hides the sandbox cache root
    const secondTmpfs = argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1);
    expect(argv.slice(secondTmpfs, secondTmpfs + 2)).toEqual(["--tmpfs", cacheRoot]);
    expect(argv).toContain(workspaceDir);
    expect(argv.slice(-3)).toEqual(["bash", "-lc", "echo hi"]);
    // env precedence: defaults < factory < call
    const setenv = argv.join(" ");
    expect(setenv).toContain("--setenv FACTORY yes");
    expect(setenv).toContain("--setenv CALL 1");
    expect(setenv).toContain("--setenv HOME /workspace");
    // the host process env must never be forwarded
    expect(setenv).not.toContain("OPENAI");
  });

  test("workingDirectory resolves against /workspace", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true", workingDirectory: "sub/dir" });
    const argv = calls[0]!;
    expect(argv.slice(argv.indexOf("--chdir"), argv.indexOf("--chdir") + 2)).toEqual([
      "--chdir",
      "/workspace/sub/dir",
    ]);
  });

  test("every cache root it is given is hidden by tmpfs, before the workspace bind", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cachedir-"));
    const templateRoot = path.join(appRoot, ".eve", "sandbox-cache", "bwrap");
    const cacheDir = path.join(appRoot, "stable-cache");
    const workspaceDir = path.join(cacheDir, "sessions", "s1");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(templateRoot, { recursive: true });
    const { runner, calls } = createFakeRunner();
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [templateRoot, cacheDir, templateRoot],
      runner,
      options: resolveBwrapSandboxOptions({ cacheDir }),
    });
    await session.spawn({ command: "true" });
    const argv = calls[0]!;
    const tmpfs = argv.flatMap((arg, index) => (arg === "--tmpfs" ? [argv[index + 1]] : []));
    expect(tmpfs).toEqual(["/tmp", templateRoot, cacheDir]);
    expect(argv.indexOf(cacheDir)).toBeLessThan(argv.indexOf("--bind"));
  });

  /**
   * A runner whose process never exits on its own: its streams stay open and
   * `wait()` settles only when the abort signal it was given fires, the way
   * the real runner behaves after it kills the process group.
   */
  function abortableRunner(output: { stdout?: string; stderr?: string } = {}) {
    const state = { aborted: 0, signals: [] as (AbortSignal | undefined)[] };
    const runner: ProcessRunner = {
      spawn(_argv, spawnOptions): SpawnedProcess {
        const signal = spawnOptions?.abortSignal;
        state.signals.push(signal);
        signal?.addEventListener("abort", () => (state.aborted += 1), { once: true });
        const stream = (text?: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (text) controller.enqueue(new TextEncoder().encode(text));
              signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          });
        return {
          pid: 9,
          stdout: stream(output.stdout),
          stderr: stream(output.stderr),
          wait: async () =>
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          kill: async () => {},
        };
      },
    };
    return { runner, state };
  }

  async function limitedSession(
    runner: ProcessRunner,
    limits: { runTimeoutMs?: number | null; maxOutputBytes?: number | null },
  ) {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-limits-"));
    const events: BwrapSandboxEvent[] = [];
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions({ ...limits, onEvent: (event) => events.push(event) }),
    });
    return { session, events };
  }

  /**
   * eve 1.0 builds `run()` from `spawn()` itself, so every command it runs --
   * the bash tool, `sandbox.run()`, authored preparation -- reaches this
   * package as a spawn. The limits therefore bound every spawned process.
   */
  test("spawn kills a command that outlives runTimeoutMs and rejects its wait", async () => {
    vi.useFakeTimers();
    try {
      const { runner, state } = abortableRunner();
      const { session, events } = await limitedSession(runner, { runTimeoutMs: 1_000 });

      const proc = await session.spawn({ command: "while true; do :; done" });
      const exit = expect(proc.wait()).rejects.toThrow("command timed out after 1000 ms");
      await vi.advanceTimersByTimeAsync(999);
      expect(state.aborted).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await exit;
      expect(state.aborted).toBe(1);
      expect(events.find((event) => event.type === "command.finished")).toMatchObject({
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a command that exits before runTimeoutMs is not killed later", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const runner: ProcessRunner = {
        spawn(_argv, spawnOptions): SpawnedProcess {
          receivedSignal = spawnOptions?.abortSignal;
          return {
            stdout: stringStream("done"),
            stderr: stringStream(""),
            wait: async () => ({ exitCode: 0 }),
            kill: async () => {},
          };
        },
      };
      const { session } = await limitedSession(runner, { runTimeoutMs: 1_000 });

      const proc = await session.spawn({ command: "true" });
      expect(await proc.wait()).toEqual({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(receivedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("spawn truncates combined output at maxOutputBytes and kills the process", async () => {
    const { runner, state } = abortableRunner({ stdout: "12345", stderr: "6789" });
    const { session, events } = await limitedSession(runner, { maxOutputBytes: 8 });

    const proc = await session.spawn({ command: "lots-of-output" });
    const [stdout, stderr, exit] = await Promise.all([
      readUntilSettled(proc.stdout),
      readUntilSettled(proc.stderr),
      proc.wait().then(
        () => "resolved",
        (error: unknown) => (error as Error).message,
      ),
    ]);

    // Both streams together deliver exactly the limit, then fail with the
    // limit error rather than ending as if the output were complete.
    const message = "bwrap sandbox: command output exceeded 8 bytes";
    expect(Buffer.byteLength(stdout.text + stderr.text)).toBe(8);
    expect([stdout.error, stderr.error]).toEqual([message, message]);
    expect(exit).toBe(message);
    expect(state.aborted).toBe(1);
    expect(events.find((event) => event.type === "command.finished")).toMatchObject({
      reason: "output-limit",
    });
  });

  test("null limits leave a spawned command unbounded", async () => {
    vi.useFakeTimers();
    try {
      const { runner, state } = abortableRunner({ stdout: "x".repeat(64) });
      const { session } = await limitedSession(runner, {
        runTimeoutMs: null,
        maxOutputBytes: null,
      });

      const proc = await session.spawn({ command: "server" });
      const reader = proc.stdout.getReader();
      expect((await reader.read()).value?.byteLength).toBe(64);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(state.aborted).toBe(0);
      await proc.kill();
    } finally {
      vi.useRealTimers();
    }
  });

  test("run surfaces the limit errors of the command it spawns", async () => {
    const { runner } = abortableRunner({ stdout: "123456789" });
    const { session } = await limitedSession(runner, { maxOutputBytes: 4 });

    await expect(session.run({ command: "lots-of-output" })).rejects.toThrow(
      "command output exceeded 4 bytes",
    );
  });

  test("the caller's abort signal still kills the command, with the caller's reason", async () => {
    const { runner, state } = abortableRunner();
    const { session } = await limitedSession(runner, { runTimeoutMs: 60_000 });
    const caller = new AbortController();

    const proc = await session.spawn({ command: "sleep 60", signal: caller.signal });
    const exit = expect(proc.wait()).rejects.toThrow("caller gave up");
    caller.abort(new Error("caller gave up"));
    await exit;
    expect(state.signals[0]?.aborted).toBe(true);
  });

  test("rejects a new command when the generation reaches its process limit", async () => {
    let resolveExit!: (value: { exitCode: number }) => void;
    const exit = new Promise<{ exitCode: number }>((resolve) => (resolveExit = resolve));
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 12,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await exit,
          kill: async () => resolveExit({ exitCode: 137 }),
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-process-limit-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions({ maxConcurrentProcesses: 1 }),
    });

    await session.spawn({ command: "first" });
    await expect(session.spawn({ command: "second" })).rejects.toThrow(
      "concurrent process limit of 1",
    );
    await session.killAll();
  });
});

describe("eve 0.84 spawn options", () => {
  function recordingSession() {
    const received: { abortSignal?: AbortSignal; stdin?: boolean }[] = [];
    const stdin = new WritableStream<Uint8Array>();
    const runner: ProcessRunner = {
      spawn(_argv, spawnOptions): SpawnedProcess {
        received.push({ ...spawnOptions });
        return {
          pid: 21,
          ...(spawnOptions?.stdin === true ? { stdin } : {}),
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
        };
      },
    };
    return { runner, received, stdin };
  }

  async function sessionOver(runner: ProcessRunner) {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-spawn-options-"));
    return createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions({ runTimeoutMs: null }),
    });
  }

  test("spawn forwards a stdin request and returns the process's stdin stream", async () => {
    const { runner, received, stdin } = recordingSession();
    const session = await sessionOver(runner);

    const withStdin = await session.spawn({ command: "cat", stdin: true });
    const without = await session.spawn({ command: "cat" });

    expect(received.map((options) => options.stdin)).toEqual([true, undefined]);
    expect(withStdin.stdin).toBe(stdin);
    expect(without.stdin).toBeUndefined();
  });

  test("spawn takes eve 0.84's `signal` as well as the older `abortSignal`", async () => {
    const { runner, received } = recordingSession();
    const session = await sessionOver(runner);
    const older = new AbortController();
    const newer = new AbortController();

    await session.spawn({ command: "a", abortSignal: older.signal });
    await session.spawn({ command: "b", signal: newer.signal });
    older.abort(new Error("older"));
    newer.abort(new Error("newer"));

    // The runner sees the caller's signal combined with the command's limits.
    const reasons = received.map((options) => options.abortSignal?.reason as Error | undefined);
    expect(reasons.map((reason) => reason?.message)).toEqual(["older", "newer"]);
  });

  test("run aborts on eve 0.84's `signal` as well as the older `abortSignal`", async () => {
    const { runner, received } = recordingSession();
    const session = await sessionOver(runner);

    for (const options of [
      { command: "a", abortSignal: AbortSignal.abort(new Error("older")) },
      { command: "b", signal: AbortSignal.abort(new Error("newer")) },
    ]) {
      await session.run(options);
    }

    // run combines the caller's signal with its own output and timeout
    // signals, so the runner sees a derived signal carrying the caller's reason.
    const reasons = received.map((options) => options.abortSignal?.reason as Error | undefined);
    expect(reasons.map((reason) => reason?.message)).toEqual(["older", "newer"]);
  });
});

describe("network policy", () => {
  test("deny-all option and setNetworkPolicy toggle --unshare-net per call", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true" });
    expect(calls[0]).not.toContain("--unshare-net");
    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });
    expect(calls[1]).toContain("--unshare-net");
    await session.setNetworkPolicy("allow-all");
    await session.spawn({ command: "true" });
    expect(calls[2]).not.toContain("--unshare-net");
  });

  test("granular policies are rejected", async () => {
    const { session } = await makeSession();
    await expect(session.setNetworkPolicy({ allow: ["github.com"] })).rejects.toThrow(
      /allow-all.*deny-all/,
    );
  });
});

describe("file I/O", () => {
  test("text roundtrip with nested directories and line slicing", async () => {
    const { session } = await makeSession();
    await session.writeTextFile({ path: "notes/deep/a.txt", content: "l1\nl2\nl3" });
    expect(await session.readTextFile({ path: "notes/deep/a.txt" })).toBe("l1\nl2\nl3");
    expect(await session.readTextFile({ path: "notes/deep/a.txt", startLine: 2, endLine: 2 })).toBe(
      "l2",
    );
    expect(
      await session.readTextFile({ path: "notes/deep/a.txt", startLine: 2, endLine: 99 }),
    ).toBe("l2\nl3");
  });

  test("missing files resolve null across all readers", async () => {
    const { session } = await makeSession();
    expect(await session.readTextFile({ path: "nope.txt" })).toBeNull();
    expect(await session.readBinaryFile({ path: "nope.txt" })).toBeNull();
    expect(await session.readFile({ path: "nope.txt" })).toBeNull();
  });

  test("binary and stream writes land in the workspace", async () => {
    const { session, workspaceDir } = await makeSession();
    await session.writeBinaryFile({ path: "bin.dat", content: new Uint8Array([1, 2, 3]) });
    expect([...(await session.readBinaryFile({ path: "bin.dat" }))!]).toEqual([1, 2, 3]);
    await session.writeFile({ path: "stream.txt", content: stringStream("streamed") });
    expect(await readFile(path.join(workspaceDir, "stream.txt"), "utf8")).toBe("streamed");
  });

  test("writes and removes outside the workspace are refused", async () => {
    const { session } = await makeSession();
    await expect(session.writeTextFile({ path: "/etc/evil", content: "x" })).rejects.toThrow(
      /workspace/,
    );
    await expect(
      session.writeTextFile({ path: "a/../../escape.txt", content: "x" }),
    ).rejects.toThrow(/workspace/);
    await expect(session.removePath({ path: "/etc/hosts" })).rejects.toThrow(/workspace/);
  });

  test("removePath honors force and recursive", async () => {
    const { session, workspaceDir } = await makeSession();
    await session.writeTextFile({ path: "dir/inner.txt", content: "x" });
    await session.removePath({ path: "dir", recursive: true });
    expect(existsSync(path.join(workspaceDir, "dir"))).toBe(false);
    await expect(session.removePath({ path: "gone.txt" })).rejects.toThrow();
    await session.removePath({ path: "gone.txt", force: true });
  });

  test("writes and removes through a planted symlink are refused", async () => {
    const { session, workspaceDir, appRoot } = await makeSession();
    const outside = path.join(appRoot, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "victim.txt"), "precious");
    await symlink(outside, path.join(workspaceDir, "escape"));

    await expect(
      session.writeTextFile({ path: "escape/victim.txt", content: "pwn" }),
    ).rejects.toThrow(/workspace/);
    await expect(session.removePath({ path: "escape/victim.txt" })).rejects.toThrow(/workspace/);
    expect(await readFile(path.join(outside, "victim.txt"), "utf8")).toBe("precious");
  });

  test("reads of host paths outside the workspace pass through", async () => {
    const { session, appRoot } = await makeSession();
    await writeFile(path.join(appRoot, "host.txt"), "host-visible");
    expect(await session.readTextFile({ path: path.join(appRoot, "host.txt") })).toBe(
      "host-visible",
    );
  });

  test("resolvePath anchors to /workspace and id is stable", async () => {
    const { session } = await makeSession();
    expect(session.resolvePath("a.txt")).toBe("/workspace/a.txt");
    expect(session.resolvePath("/abs")).toBe("/abs");
    expect(session.id).toBe("s1");
  });
});

describe("killAll", () => {
  test("kills every process spawned by this session and is idempotent", async () => {
    const killed: number[] = [];
    const exits = new Map<number, (value: { exitCode: number }) => void>();
    let pid = 0;
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        const id = ++pid;
        const exit = new Promise<{ exitCode: number }>((resolve) => exits.set(id, resolve));
        return {
          pid: id,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await exit,
          kill: async () => {
            killed.push(id);
            exits.get(id)?.({ exitCode: 137 });
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-killall-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await session.spawn({ command: "sleep 1" });
    await session.spawn({ command: "sleep 2" });
    await session.killAll();
    await session.killAll();

    expect(killed).toEqual([1, 2]);
  });

  test("run() does not leave the process registered after it exits", async () => {
    const killed: number[] = [];
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 7,
          stdout: stringStream("out"),
          stderr: stringStream(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {
            killed.push(7);
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-killall-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await session.run({ command: "echo out" });
    await session.killAll();

    expect(killed).toEqual([]);
  });

  test("a spawned process unregisters on actual exit even when its caller never waits", async () => {
    const killed: number[] = [];
    let resolveExit!: (value: { exitCode: number }) => void;
    const exit = new Promise<{ exitCode: number }>((resolve) => (resolveExit = resolve));
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 8,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await exit,
          kill: async () => {
            killed.push(8);
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-auto-untrack-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await session.spawn({ command: "short" });
    resolveExit({ exitCode: 0 });
    await exit;
    await new Promise((resolve) => setImmediate(resolve));
    await session.killAll();

    expect(killed).toEqual([]);
  });

  test("blocks spawn as soon as cleanup begins", async () => {
    let finishKill!: () => void;
    const killing = new Promise<void>((resolve) => (finishKill = resolve));
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 9,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await new Promise<{ exitCode: number }>(() => {}),
          kill: async () => await killing,
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-stop-barrier-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });
    await session.spawn({ command: "first" });

    const stopping = session.killAll();
    await expect(session.spawn({ command: "escaped" })).rejects.toThrow(/stopping/);
    finishKill();
    await stopping;
    await expect(session.spawn({ command: "after-stop" })).rejects.toThrow(/stopped/);
  });

  test("reports cleanup failures and retries the still-live process", async () => {
    let attempts = 0;
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        return {
          pid: 10,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await new Promise<{ exitCode: number }>(() => {}),
          kill: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("kill denied");
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cleanup-error-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });
    await session.spawn({ command: "unkillable" });

    await expect(session.killAll()).rejects.toThrow("kill denied");
    await expect(session.killAll()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("does not report stopped until final cleanup notification succeeds", async () => {
    let notifications = 0;
    const runner: ProcessRunner = {
      spawn(): SpawnedProcess {
        throw new Error("no process expected");
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-stop-notification-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
      onStopped: async () => {
        notifications += 1;
        if (notifications === 1) throw new Error("lease removal denied");
      },
    });

    await expect(session.killAll()).rejects.toThrow("lease removal denied");
    expect(session.lifecycleState()).toBe("stopping");
    await expect(session.killAll()).resolves.toBeUndefined();
    expect(session.lifecycleState()).toBe("stopped");
    expect(notifications).toBe(2);
  });
});
