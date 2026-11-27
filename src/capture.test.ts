import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  buildNetworkCaptureArgs,
  CAPTURE_READY_MARKER,
  isNetworkCaptureArgs,
  startNetworkCapture,
} from "./capture.js";
import type { ProcessRunner, SpawnedProcess } from "./process.js";

const base = {
  pythonPath: "python3",
  targetPid: 4242,
  mountNamespace: 4026532392,
  socketPath: "/tmp/bwrap-egress-abc/egress.sock",
};

describe("buildNetworkCaptureArgs", () => {
  test("pins the argv around the helper", () => {
    const args = buildNetworkCaptureArgs(base);
    expect([...args.slice(0, 4), ...args.slice(5)]).toEqual([
      "python3",
      "-I",
      "-S",
      "-c",
      "4242",
      "mnt:[4026532392]",
      "/tmp/bwrap-egress-abc/egress.sock",
    ]);
    expect(isNetworkCaptureArgs(args)).toBe(true);
    expect(isNetworkCaptureArgs(["python3", "-I", "-S", "-c", "print(1)"])).toBe(false);
  });

  /**
   * The helper enters the user namespace that owns the sandbox's network
   * namespace, which is not the one the sandbox's processes run in, and
   * redirects what leaves the sandbox instead of asking programs to cooperate.
   */
  test("the helper takes the network over from the namespace that owns it", () => {
    const helper = buildNetworkCaptureArgs(base)[4]!;
    expect(helper).toContain("fcntl.ioctl(net, 0xb701)");
    expect(helper).toContain("libc.setns(owner, 0x10000000)");
    expect(helper).toContain("libc.setns(net, 0x40000000)");
    expect(helper).toContain("meta l4proto tcp redirect to :%d");
    expect(helper).toContain("udp dport 53 redirect to :%d");
    expect(helper).toContain('"ip", "route", "replace", "local", "default", "dev", "lo"');
  });

  test("the helper refuses a sandbox that shares the host's network", () => {
    expect(buildNetworkCaptureArgs(base)[4]).toContain("the sandbox shares the host's network");
  });

  test.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
    "the helper is valid Python",
    () => {
      const parsed = spawnSync("python3", [
        "-I",
        "-S",
        "-c",
        "import ast, sys; ast.parse(sys.argv[1])",
        buildNetworkCaptureArgs(base)[4]!,
      ]);
      expect(parsed.stderr.toString()).toBe("");
      expect(parsed.status).toBe(0);
    },
  );
});

function fakeHelper(stderrText: string | null) {
  const state = { killed: false, unrefs: 0, argv: [] as string[], stdin: false };
  let settle!: (value: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>((resolve) => (settle = resolve));
  const runner: ProcessRunner = {
    spawn(argv, options): SpawnedProcess {
      state.argv = [...argv];
      state.stdin = options?.stdin === true;
      return {
        pid: 77,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream({ start: (controller) => controller.close() }),
        stderr: new ReadableStream({
          start(controller) {
            if (stderrText !== null) {
              controller.enqueue(new TextEncoder().encode(stderrText));
              controller.close();
            }
          },
        }),
        wait: async () => await exit,
        kill: async () => {
          state.killed = true;
          settle({ exitCode: 137 });
        },
        unref: () => void (state.unrefs += 1),
      };
    },
  };
  return { runner, state, exit: (exitCode: number) => settle({ exitCode }) };
}

describe("startNetworkCapture", () => {
  test("resolves once the helper reports the sandbox's traffic reaches it, and lets the host exit", async () => {
    const helper = fakeHelper(`${CAPTURE_READY_MARKER}\n`);
    const capture = await startNetworkCapture({ ...base, runner: helper.runner });
    expect(helper.state.argv).toEqual(buildNetworkCaptureArgs(base));
    // The stdin pipe is what ends the helper when the host process dies.
    expect(helper.state.stdin).toBe(true);
    expect(helper.state.unrefs).toBe(1);
    expect(capture.alive()).toBe(true);
    await capture.stop();
    expect(helper.state.killed).toBe(true);
    expect(capture.alive()).toBe(false);
  });

  test("a helper that cannot set up fails with what it reported", async () => {
    const helper = fakeHelper(
      "bwrap sandbox: cannot take over the sandbox's network: nft: No such file or directory\n",
    );
    helper.exit(125);
    await expect(startNetworkCapture({ ...base, runner: helper.runner })).rejects.toThrow(
      /cannot take over the sandbox's network: nft: No such file or directory/,
    );
  });

  test("a helper that never becomes ready is killed", async () => {
    const helper = fakeHelper(null);
    await expect(
      startNetworkCapture({ ...base, runner: helper.runner, startTimeoutMs: 20 }),
    ).rejects.toThrow(/the capture helper did not start/);
    expect(helper.state.killed).toBe(true);
  });

  test("a helper that died is reported as not alive", async () => {
    const helper = fakeHelper(`${CAPTURE_READY_MARKER}\n`);
    const capture = await startNetworkCapture({ ...base, runner: helper.runner });
    helper.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capture.alive()).toBe(false);
    await capture.stop();
    expect(helper.state.killed).toBe(false);
  });
});
