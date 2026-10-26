import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxProviderSessionContext } from "eve-legacy/sandbox/provider";
import type { SandboxPrepareContext, SandboxSessionContext } from "eve/sandbox/provider";
import { EVE_SANDBOX_HOME_PROBE } from "./connection.js";
import { sessionPathIn } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import type { BwrapSandboxConnection } from "./provider-contract.js";
import type { BwrapSandboxEnvironmentOptions } from "./provider-definition.js";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";
import { createLiveRunner, empty, exitingRunner, makeRelease } from "./provider.test-support.js";

/**
 * The eve 0.83+ connection contract. eve derives the session from the
 * connection and seeds templates itself through `ctx.populate`, so these tests
 * stand in for eve with a `populate` that makes the same calls eve 0.83.3
 * makes: the `$HOME` probe when there are skills, one `writeFiles` batch, then
 * the authored preparation over the connection.
 */

const encoder = new TextEncoder();

function environment(
  options?: BwrapSandboxEnvironmentOptions,
  runner: ProcessRunner = exitingRunner,
) {
  return createBwrapSandboxProviderDefinition({ runner }).environment(options);
}

async function readText(connection: BwrapSandboxConnection, file: string) {
  const stream = await connection.readFile({ path: file });
  return stream === null ? null : await new Response(stream).text();
}

async function runToText(connection: BwrapSandboxConnection, command: string) {
  const proc = await connection.spawn({ command, env: {}, workingDirectory: "/workspace" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.wait()]);
  return stdout;
}

function prepareContext(
  storagePath: string,
  input: {
    workspace?: Record<string, string>;
    skills?: Record<string, string>;
    prepare?: (connection: BwrapSandboxConnection) => Promise<void>;
    revision?: string;
  } = {},
): SandboxPrepareContext {
  return {
    files: { list: async () => [], read: async () => new Uint8Array(), readText: async () => "" },
    isEmpty: false,
    storagePath,
    log: () => {},
    resolveProjectPath: (projectPath) => projectPath,
    resourcesDirectory: async () => undefined,
    templateKey: (identity) =>
      createHash("sha256")
        .update(JSON.stringify({ identity, input: { ...input, prepare: undefined } }))
        .digest("hex"),
    async populate(connection) {
      const bwrap = connection as unknown as BwrapSandboxConnection;
      const home =
        input.skills === undefined
          ? undefined
          : (await runToText(bwrap, EVE_SANDBOX_HOME_PROBE)).trim();
      const files = [
        ...Object.entries(input.workspace ?? {}).map(([relativePath, content]) => ({
          path: `${bwrap.workspaceRoot}/${relativePath}`,
          content: encoder.encode(content),
        })),
        ...Object.entries(input.skills ?? {}).map(([relativePath, content]) => ({
          path: `${home}/.agents/skills/${relativePath}`,
          content: encoder.encode(content),
        })),
      ];
      if (files.length > 0) await bwrap.writeFiles({ files });
      await input.prepare?.(bwrap);
    },
  };
}

function sessionContext(storagePath: string, sessionId: string): SandboxSessionContext {
  return {
    kind: "session",
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn-1", sequence: 0 },
    },
    storagePath,
    resolveProjectPath: (projectPath: string) => projectPath,
  } as unknown as SandboxSessionContext;
}

describe("prepare", () => {
  test("seeds the workspace and skills through populate without launching bwrap", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);

    const artifact = await env.prepare(
      prepareContext(storagePath, {
        workspace: { "input.txt": "from seed" },
        skills: { "research/SKILL.md": "Use this research procedure." },
      }),
    );
    // The `$HOME` probe is answered without bwrap, so a build host needs bwrap
    // only for authored preparation.
    expect(calls).toEqual([]);

    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    expect(await readText(connection, "/workspace/input.txt")).toBe("from seed");
    expect(await readText(connection, "/workspace/.agents/skills/research/SKILL.md")).toBe(
      "Use this research procedure.",
    );
  });

  test("answers the $HOME probe with the HOME the sandbox's commands actually see", async () => {
    const { storagePath } = await makeRelease();
    const env = environment({ env: { HOME: "/workspace/home" } });

    const artifact = await env.prepare(
      prepareContext(storagePath, { skills: { "a/SKILL.md": "a" } }),
    );
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);

    expect(await readText(connection, "/workspace/home/.agents/skills/a/SKILL.md")).toBe("a");
  });

  test("runs authored commands from populate inside bwrap and stops them before capture", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls, killed } = createLiveRunner();
    const env = environment(undefined, runner);

    await env.prepare(
      prepareContext(storagePath, {
        async prepare(connection) {
          await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain("bwrap");
    expect(killed).toEqual([1]);
  });

  test("reuses a template for the same key and captures a new one when the key changes", async () => {
    const { storagePath } = await makeRelease();
    let populated = 0;
    const counting = (revision: string) => ({
      revision,
      async prepare() {
        populated += 1;
      },
    });
    const env = environment();

    const first = await env.prepare(prepareContext(storagePath, counting("r1")));
    const again = await env.prepare(prepareContext(storagePath, counting("r1")));
    const changed = await env.prepare(prepareContext(storagePath, counting("r2")));

    expect(again).toEqual(first);
    expect(changed.templatePath).not.toBe(first.templatePath);
    expect(populated).toBe(2);
  });
});

