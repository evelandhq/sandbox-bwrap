import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxPrepareContext, SandboxSessionContext } from "eve/sandbox/provider";
import { listBwrapCache } from "./cache.js";
import { EVE_SANDBOX_HOME_PROBE } from "./connection.js";
import type { BwrapSandboxEnvironmentOptions } from "./options.js";
import { sessionPathIn } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import type { BwrapSandboxConnection } from "./provider-contract.js";
import {
  BWRAP_PROVIDER_STATE_PROTOCOL_VERSION,
  createBwrapSandboxProviderDefinition,
} from "./provider-definition.js";
import {
  createLiveRunner,
  empty,
  exitingRunner,
  fakeHolders,
  makeRelease,
  parseJoin,
  readUntilSettled,
  withFakeHolder,
} from "./provider.test-support.js";
import { SANDBOX_TRUST_ENV } from "./trust.js";

/**
 * eve's sandbox provider contract. eve derives the session from the
 * connection and seeds templates itself through `ctx.populate`, so these tests
 * stand in for eve with a `populate` that makes the same calls eve's does: the
 * `$HOME` probe when there are skills, one `writeFiles` batch, then the
 * authored preparation over the connection.
 */

const encoder = new TextEncoder();

function environment(
  options?: BwrapSandboxEnvironmentOptions,
  runner: ProcessRunner = exitingRunner,
) {
  return createBwrapSandboxProviderDefinition({ runner: withFakeHolder(runner) }).environment(
    options,
  );
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
    expect(calls[0]?.[0]).toBe("python3");
    expect(killed).toEqual([1]);
    // The template's sandbox ends with the capture, and with it anything the
    // authored preparation left running in the background.
    expect(fakeHolders(runner).map((holder) => [holder.argv[0], holder.killed])).toEqual([
      ["bwrap", true],
    ]);
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
    const { runner } = createLiveRunner();
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
    expect(fakeHolders(runner)[0]?.argv).toContain("--unshare-net");
  });

  test("start is an upsert: a live sandbox keeps its workspace and current policy", async () => {
    const { storagePath } = await makeRelease();
    const { runner } = createLiveRunner();
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
    expect(fakeHolders(runner).map((holder) => holder.argv.includes("--unshare-net"))).toEqual([
      true,
    ]);
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

    const { runner } = createLiveRunner();
    const resumed = await environment(undefined, runner).resume(
      sessionContext(storagePath, "s"),
      artifact,
      before.state,
    );
    await resumed.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    expect(await readText(resumed, "/workspace/keep.txt")).toBe("durable");
    expect(fakeHolders(runner)[0]?.argv).toContain("--unshare-net");
  });

  test("an allow-list is recorded in its canonical form and applied again on resume", async () => {
    const { storagePath } = await makeRelease();
    const artifact = await environment().prepare(prepareContext(storagePath));
    const before = await environment().start(
      sessionContext(storagePath, "s"),
      { networkPolicy: { allow: { "API.example.com": [] }, subnets: { deny: ["10.0.0.1"] } } },
      artifact,
    );
    expect(before.state.networkPolicy).toEqual({
      allow: ["api.example.com"],
      subnets: { deny: ["10.0.0.1/32"] },
    });
    expect(JSON.parse(JSON.stringify(before.state))).toEqual(before.state);
    await before.connection.stop();

    const { runner } = createLiveRunner();
    const resumed = await environment(undefined, runner).resume(
      sessionContext(storagePath, "s"),
      artifact,
      before.state,
    );
    await resumed.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    const holder = fakeHolders(runner)[0]!;
    expect(holder.argv).toContain("--unshare-net");
    expect(holder.captures).toHaveLength(1);
    await resumed.stop();
  });

  /**
   * A rule's header value is a credential, and eve persists the state `start`
   * returns. The state therefore names the domains that had rules and nothing
   * of what the rules held; a later sandbox gets them back from the
   * environment, which is code and has them again in every process.
   */
  describe("a policy with rules", () => {
    const token = "Bearer ghp_real-token";
    const rules = (authorization = token) => ({
      allow: {
        "*": [],
        "github.com": [{ transform: [{ headers: { authorization } }] }],
      },
    });
    /** Whether the last command was told to trust the sandbox's authority, as one under rules is. */
    const underRules = (calls: readonly (readonly string[])[]) =>
      parseJoin(calls.at(-1)!).env.GIT_SSL_CAINFO === SANDBOX_TRUST_ENV.GIT_SSL_CAINFO;
    const run = async (connection: BwrapSandboxConnection) =>
      await connection.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });

    test("is recorded without what its rules hold", async () => {
      const { storagePath } = await makeRelease();
      const live = createLiveRunner();
      const env = environment({ networkPolicy: rules() }, live.runner);
      const artifact = await env.prepare(prepareContext(storagePath));
      const { connection, state } = await env.start(
        sessionContext(storagePath, "s"),
        undefined,
        artifact,
      );
      await run(connection);

      expect(state.networkPolicy).toEqual({ allow: ["*", "github.com"], rules: ["github.com"] });
      expect(state.environmentPolicy).toBe(true);
      expect(JSON.stringify(state)).not.toContain("ghp_real-token");
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      expect(underRules(live.calls)).toBe(true);
      await connection.stop();
    });

    test("comes back with its rules when the environment it was opened under still has them", async () => {
      const { storagePath } = await makeRelease();
      const first = environment({ networkPolicy: rules() });
      const artifact = await first.prepare(prepareContext(storagePath));
      const before = await first.start(sessionContext(storagePath, "s"), undefined, artifact);
      await before.connection.stop();

      // A new process, after a deploy that rotated the credential.
      const live = createLiveRunner();
      const resumed = await environment(
        { networkPolicy: rules("Bearer rotated") },
        live.runner,
      ).resume(sessionContext(storagePath, "s"), artifact, before.state);
      await run(resumed);

      expect(underRules(live.calls)).toBe(true);
      await resumed.stop();
    });

    test("passed to open() lasts for the sandbox it opened, and is allowed without rules after", async () => {
      const { storagePath } = await makeRelease();
      const first = environment({ networkPolicy: rules("Bearer shared") });
      const artifact = await first.prepare(prepareContext(storagePath));
      const before = await first.start(
        sessionContext(storagePath, "s"),
        { networkPolicy: rules("Bearer this-user-only") },
        artifact,
      );
      expect(before.state.environmentPolicy).toBeUndefined();
      expect(JSON.stringify(before.state)).not.toContain("this-user-only");
      await before.connection.stop();

      // The environment has rules for the same domain, with another
      // credential. They are not this session's and are not lent to it.
      const live = createLiveRunner();
      const resumed = await environment(
        { networkPolicy: rules("Bearer shared") },
        live.runner,
      ).resume(sessionContext(storagePath, "s"), artifact, before.state);
      await run(resumed);

      expect(underRules(live.calls)).toBe(false);
      // Still the same allow-list: its own network, handed to the gateway.
      const holder = fakeHolders(live.runner)[0]!;
      expect(holder.argv).toContain("--unshare-net");
      expect(holder.captures).toHaveLength(1);
      await resumed.stop();
    });

    test("is not restored from an environment whose policy has changed since", async () => {
      const { storagePath } = await makeRelease();
      const first = environment({ networkPolicy: rules() });
      const artifact = await first.prepare(prepareContext(storagePath));
      const before = await first.start(sessionContext(storagePath, "s"), undefined, artifact);
      await before.connection.stop();

      const live = createLiveRunner();
      const changed = {
        allow: { ...rules().allow, "api.github.com": rules().allow["github.com"] },
      };
      const resumed = await environment({ networkPolicy: changed }, live.runner).resume(
        sessionContext(storagePath, "s"),
        artifact,
        before.state,
      );
      await run(resumed);

      expect(underRules(live.calls)).toBe(false);
      await resumed.stop();
    });

    test("state that names rules for a domain it does not allow is not state this provider wrote", async () => {
      const { storagePath } = await makeRelease();
      const env = environment();
      const artifact = await env.prepare(prepareContext(storagePath));
      const { connection, state } = await env.start(
        sessionContext(storagePath, "s"),
        undefined,
        artifact,
      );
      await connection.stop();

      await expect(
        env.resume(sessionContext(storagePath, "s"), artifact, {
          ...state,
          networkPolicy: { allow: ["a.test"], rules: ["b.test"] },
        }),
      ).rejects.toThrow(/invalid session state/);
    });
  });

  test("a policy that cannot be enforced fails the open before a workspace is created", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));

    await expect(
      env.start(
        sessionContext(storagePath, "s"),
        { networkPolicy: { allow: { "github.com": [{ forwardURL: "https://x.test" }] } } as never },
        artifact,
      ),
    ).rejects.toThrow(/forwardURL/);
    expect(existsSync(sessionPathIn(path.join(storagePath, "bwrap"), "session:s"))).toBe(false);
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
    await started.connection.writeFiles({
      files: [{ path: "/workspace/keep.txt", content: encoder.encode("moved") }],
    });
    await started.connection.stop();
    await rm(release.appRoot, { force: true, recursive: true });

    const next = await makeRelease();
    const nextEnv = environment({ cacheDir });
    const nextArtifact = await nextEnv.prepare(
      prepareContext(next.storagePath, { revision: "r2" }),
    );
    const resumed = await nextEnv.resume(
      sessionContext(next.storagePath, "session-1"),
      nextArtifact,
      started.state,
    );

    expect(await readText(resumed, "/workspace/keep.txt")).toBe("moved");
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
    await expect(
      env.onSessionEnd(sessionContext(storagePath, "s"), { version: 2 } as never, {
        reason: "completed",
      }),
    ).rejects.toThrow(/invalid session state/);
  });

  test("session end releases the workspace from recorded state without resuming it", async () => {
    const { appRoot, storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { state } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    const spawnedBeforeEnd = calls.length;

    // A fresh definition stands in for the process that runs the cleanup step
    // after a restart: it never opened this session's sandbox.
    await environment(undefined, runner).onSessionEnd(sessionContext(storagePath, "s"), state, {
      reason: "completed",
    });

    expect(calls.length).toBe(spawnedBeforeEnd);
    expect((await listBwrapCache({ appRoot })).map((entry) => entry.kind)).toEqual(["template"]);
    await expect(readdir(path.join(storagePath, "bwrap", "sessions"))).resolves.toEqual([]);
  });

  test("session end stops the live generation in this process, and a later start is fresh", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });
    await connection.writeFiles({
      files: [{ path: "/workspace/keep.txt", content: encoder.encode("old") }],
    });

    await env.onSessionEnd(sessionContext(storagePath, "s"), state, { reason: "expired" });
    await env.onSessionEnd(sessionContext(storagePath, "s"), state, { reason: "failed" });

    expect(killed).toEqual([1]);
    const fresh = await env.start(sessionContext(storagePath, "s"), undefined, artifact);
    expect(await readText(fresh.connection, "/workspace/keep.txt")).toBeNull();
  });
});

