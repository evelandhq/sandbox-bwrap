import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { WORKSPACE_ROOT } from "./paths.js";
import { createNodeProcessRunner, describeMissingPrereqs, isBwrapAvailable } from "./process.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }

  if (process.platform !== "linux") return true;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Signal 0 still succeeds for zombies, but they have stopped executing and
    // only remain in the process table until their new parent reaps them.
    const state = stat.at(stat.lastIndexOf(")") + 2);
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("createNodeProcessRunner", () => {
  const runner = createNodeProcessRunner();

  test("captures stdout, stderr, and the exit code", async () => {
    const proc = runner.spawn(["sh", "-c", "echo out; echo err >&2; exit 7"]);
    const [stdout, stderr, result] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.wait(),
    ]);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
    expect(result.exitCode).toBe(7);
  });

  test("kill terminates the whole process group promptly and is idempotent", async () => {
    const proc = runner.spawn(["sh", "-c", "sleep 30"]);
    const started = Date.now();
    await proc.kill();
    await proc.kill();
    await proc.wait().catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("kill rejects when signaling the process group is denied", async () => {
    const groupError = Object.assign(new Error("group kill denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) throw groupError;
      return true;
    });
    try {
      const proc = runner.spawn(["sh", "-c", "sleep 30"]);
      await expect(proc.kill()).rejects.toThrow("group kill denied");
      await proc.wait().catch(() => undefined);
    } finally {
      kill.mockRestore();
    }
  });

  test("kill terminates descendants in the spawned process group", async () => {
    const proc = runner.spawn(["sh", "-c", "sleep 30 & echo $!; wait"]);
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const childPid = Number(new TextDecoder().decode(first.value).trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);

    await proc.kill();
    await proc.wait().catch(() => undefined);

    await expect.poll(() => isProcessRunning(childPid), { timeout: 1000 }).toBe(false);
  });

  test("abort makes wait() reject with the abort reason", async () => {
    const controller = new AbortController();
    const proc = runner.spawn(["sh", "-c", "sleep 30"], { abortSignal: controller.signal });
    const waiting = proc.wait();
    controller.abort(new Error("stop-now"));
    await expect(waiting).rejects.toThrow("stop-now");
  });

  test("an abort after process exit cannot rewrite the settled result", async () => {
    const controller = new AbortController();
    const proc = runner.spawn(["sh", "-c", "exit 0"], { abortSignal: controller.signal });
    await expect(proc.wait()).resolves.toEqual({ exitCode: 0 });

    controller.abort(new Error("too-late"));

    await expect(proc.wait()).resolves.toEqual({ exitCode: 0 });
  });

  test("abort reports a process-group cleanup failure instead of hiding it", async () => {
    const groupError = Object.assign(new Error("abort group kill denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) throw groupError;
      return true;
    });
    try {
      const controller = new AbortController();
      const proc = runner.spawn(["sh", "-c", "sleep 30"], { abortSignal: controller.signal });
      const waiting = proc.wait();
      controller.abort(new Error("deadline reached"));
      await expect(waiting).rejects.toThrow(/abort group kill denied/);
    } finally {
      kill.mockRestore();
    }
  });

  test("spawning a missing executable rejects wait()", async () => {
    const proc = runner.spawn(["definitely-not-a-real-binary-xyz"]);
    await expect(proc.wait()).rejects.toThrow();
  });

  test("without a stdin request the process has no stdin stream and reads EOF", async () => {
    const proc = runner.spawn(["cat"]);
    expect(proc.stdin).toBeUndefined();
    const [stdout, result] = await Promise.all([readAll(proc.stdout), proc.wait()]);
    expect(stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("a stdin request pipes a writable stdin; closing it sends EOF", async () => {
    const proc = runner.spawn(["sh", "-c", "cat; echo done"], { stdin: true });
    if (proc.stdin === undefined) throw new Error("expected a stdin stream");
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode("hello "));
    await writer.write(new TextEncoder().encode("stdin\n"));
    await writer.close();
    const [stdout, result] = await Promise.all([readAll(proc.stdout), proc.wait()]);
    expect(stdout).toBe("hello stdin\ndone\n");
    expect(result.exitCode).toBe(0);
  });

  test("a write to a stdin the command closed rejects instead of crashing the host", async () => {
    const proc = runner.spawn(["sh", "-c", "exec 0<&-; echo closed; sleep 30"], { stdin: true });
    if (proc.stdin === undefined) throw new Error("expected a stdin stream");
    const reader = proc.stdout.getReader();
    await reader.read();
    const writer = proc.stdin.getWriter();
    // Nothing reads the pipe any more, so a write fails with EPIPE. That must
    // reject on the stream rather than surface as an unhandled 'error' event
    // on the child's stdin socket, which would take the whole server down.
    const outcome = await (async () => {
      for (let index = 0; index < 8; index += 1) await writer.write(new Uint8Array(64 * 1024));
    })().then(
      () => "resolved",
      (error: unknown) => (error as NodeJS.ErrnoException).code,
    );
    await proc.kill();
    expect(outcome).toBe("EPIPE");
  });

  test("kill with an open stdin still terminates the process", async () => {
    const proc = runner.spawn(["cat"], { stdin: true });
    await proc.kill();
    await expect(proc.wait()).resolves.toEqual({ exitCode: 137 });
  });
});

describe("isBwrapAvailable", () => {
  test("returns false for a missing binary", () => {
    expect(isBwrapAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});

describe("describeMissingPrereqs", () => {
  test("returns null when bwrap is present and the workspace mountpoint exists", () => {
    expect(
      describeMissingPrereqs({
        bwrapPresent: true,
        workspaceMountpointPresent: true,
        bwrapPath: "bwrap",
      }),
    ).toBeNull();
  });

  test("reports a missing bwrap binary with the probed path and an install hint", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: false,
      workspaceMountpointPresent: true,
      bwrapPath: "/custom/bwrap",
    });
    expect(message).toContain("/custom/bwrap");
    expect(message).toContain("apt-get install bubblewrap");
    expect(message).not.toContain(WORKSPACE_ROOT);
  });

  test("reports a missing workspace mountpoint naming WORKSPACE_ROOT with the fix command", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: true,
      workspaceMountpointPresent: false,
      bwrapPath: "bwrap",
    });
    expect(message).toContain(WORKSPACE_ROOT);
    expect(message).toContain(`sudo install -d -m 0755 ${WORKSPACE_ROOT}`);
    expect(message).not.toContain("apt-get install bubblewrap");
  });

  test("reports both, bwrap first, when both are missing", () => {
    const message = describeMissingPrereqs({
      bwrapPresent: false,
      workspaceMountpointPresent: false,
      bwrapPath: "bwrap",
    });
    expect(message).toContain("apt-get install bubblewrap");
    expect(message).toContain(WORKSPACE_ROOT);
    expect(message?.indexOf("apt-get install bubblewrap")).toBeLessThan(
      message?.indexOf(WORKSPACE_ROOT) ?? -1,
    );
  });
});
