import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveBwrapSandboxOptions } from "./options.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";
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
    appRoot,
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

  test("the overridden cache root is the path hidden by tmpfs", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cachedir-"));
    const cacheDir = path.join(appRoot, "stable-cache");
    const workspaceDir = path.join(cacheDir, "sessions", "s1");
    await mkdir(workspaceDir, { recursive: true });
    const { runner, calls } = createFakeRunner();
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      appRoot,
      runner,
      options: resolveBwrapSandboxOptions({ cacheDir }),
    });
    await session.spawn({ command: "true" });
    const argv = calls[0]!;
    const secondTmpfs = argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1);
    expect(argv.slice(secondTmpfs, secondTmpfs + 2)).toEqual(["--tmpfs", cacheDir]);
    expect(argv).not.toContain(path.join(appRoot, ".eve", "sandbox-cache", "bwrap"));
  });

  test("run aborts the process after the configured hard timeout", async () => {
    vi.useFakeTimers();
    try {
      let aborted = 0;
      const runner: ProcessRunner = {
        spawn(_argv, spawnOptions): SpawnedProcess {
          const signal = spawnOptions?.abortSignal;
          if (!signal) throw new Error("run did not supply an abort signal");

          const stream = () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted += 1;
                    controller.close();
                  },
                  { once: true },
                );
              },
            });
          return {
            pid: 9,
            stdout: stream(),
            stderr: stream(),
            wait: async () =>
              await new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            kill: async () => {},
          };
        },
      };
      const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-timeout-"));
      const workspaceDir = path.join(appRoot, "ws");
      await mkdir(workspaceDir, { recursive: true });
      const session = createBwrapSession({
        id: "s1",
        workspaceDir,
        appRoot,
        runner,
        options: resolveBwrapSandboxOptions({ runTimeoutMs: 1_000 }),
      });

      const run = session.run({ command: "while true; do :; done" });
      const rejection = expect(run).rejects.toThrow("timed out after 1000 ms");
      await vi.advanceTimersByTimeAsync(999);
      expect(aborted).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(aborted).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("spawn remains long-running and does not receive the run timeout", async () => {
    let receivedSignal: AbortSignal | undefined;
    const runner: ProcessRunner = {
      spawn(_argv, spawnOptions): SpawnedProcess {
        receivedSignal = spawnOptions?.abortSignal;
        return {
          pid: 10,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-spawn-timeout-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      appRoot,
      runner,
      options: resolveBwrapSandboxOptions({ runTimeoutMs: 1 }),
    });

    await session.spawn({ command: "long-lived-server" });

    expect(receivedSignal).toBeUndefined();
  });

  test("rejects run output that exceeds the combined byte limit and aborts the process", async () => {
    let aborted = false;
    const runner: ProcessRunner = {
      spawn(_argv, spawnOptions): SpawnedProcess {
        const signal = spawnOptions?.abortSignal;
        if (!signal) throw new Error("run did not supply an abort signal");
        signal.addEventListener("abort", () => (aborted = true), { once: true });
        return {
          pid: 11,
          stdout: stringStream("12345"),
          stderr: stringStream("6789"),
          wait: async () =>
            await new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          kill: async () => {},
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-output-limit-"));
    const workspaceDir = path.join(appRoot, "ws");
    await mkdir(workspaceDir, { recursive: true });
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      appRoot,
      runner,
      options: resolveBwrapSandboxOptions({ maxOutputBytes: 8 }),
    });

    await expect(session.run({ command: "lots-of-output" })).rejects.toThrow(
      "output exceeded 8 bytes",
    );
    expect(aborted).toBe(true);
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
      appRoot,
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
      appRoot,
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
      appRoot,
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
      appRoot,
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
      appRoot,
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
      appRoot,
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
      appRoot,
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