describe("session idle", () => {
  /**
   * eve calls `onSessionIdle` once a session has been idle for the
   * environment's `idleTimeoutMs`. The sandbox's compute is its holder, so
   * this is what ends a process a command left running in the background.
   */
  test("stops the sandbox's processes and keeps its files; the next resume starts a new holder", async () => {
    const { appRoot, storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath, { workspace: { f: "x" } }));
    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });

    await env.onSessionIdle(sessionContext(storagePath, "s"), state, {});

    expect(killed).toEqual([1]);
    expect(fakeHolders(runner).map((holder) => holder.killed)).toEqual([true]);
    expect(await listBwrapCache({ appRoot })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "session", active: false })]),
    );

    const resumed = await env.resume(sessionContext(storagePath, "s"), artifact, state);
    expect(await readText(resumed, "/workspace/f")).toBe("x");
    await resumed.spawn({ command: "true", env: {}, workingDirectory: "/workspace" });
    expect(fakeHolders(runner)).toHaveLength(2);
  });

  test("starts nothing for a sandbox that is not running, with or without recorded state", async () => {
    const { storagePath } = await makeRelease();
    const { runner, calls } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await connection.stop();

    await env.onSessionIdle(sessionContext(storagePath, "s"), state, {});
    await env.onSessionIdle(sessionContext(storagePath, "s"), null, {});
    await env.onSessionIdle(sessionContext(storagePath, "never-started"), null, {});

    expect(calls).toHaveLength(0);
    expect(fakeHolders(runner)).toHaveLength(0);
    const workspace = sessionPathIn(path.join(storagePath, "bwrap"), "session:s");
    expect(existsSync(workspace)).toBe(true);
  });

  test("an already-aborted signal leaves the sandbox running", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });

    await expect(
      env.onSessionIdle(sessionContext(storagePath, "s"), state, {
        signal: AbortSignal.abort(new Error("eve moved on")),
      }),
    ).rejects.toThrow("eve moved on");

    expect(killed).toEqual([]);
    expect(fakeHolders(runner).map((holder) => holder.killed)).toEqual([false]);
  });
});

