import { describe, expect, test } from "vitest";
import { HOLDER_READY_MARKER } from "./args.js";
import { startBwrapHolder } from "./holder.js";
import type { ProcessRunner, ProcessRunnerSpawnOptions, SpawnedProcess } from "./process.js";

const encoder = new TextEncoder();

/** A holder process whose output and exit the test drives by hand. */
function scriptedHolder() {
  const state = {
    argv: [] as string[],
    options: undefined as ProcessRunnerSpawnOptions | undefined,
    killed: 0,
    unrefs: 0,
  };
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let settle!: (value: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>((resolve) => (settle = resolve));
  const closeAll = () => {
    for (const controller of [stdout, stderr]) {
      try {
        controller.close();
      } catch {
        // Already closed by the test.
      }
    }
  };
  const runner: ProcessRunner = {
    spawn(argv, options): SpawnedProcess {
      state.argv = [...argv];
      state.options = options;
      return {
        pid: 100,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream({ start: (controller) => void (stdout = controller) }),
        stderr: new ReadableStream({ start: (controller) => void (stderr = controller) }),
        wait: async () => await exit,
        kill: async () => {
          state.killed += 1;
          closeAll();
          settle({ exitCode: 137 });
        },
        unref: () => void (state.unrefs += 1),
      };
    },
  };
  return {
    runner,
    state,
    reportPid: (pid: number) => {
      stdout.enqueue(
        encoder.encode(
          `{\n    "child-pid": ${pid},\n    "mnt-namespace": 4026532392,\n    "pid-namespace": 1\n}\n`,
        ),
      );
      stdout.close();
    },
    writeStderr: (text: string) => stderr.enqueue(encoder.encode(text)),
    exit: (exitCode: number) => {
      closeAll();
      settle({ exitCode });
    },
  };
}

const argv = ["bwrap", "--info-fd", "1", "bash"];

describe("startBwrapHolder", () => {
  test("resolves once bwrap reported the pid to join and the sandbox said it is ready", async () => {
    const holder = scriptedHolder();
    const starting = startBwrapHolder({ runner: holder.runner, argv, shareNetwork: false });
    let settled = false;
    void starting.then(() => (settled = true));

    holder.reportPid(4242);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The pid alone is not enough: bwrap reports it before it builds the mounts.
    expect(settled).toBe(false);
    // A host with nothing else to do must not exit while its sandbox starts.
    expect(holder.state.unrefs).toBe(0);

    holder.writeStderr(`${HOLDER_READY_MARKER}\n`);
    const started = await starting;

    expect(started.targetPid).toBe(4242);
    expect(started.mountNamespace).toBe(4026532392);
    expect(started.shareNetwork).toBe(false);
    expect(started.alive()).toBe(true);
    expect(holder.state.argv).toEqual(argv);
    // The stdin pipe is what the holder blocks on, so it must be requested.
    expect(holder.state.options?.stdin).toBe(true);
    // An idle sandbox must not keep a host that is otherwise done from exiting.
    expect(holder.state.unrefs).toBe(1);
  });

  test("a holder that exits before it is ready fails with bwrap's exit code and stderr", async () => {
    const holder = scriptedHolder();
    const starting = startBwrapHolder({ runner: holder.runner, argv, shareNetwork: true });
    holder.writeStderr("bwrap: Can't mkdir /workspace: Read-only file system\n");
    holder.exit(1);

    await expect(starting).rejects.toThrow(
      /failed to start the sandbox: .*bwrap exited with code 1: bwrap: Can't mkdir \/workspace/,
    );
  });

  test("a holder that never becomes ready is killed at the start timeout", async () => {
    const holder = scriptedHolder();
    const starting = startBwrapHolder({
      runner: holder.runner,
      argv,
      shareNetwork: true,
      startTimeoutMs: 20,
    });

    await expect(starting).rejects.toThrow(/not ready after 20 ms/);
    expect(holder.state.killed).toBe(1);
  });

  test("stop kills the holder once and reports it gone", async () => {
    const holder = scriptedHolder();
    const starting = startBwrapHolder({ runner: holder.runner, argv, shareNetwork: true });
    holder.reportPid(7);
    holder.writeStderr(`${HOLDER_READY_MARKER}\n`);
    const started = await starting;

    await started.stop();
    await started.stop();

    expect(holder.state.killed).toBe(1);
    expect(started.alive()).toBe(false);
  });

  test("a holder that dies on its own is no longer alive", async () => {
    const holder = scriptedHolder();
    const starting = startBwrapHolder({ runner: holder.runner, argv, shareNetwork: true });
    holder.reportPid(7);
    holder.writeStderr(`${HOLDER_READY_MARKER}\n`);
    const started = await starting;

    holder.exit(137);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started.alive()).toBe(false);
    await started.stop();
    expect(holder.state.killed).toBe(0);
  });
});
