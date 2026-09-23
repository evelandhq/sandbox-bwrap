import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type {
  SandboxProviderPrepareContext,
  SandboxProviderResources,
  SandboxProviderSessionContext,
} from "eve/sandbox/provider";
import { listBwrapCache } from "./cache.js";
import type { ProcessRunner } from "./process.js";
import type { BwrapSandboxEnvironmentOptions } from "./provider-definition.js";
import {
  BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
  createBwrapSandboxProviderDefinition,
} from "./provider-definition.js";

const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

/** Records every argv; each process exits only when killed. */
function createLiveRunner() {
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

const exitingRunner: ProcessRunner = {
  spawn() {
    return {
      stdout: empty(),
      stderr: empty(),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    };
  },
};

const unusedHost: SandboxProviderPrepareContext["host"] = {
  loadOptionalPackage: async () => {
    throw new Error("the bwrap provider loads no optional package");
  },
  resolveProjectPath: (projectPath) => projectPath,
};

function resources(input: {
  workspace?: Record<string, string | Uint8Array>;
  skills?: Record<string, string | Uint8Array>;
  key?: string;
}): SandboxProviderResources {
  const tree = (
    name: "workspace" | "skills",
    targetPath: string,
    files: Record<string, string | Uint8Array> | undefined,
  ) =>
    files === undefined
      ? undefined
      : {
          key: `${input.key ?? "k1"}:${name}`,
          mountPath: `/eve/resources/${name}`,
          targetPath,
          files: Object.entries(files).map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
        };
  return {
    source: { kind: "inline", key: input.key ?? "k1" },
    workspace: tree("workspace", "/workspace", input.workspace),
    skills: tree("skills", "$HOME/.agents/skills", input.skills),
  };
}

async function makeRelease() {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-provider-"));
  return { appRoot, storagePath: path.join(appRoot, ".eve", "sandbox-cache") };
}

function prepareContext(
  storagePath: string,
  input: { resources?: SandboxProviderResources; sourceRevision?: string; log?: string[] } = {},
): SandboxProviderPrepareContext {
  return {
    files: {
      list: async () => [],
      read: async () => new Uint8Array(),
      readText: async () => "",
    },
    host: unusedHost,
    log: input.log ? (message) => input.log!.push(message) : undefined,
    resources: input.resources ?? { source: { kind: "none" } },
    sourceRevision: input.sourceRevision ?? "rev-1",
    storagePath,
  };
}

function sessionContext(storagePath: string, sessionId: string): SandboxProviderSessionContext {
  return {
    host: unusedHost,
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn-1", sequence: 0 },
    },
    storagePath,
  } as SandboxProviderSessionContext;
}

function environment(
  options?: BwrapSandboxEnvironmentOptions,
  runner: ProcessRunner = exitingRunner,
) {
  return createBwrapSandboxProviderDefinition({ runner }).environment(options);
}

