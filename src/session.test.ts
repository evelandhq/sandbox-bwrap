import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveBwrapSandboxOptions } from "./options.js";
import type { BwrapSandboxEvent } from "./events.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";
import {
  clientHello,
  failNextCapture,
  fakeHolders,
  parseJoin,
  readUntilSettled,
  withFakeHolder,
} from "./provider.test-support.js";
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
  const { runner: commands, calls } = createFakeRunner(result);
  const runner = withFakeHolder(commands);
  const session = createBwrapSession({
    id: "s1",
    workspaceDir,
    cacheRoots: [path.join(appRoot, ".eve", "sandbox-cache", "bwrap")],
    runner,
    options: resolveBwrapSandboxOptions({ env: { FACTORY: "yes" } }),
  });
  return { session, calls, workspaceDir, appRoot, runner, holders: () => fakeHolders(runner) };
}

describe("spawn", () => {
  test("the first command starts one hardened holder: clearenv, hidden cache root, workspace bind", async () => {
    const { session, workspaceDir, appRoot, holders } = await makeSession();
    await session.spawn({ command: "echo hi" });
    expect(holders()).toHaveLength(1);
    const argv = holders()[0]!.argv;
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--clearenv");
    const cacheRoot = path.join(appRoot, ".eve", "sandbox-cache", "bwrap");
    // second --tmpfs: the first is /tmp, the next hides the sandbox cache root
    const secondTmpfs = argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1);
    expect(argv.slice(secondTmpfs, secondTmpfs + 2)).toEqual(["--tmpfs", cacheRoot]);
    expect(argv).toContain(workspaceDir);
    // the host process env must never be forwarded
    expect(argv.join(" ")).not.toContain("OPENAI");
  });

  test("a command joins the holder with exactly its own environment", async () => {
    const { session, calls, holders } = await makeSession();
    await session.spawn({ command: "echo hi", env: { CALL: "1" } });
    const join = parseJoin(calls[0]!);
    expect(join).toEqual({
      python: "python3",
      targetPid: holders()[0]!.targetPid,
      // The helper refuses a process outside the holder's mount namespace.
      mountNamespace: `mnt:[${holders()[0]!.mountNamespace}]`,
      joinsNetwork: false,
      chdir: "/workspace",
      command: "echo hi",
      // env precedence: defaults < factory < call
      env: {
        PATH: expect.any(String),
        HOME: "/workspace",
        LANG: "C.UTF-8",
        AI_AGENT: "eve",
        FACTORY: "yes",
        CALL: "1",
      },
    });
  });

  /**
   * Commands share one sandbox, so `/tmp` and the process table carry over
   * from one to the next: that is what lets a later command check on, or
   * stop, a process an earlier one left running.
   */
  test("later commands join the same holder instead of starting another", async () => {
    const { session, calls, holders } = await makeSession();
    await session.spawn({ command: "one" });
    await session.spawn({ command: "two" });
    await Promise.all([session.spawn({ command: "three" }), session.spawn({ command: "four" })]);
    expect(holders()).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((argv) => parseJoin(argv).targetPid))).toEqual(
      new Set([holders()[0]!.targetPid]),
    );
  });

  test("commands issued before the holder is ready wait for the same one", async () => {
    const { session, calls, holders } = await makeSession();
    await Promise.all([session.spawn({ command: "one" }), session.spawn({ command: "two" })]);
    expect(holders()).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("file access alone starts no holder", async () => {
    const { session, holders } = await makeSession();
    await session.writeFiles({
      files: [{ path: "/workspace/a.txt", content: new TextEncoder().encode("a") }],
    });
    await session.readFile({ path: "/workspace/a.txt" });
    expect(holders()).toHaveLength(0);
  });

  /**
   * A sandboxed command can end the holder (it runs as the same user), and
   * the host can lose it to memory pressure. Either way the sandbox's
   * processes are gone but its files are not, so the next command gets a
   * fresh holder over the same workspace.
   */
  test("a holder that died is replaced by the next command", async () => {
    const { session, calls, holders } = await makeSession();
    await session.spawn({ command: "one" });
    holders()[0]!.exit(137);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.spawn({ command: "two" });
    expect(holders()).toHaveLength(2);
    expect(parseJoin(calls[1]!).targetPid).toBe(holders()[1]!.targetPid);
  });

  test("a holder that fails to start rejects the command, and the next command tries again", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-holder-fail-"));
    let attempts = 0;
    const { runner: commands, calls } = createFakeRunner();
    const working = withFakeHolder(commands);
    const runner: ProcessRunner = {
      spawn(argv, options): SpawnedProcess {
        if (argv.includes("--info-fd") && ++attempts === 1) {
          return {
            stdout: stringStream(""),
            stderr: stringStream("bwrap: setting up uid map: Permission denied\n"),
            wait: async () => ({ exitCode: 1 }),
            kill: async () => {},
          };
        }
        return working.spawn(argv, options);
      },
    };
    const session = createBwrapSession({
      id: "s1",
      workspaceDir: appRoot,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions(),
    });

    await expect(session.spawn({ command: "one" })).rejects.toThrow(
      /failed to start the sandbox.*setting up uid map: Permission denied/,
    );
    expect(calls).toHaveLength(0);
    await session.spawn({ command: "two" });
    expect(calls).toHaveLength(1);
  });

  /**
   * eve asks every provider to set `SANDBOX_AGENT_ENV` beneath the sandbox's
   * own variables, so agent-aware CLIs skip interactive prompts. eve does not
   * add it to the per-call env itself.
   */
  test("sets AI_AGENT=eve beneath the configured and per-call env", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true" });
    await session.spawn({ command: "true", env: { AI_AGENT: "per-call" } });
    expect(parseJoin(calls[0]!).env.AI_AGENT).toBe("eve");
    expect(parseJoin(calls[1]!).env.AI_AGENT).toBe("per-call");

    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-agent-env-"));
    const { runner, calls: configuredCalls } = createFakeRunner();
    const configured = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner: withFakeHolder(runner),
      options: resolveBwrapSandboxOptions({ env: { AI_AGENT: "configured" } }),
    });
    await configured.spawn({ command: "true" });
    expect(parseJoin(configuredCalls[0]!).env.AI_AGENT).toBe("configured");
  });

  test("workingDirectory resolves against /workspace", async () => {
    const { session, calls } = await makeSession();
    await session.spawn({ command: "true", workingDirectory: "sub/dir" });
    expect(parseJoin(calls[0]!).chdir).toBe("/workspace/sub/dir");
  });

  test("every cache root it is given is hidden by tmpfs, before the workspace bind", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-cachedir-"));
    const templateRoot = path.join(appRoot, ".eve", "sandbox-cache", "bwrap");
    const cacheDir = path.join(appRoot, "stable-cache");
    const workspaceDir = path.join(cacheDir, "sessions", "s1");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(templateRoot, { recursive: true });
    const runner = withFakeHolder(createFakeRunner().runner);
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [templateRoot, cacheDir, templateRoot],
      runner,
      options: resolveBwrapSandboxOptions({ cacheDir }),
    });
    await session.spawn({ command: "true" });
    const argv = fakeHolders(runner)[0]!.argv;
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
      runner: withFakeHolder(runner),
      options: resolveBwrapSandboxOptions({ ...limits, onEvent: (event) => events.push(event) }),
    });
    return { session, events };
  }

  /**
   * eve builds `run()` from `spawn()` itself, so every command it runs --
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
      runner: withFakeHolder(runner),
      options: resolveBwrapSandboxOptions({ maxConcurrentProcesses: 1 }),
    });

    await session.spawn({ command: "first" });
    await expect(session.spawn({ command: "second" })).rejects.toThrow(
      "concurrent process limit of 1",
    );
    await session.killAll();
  });
});

describe("spawn options", () => {
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
      runner: withFakeHolder(runner),
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
});

describe("network policy", () => {
  /**
   * A holder's network namespace is fixed when it starts, so each policy has
   * its own holder and a command joins the network namespace only of one that
   * unshared it.
   */
  test("deny-all runs commands in a holder without network, and allow-all in one that shares it", async () => {
    const { session, calls, holders } = await makeSession();
    await session.spawn({ command: "true" });
    expect(holders()[0]!.argv).not.toContain("--unshare-net");
    expect(parseJoin(calls[0]!).joinsNetwork).toBe(false);

    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });
    expect(holders()[1]!.argv).toContain("--unshare-net");
    expect(parseJoin(calls[1]!)).toMatchObject({
      joinsNetwork: true,
      targetPid: holders()[1]!.targetPid,
    });

    await session.setNetworkPolicy("allow-all");
    await session.spawn({ command: "true" });
    expect(holders()[2]!.argv).not.toContain("--unshare-net");
    expect(parseJoin(calls[2]!).joinsNetwork).toBe(false);
  });

  /**
   * A process left running under the old policy could otherwise keep the
   * network after `deny-all`, and relay it to later commands through the
   * shared workspace.
   */
  test("changing the policy ends the previous holder and everything left running in it", async () => {
    const { session, holders } = await makeSession();
    await session.spawn({ command: "true" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.setNetworkPolicy("deny-all");
    expect(holders()[0]!.killed).toBe(true);
  });

  test("setting the policy it already has keeps the holder", async () => {
    const { session, holders } = await makeSession();
    await session.spawn({ command: "true" });
    await session.setNetworkPolicy("allow-all");
    await session.spawn({ command: "true" });
    expect(holders()).toHaveLength(1);
    expect(holders()[0]!.killed).toBe(false);
  });

  test("a command still running under the old policy finishes before its holder ends", async () => {
    let finish!: (value: { exitCode: number }) => void;
    const exit = new Promise<{ exitCode: number }>((resolve) => (finish = resolve));
    const runner = withFakeHolder({
      spawn(): SpawnedProcess {
        return {
          pid: 31,
          stdout: stringStream(""),
          stderr: stringStream(""),
          wait: async () => await exit,
          kill: async () => finish({ exitCode: 137 }),
        };
      },
    });
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-policy-drain-"));
    const session = createBwrapSession({
      id: "s1",
      workspaceDir,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions({ runTimeoutMs: null }),
    });

    const running = await session.spawn({ command: "long" });
    await session.setNetworkPolicy("deny-all");
    expect(fakeHolders(runner)[0]!.killed).toBe(false);

    finish({ exitCode: 0 });
    await running.wait();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeHolders(runner)[0]!.killed).toBe(true);
  });

  /**
   * An allow-list runs in a sandbox with a network namespace of its own. A
   * helper on the host hands everything that leaves it to the egress gateway
   * in the host process, which is what decides. Nothing in the sandbox is
   * asked to cooperate: no proxy variable, no socket bound into it.
   */
  test("an allow-list runs commands in their own network and hands its traffic to the gateway", async () => {
    const { session, calls, holders } = await makeSession();
    await session.setNetworkPolicy({ allow: ["api.example.com"] });
    await session.spawn({ command: "one" });
    await session.spawn({ command: "two" });

    const holder = holders()[0]!;
    expect(holders()).toHaveLength(1);
    expect(holder.argv).toContain("--unshare-net");
    expect(holder.argv.filter((arg) => arg === "--ro-bind")).toHaveLength(1);
    // One helper per sandbox, however many commands run in it.
    expect(holder.captures).toHaveLength(1);
    expect(existsSync(holder.captures[0]!.socketPath)).toBe(true);
    const join = parseJoin(calls[1]!);
    expect(join.joinsNetwork).toBe(true);
    expect(Object.keys(join.env).filter((name) => /proxy/i.test(name))).toEqual([]);
  });

  test("deny-all starts no capture helper: the sandbox simply has no route", async () => {
    const { session, holders } = await makeSession();
    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });
    expect(holders()[0]!.argv).toContain("--unshare-net");
    expect(holders()[0]!.captures).toHaveLength(0);
  });

  /**
   * Both run in a network namespace of their own, so nothing has to be
   * restarted: the gateway's policy is what changes, and with it what
   * processes already running reach.
   */
  test("moving between deny-all and an allow-list keeps the holder", async () => {
    const { session, holders } = await makeSession();
    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });
    await session.setNetworkPolicy({ allow: ["example.com"] });
    // Before any further command: what the first one left running is covered.
    expect(holders()[0]!.captures).toHaveLength(1);
    await session.spawn({ command: "true" });
    await session.setNetworkPolicy("deny-all");
    await session.spawn({ command: "true" });

    expect(holders()).toHaveLength(1);
    expect(holders()[0]!.killed).toBe(false);
    expect(holders()[0]!.captures).toHaveLength(1);
    expect(holders()[0]!.captures[0]!.killed).toBe(false);
  });

  test("moving from allow-all to an allow-list ends the holder that had the network", async () => {
    const { session, holders } = await makeSession();
    await session.spawn({ command: "true" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.setNetworkPolicy({ allow: ["example.com"] });
    await session.spawn({ command: "true" });
    expect(holders().map((holder) => holder.killed)).toEqual([true, false]);
    expect(holders().map((holder) => holder.captures.length)).toEqual([0, 1]);
  });

  test("a capture helper that died is replaced by the next command", async () => {
    const { session, holders } = await makeSession();
    await session.setNetworkPolicy({ allow: ["example.com"] });
    await session.spawn({ command: "true" });
    holders()[0]!.captures[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await session.spawn({ command: "true" });

    expect(holders()).toHaveLength(1);
    expect(holders()[0]!.captures).toHaveLength(2);
  });

  /**
   * A host without nft, or a kernel without nftables NAT, cannot enforce an
   * allow-list. A command then fails with the reason rather than run with no
   * route to what it was allowed, and a running sandbox keeps its old policy.
   */
  test("an allow-list the host cannot enforce fails with the reason", async () => {
    const reason =
      "bwrap sandbox: cannot take over the sandbox's network: nft: No such file or directory";
    const fresh = await makeSession();
    await fresh.session.setNetworkPolicy({ allow: ["example.com"] });
    failNextCapture(fresh.runner, reason);
    await expect(fresh.session.spawn({ command: "true" })).rejects.toThrow(reason);
    expect(fresh.calls).toHaveLength(0);

    const running = await makeSession();
    await running.session.setNetworkPolicy("deny-all");
    await running.session.spawn({ command: "true" });
    failNextCapture(running.runner, reason);
    await expect(running.session.setNetworkPolicy({ allow: ["example.com"] })).rejects.toThrow(
      reason,
    );
    // Still deny-all: the next command needs no helper and starts none.
    await running.session.spawn({ command: "true" });
    expect(running.holders()[0]!.captures).toHaveLength(0);
  });

  /**
   * A policy is applied as written or not at all: one this provider cannot
   * enforce throws and leaves the policy in force unchanged.
   */
  test("a policy that cannot be enforced is refused and changes nothing", async () => {
    const { session, holders } = await makeSession();
    await session.setNetworkPolicy("deny-all");
    await expect(
      session.setNetworkPolicy({
        allow: { "github.com": [{ transform: [{ headers: { authorization: "x" } }] }] },
      }),
    ).rejects.toThrow(/rules on a domain/);
    await expect(session.setNetworkPolicy("allow-some")).rejects.toThrow(/allow-all.*deny-all/);
    await session.spawn({ command: "true" });
    expect(holders()[0]!.argv).toContain("--unshare-net");
    expect(holders()[0]!.captures).toHaveLength(0);
  });

  test("a destination the gateway turns away is reported as an event, and stop removes the gateway", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-egress-events-"));
    const events: BwrapSandboxEvent[] = [];
    const runner = withFakeHolder(createFakeRunner().runner);
    const session = createBwrapSession({
      id: "s1",
      workspaceDir: appRoot,
      cacheRoots: [],
      runner,
      options: resolveBwrapSandboxOptions({
        networkPolicy: { allow: ["allowed.test"] },
        onEvent: (event) => events.push(event),
      }),
      egressLookup: async () => ["127.0.0.1"],
    });
    await session.spawn({ command: "true" });
    const capture = fakeHolders(runner)[0]!.captures[0]!;

    // What the capture helper relays for a sandboxed program's connection.
    await new Promise<void>((resolve, reject) => {
      const relayed = connect(capture.socketPath);
      relayed.on("error", reject);
      relayed.on("data", () => {});
      relayed.on("close", () => resolve());
      relayed.write("T 203.0.113.9 443\n");
      relayed.write(clientHello("other.test"));
    });

    expect(events.filter((event) => event.type === "network.denied")).toEqual([
      expect.objectContaining({ host: "other.test", port: 443, sessionId: "s1" }),
    ]);
    await session.killAll();
    expect(capture.killed).toBe(true);
    expect(existsSync(capture.socketPath)).toBe(false);
  });
});