describe("values a later eve minor may add", () => {
  test("a session kind and an end reason this provider does not know are handled", async () => {
    const { storagePath } = await makeRelease();
    const env = environment();
    const artifact = await env.prepare(prepareContext(storagePath));
    const ctx = { kind: "a-kind-eve-adds-later", session: { id: "s" }, storagePath };

    const { state } = await env.start(ctx, undefined, artifact);
    await env.onSessionEnd(ctx, state, { reason: "a-reason-eve-adds-later" });

    await expect(env.resume(ctx, artifact, state)).rejects.toMatchObject({
      name: "SandboxSessionGoneError",
    });
  });
});

describe("session end signal", () => {
  test("an already-aborted signal stops session end before it touches the workspace", async () => {
    const { storagePath } = await makeRelease();
    const { runner, killed } = createLiveRunner();
    const env = environment(undefined, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection, state } = await env.start(
      sessionContext(storagePath, "s"),
      undefined,
      artifact,
    );
    await connection.spawn({ command: "sleep 60", env: {}, workingDirectory: "/workspace" });
    const workspace = sessionPathIn(path.join(storagePath, "bwrap"), "session:s");

    await expect(
      env.onSessionEnd(sessionContext(storagePath, "s"), state, {
        reason: "deleted",
        signal: AbortSignal.abort(new Error("caller gave up")),
      }),
    ).rejects.toThrow("caller gave up");

    expect(killed).toEqual([]);
    expect(existsSync(workspace)).toBe(true);
    await env.onSessionEnd(sessionContext(storagePath, "s"), state, { reason: "deleted" });
    expect(existsSync(workspace)).toBe(false);
  });
});