describe("prepare", () => {
  test("captures workspace and skill resources into a template every new session starts from", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(
      prepareContext(storagePath, {
        resources: resources({
          workspace: { "input.txt": "from seed", "nested/data.bin": Uint8Array.from([0, 1, 255]) },
          skills: { "research/SKILL.md": "Use this research procedure." },
        }),
      }),
    );

    expect(artifact.templatePath.startsWith(path.join(storagePath, "bwrap", "templates"))).toBe(
      true,
    );
    const { handle } = await env.start(
      sessionContext(storagePath, "session-1"),
      undefined,
      artifact,
    );
    expect(await handle.sandbox.readTextFile({ path: "input.txt" })).toBe("from seed");
    expect([...((await handle.sandbox.readBinaryFile({ path: "nested/data.bin" })) ?? [])]).toEqual(
      [0, 1, 255],
    );
    expect(
      await handle.sandbox.readTextFile({ path: "/workspace/.agents/skills/research/SKILL.md" }),
    ).toBe("Use this research procedure.");
  });

  test("runs authored preparation against the template, after the seeds are in place", async () => {
    const { storagePath } = await makeRelease();
    const env = environment({
      async prepare(sandbox) {
        const seeded = await sandbox.readTextFile({ path: "input.txt" });
        await sandbox.writeTextFile({
          path: "prepared.txt",
          content: `saw:${seeded ?? "missing"}`,
        });
      },
    });
    const artifact = await env.prepare(
      prepareContext(storagePath, { resources: resources({ workspace: { "input.txt": "seed" } }) }),
    );

    const first = await env.start(sessionContext(storagePath, "a"), undefined, artifact);
    const second = await env.start(sessionContext(storagePath, "b"), undefined, artifact);
    expect(await first.handle.sandbox.readTextFile({ path: "prepared.txt" })).toBe("saw:seed");
    expect(await second.handle.sandbox.readTextFile({ path: "prepared.txt" })).toBe("saw:seed");
  });

  test("stops anything authored preparation left running before the template is captured", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(
      {
        async prepare(sandbox) {
          await sandbox.spawn({ command: "sleep 60" });
        },
      },
      runner,
    );

    await env.prepare(prepareContext(storagePath));

    expect(killed).toEqual([1]);
  });

  test("reuses a template for identical inputs and captures a new one when the source changes", async () => {
    const { storagePath } = await makeRelease();
    let prepared = 0;
    const env = environment({
      async prepare() {
        prepared += 1;
      },
    });
    const input = { resources: resources({ workspace: { "a.txt": "a" } }) };

    const first = await env.prepare(
      prepareContext(storagePath, { ...input, sourceRevision: "r1" }),
    );
    const again = await env.prepare(
      prepareContext(storagePath, { ...input, sourceRevision: "r1" }),
    );
    const changed = await env.prepare(
      prepareContext(storagePath, { ...input, sourceRevision: "r2" }),
    );

    expect(again).toEqual(first);
    expect(changed.templatePath).not.toBe(first.templatePath);
    expect(prepared).toBe(2);
  });

  test("keeps templates in eve's storage directory even when cacheDir moves session workspaces", async () => {
    const { appRoot, storagePath } = await makeRelease();
    const cacheDir = path.join(appRoot, "..", `${path.basename(appRoot)}-sessions`);
    const env = environment({ cacheDir });
    const artifact = await env.prepare(prepareContext(storagePath));
    await env.start(sessionContext(storagePath, "session-1"), undefined, artifact);

    const templates = await listBwrapCache({ appRoot });
    const sessions = await listBwrapCache({ appRoot, cacheDir });
    expect(templates.map((entry) => entry.kind)).toEqual(["template"]);
    expect(sessions.map((entry) => [entry.kind, entry.tags])).toEqual([
      ["session", { sessionId: "session-1" }],
    ]);
    await rm(cacheDir, { force: true, recursive: true });
  });
});

describe("start and resume", () => {
  test("records JSON session state with the open-time network policy and applies it", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));

    const { handle, state } = await env.start(
      sessionContext(storagePath, "session-1"),
      { networkPolicy: "deny-all" },
      artifact,
    );
    await handle.sandbox.spawn({ command: "true" });

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toMatchObject({ version: 1, networkPolicy: "deny-all" });
    expect(calls[0]).toContain("--unshare-net");
  });

  test("resume after a restart reopens the same workspace with the recorded network policy", async () => {
    const { storagePath } = await makeRelease();
    const artifact = await environment().prepare(prepareContext(storagePath));
    const before = await environment().start(
      sessionContext(storagePath, "session-1"),
      { networkPolicy: "deny-all" },
      artifact,
    );
    await before.handle.sandbox.writeTextFile({ path: "keep.txt", content: "durable" });
    await before.handle.onRuntimeShutdown();

    // A fresh definition stands in for a new process after a restart.
    const { runner, calls } = createLiveRunner();
    const resumed = await environment(undefined, runner).resume(
      sessionContext(storagePath, "session-1"),
      artifact,
      before.state,
    );
    await resumed.sandbox.spawn({ command: "true" });

    expect(await resumed.sandbox.readTextFile({ path: "keep.txt" })).toBe("durable");
    expect(calls[0]).toContain("--unshare-net");
  });

  test("resume within one process keeps the live generation and its current network policy", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const started = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await started.handle.sandbox.setNetworkPolicy("deny-all");

    const resumed = await env.resume(sessionContext(storagePath, "s"), artifact, started.state);
    await resumed.sandbox.spawn({ command: "true" });

    expect(resumed.sandbox).toBe(started.handle.sandbox);
    expect(calls[0]).toContain("--unshare-net");
  });

  test("resume does not need the template, so a session survives a move to another deployment", async () => {
    const release = await makeRelease();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-provider-shared-"));
    const first = environment({ cacheDir });
    const artifact = await first.prepare(prepareContext(release.storagePath));
    const started = await first.start(
      sessionContext(release.storagePath, "session-1"),
      undefined,
      artifact,
    );
    await started.handle.sandbox.writeTextFile({ path: "keep.txt", content: "moved" });
    await started.handle.onRuntimeShutdown();
    await rm(release.appRoot, { force: true, recursive: true });

    const next = await makeRelease();
    const nextEnv = environment({ cacheDir });
    const nextArtifact = await nextEnv.prepare(
      prepareContext(next.storagePath, { sourceRevision: "r2" }),
    );
    const resumed = await nextEnv.resume(
      sessionContext(next.storagePath, "session-1"),
      nextArtifact,
      started.state,
    );

    expect(await resumed.sandbox.readTextFile({ path: "keep.txt" })).toBe("moved");
  });

  test("resume fails when the session workspace is gone instead of recreating it", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const { handle, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await handle.onSessionDelete();

    await expect(env.resume(sessionContext(storagePath, "s"), artifact, state)).rejects.toThrow(
      /no longer exists/,
    );
  });

  test("start without a prepared template throws the error eve recognizes", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    await rm(artifact.templatePath, { force: true, recursive: true });

    await expect(
      env.start(sessionContext(storagePath, "s"), undefined, artifact),
    ).rejects.toMatchObject({
      name: "SandboxTemplateNotProvisionedError",
      providerName: "bwrap",
      templateKey: artifact.templatePath,
    });
  });

  test("rejects artifacts and state this provider did not write", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const { state } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);

    await expect(
      env.start(sessionContext(storagePath, "t"), undefined, { templatePath: 1 } as never),
    ).rejects.toThrow(/artifact/);
    await expect(
      env.resume(sessionContext(storagePath, "s"), artifact, { ...state, version: 2 } as never),
    ).rejects.toThrow(/session state/);
  });
});