describe("file I/O", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  async function readText(
    session: Awaited<ReturnType<typeof makeSession>>["session"],
    file: string,
  ) {
    const stream = await session.readFile({ path: file });
    return stream === null ? null : await new Response(stream).text();
  }

  test("a batch write creates nested directories and reads back", async () => {
    const { session } = await makeSession();
    await session.writeFiles({
      files: [
        { path: "/workspace/notes/deep/a.txt", content: bytes("l1\nl2") },
        { path: "/workspace/b.bin", content: new Uint8Array([1, 2, 3]) },
      ],
    });
    expect(await readText(session, "/workspace/notes/deep/a.txt")).toBe("l1\nl2");
    const stream = await session.readFile({ path: "/workspace/b.bin" });
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("a missing file reads as null and a directory rejects", async () => {
    const { session } = await makeSession();
    expect(await session.readFile({ path: "/workspace/nope.txt" })).toBeNull();
    await session.writeFiles({ files: [{ path: "/workspace/d/f", content: bytes("x") }] });
    await expect(session.readFile({ path: "/workspace/d" })).rejects.toThrow(/directory/);
  });

  test("writes and removes outside the workspace are refused", async () => {
    const { session } = await makeSession();
    await expect(
      session.writeFiles({ files: [{ path: "/etc/evil", content: bytes("x") }] }),
    ).rejects.toThrow(/workspace/);
    await expect(
      session.writeFiles({
        files: [{ path: "/workspace/a/../../escape.txt", content: bytes("x") }],
      }),
    ).rejects.toThrow(/workspace/);
    await expect(session.removePath({ path: "/etc/hosts" })).rejects.toThrow(/workspace/);
  });

  test("removePath honors force and recursive", async () => {
    const { session, workspaceDir } = await makeSession();
    await session.writeFiles({
      files: [{ path: "/workspace/dir/inner.txt", content: bytes("x") }],
    });
    await session.removePath({ path: "/workspace/dir", recursive: true });
    expect(existsSync(path.join(workspaceDir, "dir"))).toBe(false);
    await expect(session.removePath({ path: "/workspace/gone.txt" })).rejects.toThrow();
    await session.removePath({ path: "/workspace/gone.txt", force: true });
  });

  test("writes and removes through a planted symlink are refused", async () => {
    const { session, workspaceDir, appRoot } = await makeSession();
    const outside = path.join(appRoot, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "victim.txt"), "precious");
    await symlink(outside, path.join(workspaceDir, "escape"));

    await expect(
      session.writeFiles({
        files: [{ path: "/workspace/escape/victim.txt", content: bytes("pwn") }],
      }),
    ).rejects.toThrow(/workspace/);
    await expect(session.removePath({ path: "/workspace/escape/victim.txt" })).rejects.toThrow(
      /workspace/,
    );
    expect(await readFile(path.join(outside, "victim.txt"), "utf8")).toBe("precious");
  });

  test("reads of host paths outside the workspace pass through", async () => {
    const { session, appRoot } = await makeSession();
    await writeFile(path.join(appRoot, "host.txt"), "host-visible");
    expect(await readText(session, path.join(appRoot, "host.txt"))).toBe("host-visible");
  });
});

