import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EGRESS_READY_MARKER, HOLDER_READY_MARKER } from "./args.js";
import type { ProcessRunner } from "./process.js";

export const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

/** Records every argv; each process exits only when killed. */
export function createLiveRunner() {
  const calls: string[][] = [];
  const killed: number[] = [];
  const exits = new Map<number, (value: { exitCode: number }) => void>();
  let pid = 0;
  const runner: ProcessRunner = {
    spawn(argv) {
      calls.push([...argv]);
      const id = ++pid;
      const exit = new Promise<{ exitCode: number }>((resolve) => exits.set(id, resolve));
      return {
        pid: id,
        stdout: empty(),
        stderr: empty(),
        wait: async () => await exit,
        kill: async () => {
          killed.push(id);
          exits.get(id)?.({ exitCode: 137 });
        },
      };
    },
  };
  return { runner, calls, killed };
}

export const exitingRunner: ProcessRunner = {
  spawn() {
    return {
      stdout: empty(),
      stderr: empty(),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    };
  },
};

export async function makeRelease() {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-provider-"));
  return { appRoot, storagePath: path.join(appRoot, ".eve", "sandbox-cache") };
}

/** Reads a stream until it ends or fails, keeping what arrived before a failure. */
export async function readUntilSettled(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { text: Buffer.concat(chunks).toString("utf8"), error: undefined };
  } catch (error) {
    return { text: Buffer.concat(chunks).toString("utf8"), error: (error as Error).message };
  }
}

/** A holder a fake runner started in place of a real bwrap. */
export interface FakeHolder {
  readonly argv: readonly string[];
  /** The pid the fake reports as bwrap's in-sandbox init, which commands join. */
  readonly targetPid: number;
  /** The mount namespace id the fake reports for its sandbox. */
  readonly mountNamespace: number;
  /** How many times the provider asked this holder to start its egress forwarder. */
  egressStarts: number;
  killed: boolean;
  /** Ends the holder the way a crash or an in-sandbox `kill` would. */
  exit(exitCode?: number): void;
}

const holderAware = new WeakMap<ProcessRunner, ProcessRunner>();
const holdersOf = new WeakMap<ProcessRunner, FakeHolder[]>();

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * Wraps a fake runner so it answers a holder spawn the way bwrap does: the
 * pid of the in-sandbox init on stdout, the ready marker on stderr, the
 * egress marker when a line arrives on stdin, and a process that lives until
 * it is killed. The wrapped runner never sees holder
 * spawns, so its own call records and counters describe commands only.
 * Wrapping the same runner again returns the same wrapper, so a test can
 * reach the holders of a runner it handed to a helper.
 */
export function withFakeHolder(runner: ProcessRunner): ProcessRunner {
  const known = holderAware.get(runner);
  if (known !== undefined) return known;
  const holders: FakeHolder[] = [];
  const wrapped: ProcessRunner = {
    spawn(argv, options) {
      if (!argv.includes("--info-fd")) return runner.spawn(argv, options);
      let settle!: (value: { exitCode: number }) => void;
      const exit = new Promise<{ exitCode: number }>((resolve) => (settle = resolve));
      const encoder = new TextEncoder();
      let stderr!: ReadableStreamDefaultController<Uint8Array>;
      const end = (exitCode: number) => {
        try {
          stderr.close();
        } catch {
          // Already closed by an earlier exit.
        }
        settle({ exitCode });
      };
      const holder: FakeHolder = {
        argv: [...argv],
        targetPid: 9_000 + holders.length + 1,
        mountNamespace: 4_026_530_000 + holders.length + 1,
        egressStarts: 0,
        killed: false,
        exit: (exitCode = 1) => end(exitCode),
      };
      holders.push(holder);
      return {
        pid: 8_000 + holders.length,
        stdin: new WritableStream<Uint8Array>({
          write() {
            holder.egressStarts += 1;
            stderr.enqueue(encoder.encode(`${EGRESS_READY_MARKER}\n`));
          },
        }),
        stdout: textStream(
          `{\n    "child-pid": ${holder.targetPid},\n    "mnt-namespace": ${holder.mountNamespace}\n}\n`,
        ),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            stderr = controller;
            controller.enqueue(encoder.encode(`${HOLDER_READY_MARKER}\n`));
          },
        }),
        wait: async () => await exit,
        kill: async () => {
          holder.killed = true;
          end(137);
        },
      };
    },
  };
  holderAware.set(runner, wrapped);
  holderAware.set(wrapped, wrapped);
  holdersOf.set(wrapped, holders);
  return wrapped;
}

/** The holders started through a runner `withFakeHolder` wrapped, oldest first. */
export function fakeHolders(runner: ProcessRunner): readonly FakeHolder[] {
  const holders = holdersOf.get(withFakeHolder(runner));
  if (holders === undefined) throw new Error("fakeHolders needs a withFakeHolder runner");
  return holders;
}

const CLONE_NEWNET = 0x4000_0000;

/** What a join argv from `buildSandboxJoinArgs` asks for, read back for assertions. */
export function parseJoin(argv: readonly string[]) {
  const helper = argv.indexOf("-c");
  const env = argv.indexOf("/usr/bin/env");
  const shell = argv.indexOf("bash", env);
  return {
    python: argv[0],
    targetPid: Number(argv[helper + 2]),
    joinsNetwork: (Number(argv[helper + 3]) & CLONE_NEWNET) !== 0,
    mountNamespace: argv[helper + 4],
    env: Object.fromEntries(
      argv.slice(env + 2, shell).map((pair) => {
        const separator = pair.indexOf("=");
        return [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
    ) as Record<string, string>,
    chdir: argv.at(-2),
    command: argv.at(-1),
  };
}