describe("handle lifecycle", () => {
  test("stop and runtime shutdown kill live processes and keep the workspace", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { handle, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await handle.sandbox.writeTextFile({ path: "keep.txt", content: "durable" });
    await handle.sandbox.spawn({ command: "sleep 60" });

    await handle.onSessionStop();
    await handle.onRuntimeShutdown();

    expect(killed).toEqual([1]);
    const resumed = await env.resume(sessionContext(storagePath, "s"), artifact, state);
    expect(resumed.sandbox).not.toBe(handle.sandbox);
    expect(await resumed.sandbox.readTextFile({ path: "keep.txt" })).toBe("durable");
  });

  test("session delete removes the workspace and its metadata, not the template", async () => {
    const { appRoot, storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(
      prepareContext(storagePath, {
        resources: resources({ workspace: { "seed.txt": "seeded" } }),
      }),
    );
    const { handle } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await handle.sandbox.writeTextFile({ path: "scratch.txt", content: "doomed" });
    await handle.sandbox.spawn({ command: "sleep 60" });

    await handle.onSessionDelete();

    expect(killed).toEqual([1]);
    expect((await listBwrapCache({ appRoot })).map((entry) => entry.kind)).toEqual(["template"]);
    await expect(readdir(path.join(storagePath, "bwrap", "sessions"))).resolves.toEqual([]);
    const fresh = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    expect(await fresh.handle.sandbox.readTextFile({ path: "seed.txt" })).toBe("seeded");
    expect(await fresh.handle.sandbox.readTextFile({ path: "scratch.txt" })).toBeNull();
  });

  test("session delete honors an already-aborted signal before touching the workspace", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const { handle } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await handle.sandbox.writeTextFile({ path: "keep.txt", content: "durable" });

    await expect(
      handle.onSessionDelete({ abortSignal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(await handle.sandbox.readTextFile({ path: "keep.txt" })).toBe("durable");
  });
});

describe("definition", () => {
  test("names the provider bwrap at state protocol 1", async () => {
    const definition = createBwrapSandboxProviderDefinition();

    expect(definition.name).toBe("bwrap");
    expect(definition.stateProtocolVersion).toBe(BWRAP_PROVIDER_STATE_PROTOCOL_VERSION);
    expect(BWRAP_PROVIDER_STATE_PROTOCOL_VERSION).toBe(1);
  });

  test("the prepared template is readable from the artifact path eve records", async () => {
    const { storagePath } = await makeRelease();
    const artifact = await environment().prepare(
      prepareContext(storagePath, { resources: resources({ workspace: { "a.txt": "a" } }) }),
    );

    expect(await readFile(path.join(artifact.templatePath, "a.txt"), "utf8")).toBe("a");
  });
});