describe("killAll", () => {
  /**
   * The holder is the sandbox's compute: ending it is what ends a process a
   * command left running in the background, which no host-side handle tracks.
   */
  test("stops the holder, and the next generation would start a new one", async () => {
    const { session, holders } = await makeSession();
    await session.spawn({ command: "true" });
    await session.killAll();
    expect(holders().map((holder) => holder.killed)).toEqual([true]);
    await expect(session.spawn({ command: "true" })).rejects.toThrow(/refusing to spawn/);
  });

  test("stops a holder that was still starting when cleanup began", async () => {
    const { session, holders } = await makeSession();
    const spawning = session.spawn({ command: "true" }).catch((error: unknown) => error);
    await session.killAll();
    await spawning;
    expect(holders().map((holder) => holder.killed)).toEqual([true]);
  });

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
      runner: withFakeHolder(runner),
      options: resolveBwrapSandboxOptions(),
    });

    await session.spawn({ command: "sleep 1" });
    await session.spawn({ command: "sleep 2" });
    await session.killAll();
    await session.killAll();

    expect(killed).toEqual([1, 2]);
  });

  test("a collected process is not registered after it exits", async () => {
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
      runner: withFakeHolder(runner),
      options: resolveBwrapSandboxOptions(),
    });

    const proc = await session.spawn({ command: "echo out" });
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.wait(),
    ]);
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
      runner: withFakeHolder(runner),
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
      runner: withFakeHolder(runner),
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
      runner: withFakeHolder(runner),
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
      runner: withFakeHolder(runner),
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