describe("start, resume, and session end", () => {
  test("start returns a connection and JSON state, and applies the open-time policy", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));

    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      { networkPolicy: "deny-all" },
      artifact,
    );
    await connection.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    expect(connection.workspaceRoot).toBe("/workspace");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toMatchObject({ version: 1, networkPolicy: "deny-all" });
    expect(calls[0]).toContain("--unshare-net");
  });

  test("start is an upsert: a live sandbox keeps its workspace and current policy", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const first = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await first.connection.writeFiles({
      files: [{ path: "/workspace/kept.txt", content: encoder.encode("kept") }],
    });
    await first.connection.extensions.setNetworkPolicy("deny-all");

    // A subagent sharing the sandbox starts it again with its own options.
    const second = await env.start(
      sessionContext(storagePath, "s"),
      { networkPolicy: "allow-all" },
      artifact,
    );
    await second.connection.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    expect(await readText(second.connection, "/workspace/kept.txt")).toBe("kept");
    expect(calls[0]).toContain("--unshare-net");
  });

  test("resume after a restart reopens the workspace under the recorded policy", async () => {
    const { storagePath } = await makeRelease();
    const artifact = await environment().prepare(prepareContext(storagePath));
    const before = await environment().start(
      sessionContext(storagePath, "s"),
      { networkPolicy: "deny-all" },
      artifact,
    );
    await before.connection.writeFiles({
      files: [{ path: "/workspace/keep.txt", content: encoder.encode("durable") }],
    });
    await before.connection.stop();

    const { runner, calls } = createLiveRunner();
    const resumed = await environment(undefined, runner).resume(
      sessionContext(storagePath, "s"),
      artifact,
      before.state,
    );
    await resumed.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    expect(await readText(resumed, "/workspace/keep.txt")).toBe("durable");
    expect(calls[0]).toContain("--unshare-net");
  });

  test("resume of a workspace that is gone throws the error eve starts fresh on", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const { state } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await env.onSessionEnd(sessionContext(storagePath, "s"), state, { reason: "completed" });

    await expect(
      env.resume(sessionContext(storagePath, "s"), artifact, state),
    ).rejects.toMatchObject({ name: "SandboxSessionGoneError" });
  });

  test("ends a session that never recorded state by its session-derived key, idempotently", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    const workspace = sessionPathIn(path.join(storagePath, "bwrap"), "session:s");
    expect(existsSync(workspace)).toBe(true);

    await env.onSessionEnd(sessionContext(storagePath, "s"), null, { reason: "deleted" });
    await env.onSessionEnd(sessionContext(storagePath, "s"), null, { reason: "deleted" });

    expect(existsSync(workspace)).toBe(false);
  });

  test("records state the handle contract resumes, so a rollback below eve 0.83 still opens it", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const started = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await started.connection.writeFiles({
      files: [{ path: "/workspace/note.txt", content: encoder.encode("across lines") }],
    });

    const legacyContext = {
      host: {},
      session: { id: "s" },
      storagePath,
    } as unknown as SandboxProviderSessionContext;
    const handle = await environment().resume(legacyContext, artifact, started.state);

    expect(await handle.sandbox.readTextFile({ path: "note.txt" })).toBe("across lines");
  });
});

describe("connection", () => {
  test("reads null for a missing path and rejects a directory", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath, { workspace: { "d/f": "x" } }));
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);

    expect(await connection.readFile({ path: "/workspace/missing" })).toBeNull();
    await expect(connection.readFile({ path: "/workspace/d" })).rejects.toThrow(/directory/);
  });

  test("writes a batch atomically with respect to containment", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);

    await expect(
      connection.writeFiles({
        files: [
          { path: "/workspace/inside.txt", content: encoder.encode("a") },
          { path: "/workspace/../escape.txt", content: encoder.encode("b") },
        ],
      }),
    ).rejects.toThrow(/outside/);
    expect(await connection.readFile({ path: "/workspace/inside.txt" })).toBeNull();
  });

  test("close keeps running processes; stop kills them and keeps the files", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath, { workspace: { f: "x" } }));
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });

    await connection.close();
    expect(killed).toEqual([]);
    await connection.stop();
    expect(killed).toEqual([1]);
    expect(await readText(connection, "/workspace/f")).toBe("x");
  });

  test("forwards eve 0.84's `signal` as well as 0.83's `abortSignal` to the process", async () => {
    const { storagePath } = await makeRelease();
    const signals: (AbortSignal | undefined)[] = [];
    const runner: ProcessRunner = {
      spawn(_argv, options) {
        signals.push(options?.abortSignal);
        return {
          stdout: empty(),
          stderr: empty(),
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
        };
      },
    };
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    const older = new AbortController().signal;
    const newer = new AbortController().signal;

    await connection.spawn({
      command: "a",
      env: {},
      workingDirectory: "/workspace",
      abortSignal: older,
    });
    await connection.spawn({
      command: "b",
      env: {},
      workingDirectory: "/workspace",
      signal: newer,
    });

    expect(signals).toEqual([older, newer]);
  });
});
