import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import { BWRAP_BACKEND_NAME, createBwrapSandboxBackend } from "./backend.js";
import { bwrap, isBwrapAvailable } from "./index.js";
import type { ProcessRunner } from "./process.js";
import type { BwrapSandboxEvent } from "./events.js";

const fakeRunner: ProcessRunner = {
  spawn() {
    const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return {
      stdout: empty(),
      stderr: empty(),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    };
  },
};

async function makeBackend() {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-"));
  const backend = createBwrapSandboxBackend({ runner: fakeRunner });
  return { appRoot, backend, runtimeContext: { appRoot } };
}

describe("prewarm", () => {
  test("makes workspace seeds available to bootstrap", async () => {
    const { backend, runtimeContext } = await makeBackend();

    await backend.prewarm({
      templateKey: "bootstrap-seeds",
      runtimeContext,
      seedFiles: [{ path: "input.txt", content: "from seed" }],
      bootstrap: async ({ use }) => {
        const session = await use();
        const seeded = await session.readTextFile({ path: "input.txt" });
        await session.writeTextFile({ path: "bootstrap-saw.txt", content: seeded ?? "missing" });
      },
    });

    const handle = await backend.create({
      templateKey: "bootstrap-seeds",
      sessionKey: "bootstrap-seeds-session",
      runtimeContext,
    });
    expect(await handle.session.readTextFile({ path: "bootstrap-saw.txt" })).toBe("from seed");
  });

  test("materializes Eve skill seeds under the sandbox HOME", async () => {
    const { backend, runtimeContext } = await makeBackend();
    await backend.prewarm({
      templateKey: "skills",
      runtimeContext,
      seedFiles: [
        {
          path: "$HOME/.agents/skills/research/SKILL.md",
          content: "Use this research procedure.",
        },
        {
          path: "$HOME/.agents/skills/research/assets/example.bin",
          content: Buffer.from([0, 1, 2, 255]),
        },
      ],
    });

    const handle = await backend.create({
      templateKey: "skills",
      sessionKey: "skills-session",
      runtimeContext,
    });

    expect(
      await handle.session.readTextFile({ path: "/workspace/.agents/skills/research/SKILL.md" }),
    ).toBe("Use this research procedure.");
    expect(
      await handle.session.readTextFile({
        path: "/workspace/$HOME/.agents/skills/research/SKILL.md",
      }),
    ).toBeNull();
    expect(
      await handle.session.readBinaryFile({
        path: "/workspace/.agents/skills/research/assets/example.bin",
      }),
    ).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  test("captures a template once and reuses it after", async () => {
    const { backend, runtimeContext, appRoot } = await makeBackend();
    const first = await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [
        { path: "seed.txt", content: "seeded" },
        { path: "bin/seed.dat", content: Buffer.from([7]) },
      ],
      bootstrap: async ({ use }) => {
        const session = await use();
        await session.writeTextFile({ path: "boot.txt", content: "booted" });
      },
    });
    expect(first).toEqual({ reused: false });

    const second = await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });
    expect(second).toEqual({ reused: true });

    const templatesDir = path.join(appRoot, ".eve", "sandbox-cache", "bwrap", "templates");
    const entries = await readdir(templatesDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain(".staging");
  });

  test("records template retention metadata outside the captured template", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-template-metadata-"));
    const cacheDir = path.join(root, "cache");
    const backend = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: { cacheDir, templateRevision: "release-7" },
    });
    await backend.prewarm({
      templateKey: "metadata-template",
      runtimeContext: { appRoot: path.join(root, "release") },
      seedFiles: [],
    });

    const [templateId] = await readdir(path.join(cacheDir, "templates"));
    const metadata = JSON.parse(
      await readFile(path.join(cacheDir, "metadata", "templates", `${templateId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      kind: "template",
      id: templateId,
      templateRevision: "release-7",
    });
  });
});

describe("create", () => {
  test("applies onSession use options before returning the live session", async () => {
    const argv: Array<readonly string[]> = [];
    const runner: ProcessRunner = {
      spawn(command) {
        argv.push(command);
        const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        return {
          stdout: empty(),
          stderr: empty(),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-use-options-"));
    const backend = createBwrapSandboxBackend({ runner });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "session-options",
      runtimeContext: { appRoot },
    });

    const session = await handle.useSessionFn({ networkPolicy: "deny-all" });
    await session.run({ command: "true" });

    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain("--unshare-net");
  });

  test("clones the template into a persistent per-session workspace", async () => {
    const { backend, runtimeContext } = await makeBackend();
    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "seeded" }],
    });

    const handle = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "sess-1",
      runtimeContext,
    });
    expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("seeded");
    expect(await handle.useSessionFn()).toBe(handle.session);
    expect(await handle.captureState()).toEqual({
      backendName: "bwrap",
      metadata: {},
      sessionKey: "sess-1",
    });

    await handle.session.writeTextFile({ path: "state.txt", content: "persisted" });
    await handle.shutdown();

    const again = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "sess-1",
      runtimeContext,
    });
    expect(await again.session.readTextFile({ path: "state.txt" })).toBe("persisted");

    const other = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "sess-2",
      runtimeContext,
    });
    expect(await other.session.readTextFile({ path: "state.txt" })).toBeNull();
  });

  test("records operator metadata outside the sandbox-writable workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-cache-metadata-"));
    const cacheDir = path.join(root, "cache");
    const backend = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: { cacheDir },
    });
    const runtimeContext = { appRoot: path.join(root, "release") };

    const handle = await backend.create({
      templateKey: null,
      sessionKey: "metadata-session",
      tags: { channel: "http" },
      runtimeContext,
    });

    const [sessionId] = await readdir(path.join(cacheDir, "sessions"));
    const metadata = JSON.parse(
      await readFile(path.join(cacheDir, "metadata", "sessions", `${sessionId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      kind: "session",
      id: sessionId,
      tags: { channel: "http" },
      cloneStrategy: "empty",
    });
    expect(metadata.createdAt).toEqual(expect.any(String));
    expect(metadata.lastUsedAt).toEqual(expect.any(String));
    await expect(
      readFile(path.join(cacheDir, "sessions", sessionId!, ".eveland-cache.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await handle.stop();
  });

  test("falls back to a regular template copy when reflink cloning is unsupported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-clone-fallback-"));
    const cacheDir = path.join(root, "cache");
    const modes: Array<number | undefined> = [];
    const backend = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: { cacheDir },
      copyDirectory: async (source, target, options) => {
        modes.push(options.mode);
        if (options.mode === constants.COPYFILE_FICLONE_FORCE) {
          throw Object.assign(new Error("reflink unsupported"), { code: "ENOTSUP" });
        }
        await cp(source, target, { recursive: true });
      },
    });
    const runtimeContext = { appRoot: path.join(root, "release") };
    await backend.prewarm({
      templateKey: "clone-source",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "seeded" }],
    });

    const handle = await backend.create({
      templateKey: "clone-source",
      sessionKey: "clone-target",
      runtimeContext,
    });

    expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("seeded");
    expect(modes).toEqual([constants.COPYFILE_FICLONE_FORCE, undefined]);
    const [sessionId] = await readdir(path.join(cacheDir, "sessions"));
    const metadata = JSON.parse(
      await readFile(path.join(cacheDir, "metadata", "sessions", `${sessionId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata.cloneStrategy).toBe("copy");
  });

  test("null templateKey creates an empty workspace", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({ templateKey: null, sessionKey: "fresh", runtimeContext });
    const result = await handle.session.readTextFile({ path: "anything.txt" });
    expect(result).toBeNull();
  });

  test("missing template throws the typed eve error", async () => {
    const { backend, runtimeContext } = await makeBackend();
    await expect(
      backend.create({ templateKey: "never-prewarmed", sessionKey: "s", runtimeContext }),
    ).rejects.toSatisfy((error: unknown) => SandboxTemplateNotProvisionedError.is(error));
  });

  test("options changes re-key templates but not sessions", async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-"));
    const runtimeContext = { appRoot };
    const a = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { env: { A: "1" } } });
    const b = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { env: { A: "2" } } });
    await a.prewarm({ templateKey: "tpl", runtimeContext, seedFiles: [] });
    // same templateKey under different options is a distinct template
    await expect(
      b.create({ templateKey: "tpl", sessionKey: "s", runtimeContext }),
    ).rejects.toSatisfy((error: unknown) => SandboxTemplateNotProvisionedError.is(error));
  });

  test("shutdown kills the session's live processes and leaves the workspace on disk", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "sess-shutdown",
      runtimeContext,
    });
    await handle.session.writeTextFile({ path: "keep.txt", content: "durable" });

    await handle.shutdown();

    const again = await backend.create({
      templateKey: null,
      sessionKey: "sess-shutdown",
      runtimeContext,
    });
    expect(await again.session.readTextFile({ path: "keep.txt" })).toBe("durable");
  });

  /**
   * eve calls `stop()` when authored code runs `ctx.getSandbox().stop()` mid-run,
   * not at server teardown: the compute stops but the durable session must reopen
   * on the next callback. For bwrap that is the same operation as `shutdown()` —
   * the workspace directory _is_ the durable state — so what this pins is that
   * `stop()` exists at all and does not take the workspace with it.
   */
  test("stop kills live processes and leaves the session reopenable", async () => {
    const killed: number[] = [];
    const exits = new Map<number, (value: { exitCode: number }) => void>();
    let pid = 0;
    const runner: ProcessRunner = {
      spawn() {
        const id = ++pid;
        const exit = new Promise<{ exitCode: number }>((resolve) => exits.set(id, resolve));
        const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
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
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-stop-"));
    const runtimeContext = { appRoot };
    const backend = createBwrapSandboxBackend({ runner });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "sess-stop",
      runtimeContext,
    });
    await handle.session.writeTextFile({ path: "keep.txt", content: "durable" });
    await handle.session.spawn({ command: "sleep 60" });

    await handle.stop();
    await handle.stop();

    expect(killed).toEqual([1]);
    const reopened = await backend.create({
      templateKey: null,
      sessionKey: "sess-stop",
      runtimeContext,
    });
    expect(await reopened.session.readTextFile({ path: "keep.txt" })).toBe("durable");
  });

  /**
   * eve (>=0.47) calls `delete()` when authored code runs
   * `ctx.getSandbox().delete()`: the sandbox is gone for good and the next
   * access reprovisions it. What this pins is the split the contract demands —
   * the session workspace and its metadata sidecar are removed while the
   * shared template survives, so a later create() starts from template state
   * instead of reopening deleted files.
   */
  test("delete kills live processes and permanently removes the session, not the template", async () => {
    const killed: number[] = [];
    const exits = new Map<number, (value: { exitCode: number }) => void>();
    let pid = 0;
    const runner: ProcessRunner = {
      spawn() {
        const id = ++pid;
        const exit = new Promise<{ exitCode: number }>((resolve) => exits.set(id, resolve));
        const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
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
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-backend-delete-"));
    const cacheDir = path.join(root, "cache");
    const backend = createBwrapSandboxBackend({ runner, createOptions: { cacheDir } });
    const runtimeContext = { appRoot: path.join(root, "release") };
    await backend.prewarm({
      templateKey: "tpl-del",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "seeded" }],
    });

    const handle = await backend.create({
      templateKey: "tpl-del",
      sessionKey: "sess-delete",
      runtimeContext,
    });
    await handle.session.writeTextFile({ path: "scratch.txt", content: "doomed" });
    await handle.session.spawn({ command: "sleep 60" });
    const [sessionId] = await readdir(path.join(cacheDir, "sessions"));

    await handle.delete();

    expect(killed).toEqual([1]);
    await expect(readdir(path.join(cacheDir, "sessions"))).resolves.toEqual([]);
    await expect(
      readFile(path.join(cacheDir, "metadata", "sessions", `${sessionId}.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const reprovisioned = await backend.create({
      templateKey: "tpl-del",
      sessionKey: "sess-delete",
      runtimeContext,
    });
    expect(await reprovisioned.session.readTextFile({ path: "seed.txt" })).toBe("seeded");
    expect(await reprovisioned.session.readTextFile({ path: "scratch.txt" })).toBeNull();
  });

  test("delete honors an already-aborted signal before touching the session", async () => {
    const { backend, runtimeContext } = await makeBackend();
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "sess-delete-abort",
      runtimeContext,
    });
    await handle.session.writeTextFile({ path: "keep.txt", content: "durable" });

    await expect(handle.delete({ abortSignal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(await handle.session.readTextFile({ path: "keep.txt" })).toBe("durable");
  });

  test("handles opened for the same durable session share one compute generation", async () => {
    const killed: number[] = [];
    let resolveExit!: (value: { exitCode: number }) => void;
    const exit = new Promise<{ exitCode: number }>((resolve) => (resolveExit = resolve));
    const runner: ProcessRunner = {
      spawn() {
        const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        return {
          pid: 41,
          stdout: empty(),
          stderr: empty(),
          wait: async () => await exit,
          kill: async () => {
            killed.push(41);
            resolveExit({ exitCode: 137 });
          },
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-shared-generation-"));
    const runtimeContext = { appRoot };
    const backend = createBwrapSandboxBackend({ runner });
    const first = await backend.create({
      templateKey: null,
      sessionKey: "same-session",
      runtimeContext,
    });
    const second = await backend.create({
      templateKey: null,
      sessionKey: "same-session",
      runtimeContext,
    });
    await first.session.spawn({ command: "long-running" });

    await second.stop();

    expect(killed).toEqual([41]);
    await expect(first.session.spawn({ command: "must-not-escape" })).rejects.toThrow(/stopped/);
  });

  test("emits tagged command and cleanup receipts with generation identity", async () => {
    const events: BwrapSandboxEvent[] = [];
    let resolveExit!: (value: { exitCode: number }) => void;
    const exit = new Promise<{ exitCode: number }>((resolve) => (resolveExit = resolve));
    const runner: ProcessRunner = {
      spawn() {
        const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        return {
          pid: 51,
          stdout: empty(),
          stderr: empty(),
          wait: async () => await exit,
          kill: async () => resolveExit({ exitCode: 137 }),
        };
      },
    };
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-events-"));
    const backend = createBwrapSandboxBackend({
      runner,
      createOptions: { onEvent: (event) => events.push(event) },
    });
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "observable",
      tags: { channel: "http", session: "eve-session-1" },
      runtimeContext: { appRoot },
    });

    await handle.session.spawn({ command: "long-running" });
    await handle.stop();

    const started = events.find((event) => event.type === "command.started");
    expect(started).toMatchObject({
      sessionId: "observable",
      pid: 51,
      pgid: 51,
      liveProcesses: 1,
      tags: { channel: "http", session: "eve-session-1" },
    });
    expect(started?.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started?.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.find((event) => event.type === "command.finished")).toMatchObject({
      commandId: started?.commandId,
      reason: "cleanup",
      exitCode: 137,
      liveProcesses: 0,
    });
    expect(events.find((event) => event.type === "cleanup.completed")).toMatchObject({
      requestedProcesses: 1,
      remainingProcesses: 0,
    });
  });

  test("an asynchronous event sink failure cannot escape into sandbox behavior", async () => {
    const backend = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: {
        onEvent: async () => {
          throw new Error("telemetry unavailable");
        },
      },
    });
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-event-failure-"));
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "event-failure",
      runtimeContext: { appRoot },
    });

    await expect(handle.session.run({ command: "true" })).resolves.toMatchObject({ exitCode: 0 });
    await expect(handle.stop()).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
  });

  test("session state survives a change of appRoot when cacheDir is pinned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-redeploy-"));
    const cacheDir = path.join(root, "stable");
    const backend = createBwrapSandboxBackend({ runner: fakeRunner, createOptions: { cacheDir } });

    const first = await backend.create({
      templateKey: null,
      sessionKey: "s",
      runtimeContext: { appRoot: path.join(root, "release-1") },
    });
    await first.session.writeTextFile({ path: "state.txt", content: "kept" });
    await first.shutdown();

    // Redeploy: brand-new appRoot, same project cache.
    const second = await backend.create({
      templateKey: null,
      sessionKey: "s",
      runtimeContext: { appRoot: path.join(root, "release-2") },
    });
    expect(await second.session.readTextFile({ path: "state.txt" })).toBe("kept");
  });

  test("a new template revision refreshes seeds for new sessions without overwriting existing sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bwrap-redeploy-seeds-"));
    const cacheDir = path.join(root, "stable");
    const runtimeContext = { appRoot: "/app" };
    const first = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: { cacheDir, templateRevision: "release-1" },
    });
    await first.prewarm({
      templateKey: "tpl",
      runtimeContext,
      seedFiles: [{ path: "knowledge.md", content: "first release" }],
    });
    const existing = await first.create({
      templateKey: "tpl",
      sessionKey: "existing",
      runtimeContext,
    });
    await existing.session.writeTextFile({ path: "runtime-note.txt", content: "keep me" });
    await existing.shutdown();

    const second = createBwrapSandboxBackend({
      runner: fakeRunner,
      createOptions: { cacheDir, templateRevision: "release-2" },
    });
    const prewarm = await second.prewarm({
      templateKey: "tpl",
      runtimeContext,
      seedFiles: [{ path: "knowledge.md", content: "second release" }],
    });

    expect(prewarm).toEqual({ reused: false });
    const fresh = await second.create({ templateKey: "tpl", sessionKey: "fresh", runtimeContext });
    expect(await fresh.session.readTextFile({ path: "knowledge.md" })).toBe("second release");

    const reattached = await second.create({
      templateKey: "tpl",
      sessionKey: "existing",
      runtimeContext,
    });
    expect(await reattached.session.readTextFile({ path: "knowledge.md" })).toBe("first release");
    expect(await reattached.session.readTextFile({ path: "runtime-note.txt" })).toBe("keep me");
  });
});

describe("public API", () => {
  test("exposes the frozen backend name and factory", () => {
    expect(BWRAP_BACKEND_NAME).toBe("bwrap");
    expect(bwrap().name).toBe("bwrap");
    expect(typeof isBwrapAvailable).toBe("function");
  });
});