describe("definition", () => {
  test("names the provider bwrap at state protocol 1", () => {
    const definition = createBwrapSandboxProviderDefinition();

    expect(definition.name).toBe("bwrap");
    expect(definition.stateProtocolVersion).toBe(BWRAP_PROVIDER_STATE_PROTOCOL_VERSION);
    expect(BWRAP_PROVIDER_STATE_PROTOCOL_VERSION).toBe(1);
  });

  test("the prepared template is readable from the artifact path eve records", async () => {
    const { storagePath } = await makeRelease();
    const artifact = await environment().prepare(
      prepareContext(storagePath, { workspace: { "a.txt": "a" } }),
    );

    expect(await readFile(path.join(artifact.templatePath, "a.txt"), "utf8")).toBe("a");
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

  test("forwards eve's abort signal to the process", async () => {
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
    const caller = new AbortController();

    await connection.spawn({
      command: "a",
      env: {},
      workingDirectory: "/workspace",
      signal: caller.signal,
    });
    caller.abort(new Error("caller gave up"));

    // The runner sees the caller's signal combined with the command's limits.
    expect((signals[0]?.reason as Error | undefined)?.message).toBe("caller gave up");
  });

  test("bounds every spawned command by runTimeoutMs and maxOutputBytes", async () => {
    const { storagePath } = await makeRelease();
    const signals: AbortSignal[] = [];
    const runner: ProcessRunner = {
      spawn(_argv, options) {
        const signal = options!.abortSignal!;
        signals.push(signal);
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("0123456789"));
              signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          stderr: empty(),
          wait: async () =>
            await new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            ),
          kill: async () => {},
        };
      },
    };
    const env = environment({ runTimeoutMs: 50, maxOutputBytes: 4 }, runner);
    const artifact = await env.prepare(prepareContext(storagePath));
    const { connection } = await env.start(sessionContext(storagePath, "s"), undefined, artifact);

    const chatty = await connection.spawn({ command: "yes", env: {}, workingDirectory: "/" });
    const [stdout, chattyExit] = await Promise.all([
      readUntilSettled(chatty.stdout),
      chatty.wait().catch((error: Error) => error.message),
    ]);
    expect(stdout).toEqual({
      text: "0123",
      error: "bwrap sandbox: command output exceeded 4 bytes",
    });
    expect(chattyExit).toBe("bwrap sandbox: command output exceeded 4 bytes");

    const env2 = environment({ runTimeoutMs: 50, maxOutputBytes: null }, runner);
    const { connection: quiet } = await env2.start(
      sessionContext(storagePath, "s2"),
      undefined,
      artifact,
    );
    const sleeper = await quiet.spawn({ command: "sleep 60", env: {}, workingDirectory: "/" });
    await expect(sleeper.wait()).rejects.toThrow("bwrap sandbox: command timed out after 50 ms");
  });

  /**
   * eve checks for `stdin` only after the provider returned the process,
   * then kills it and fails the call -- so a provider that ignored the request
   * would already have started the command once.
   */
  test("honors eve's stdin request with the process's writable stdin", async () => {
    const { storagePath } = await makeRelease();
    const requested: (boolean | undefined)[] = [];
    const stdin = new WritableStream<Uint8Array>();
    const runner: ProcessRunner = {
      spawn(_argv, options) {
        requested.push(options?.stdin);
        return {
          ...(options?.stdin === true ? { stdin } : {}),
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

    const piped = await connection.spawn({
      command: "cat",
      env: {},
      workingDirectory: "/workspace",
      stdin: true,
    });
    const plain = await connection.spawn({ command: "cat", env: {}, workingDirectory: "/" });

    expect(requested).toEqual([true, undefined]);
    expect(piped.stdin).toBe(stdin);
    expect(plain.stdin).toBeUndefined();
  });
});
