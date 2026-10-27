import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
