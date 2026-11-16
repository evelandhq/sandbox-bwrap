// Real-bwrap contract test for the provider and its connection. Requires
// Linux + bubblewrap + bash: run it inside the Lima VM via infra/smoke.sh, or
// in CI's smoke job, not on a dev laptop. infra/smoke.sh runs it as an
// unprivileged user under systemd hardening (NoNewPrivileges,
// ProtectSystem=strict) to mirror a deployed eve agent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EVE_SANDBOX_HOME_PROBE } from "../connection.js";
import { isBwrapAvailable } from "../process.js";
import type { BwrapSandboxConnection } from "../provider-contract.js";
import {
  createBwrapSandboxProviderDefinition,
  type BwrapPreparedArtifact,
} from "../provider-definition.js";

const SECRET = "smoke-secret-do-not-leak";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function countBwrapZombies(): Promise<number> {
  if (process.platform !== "linux") return 0;
  const procEntries = await readdir("/proc");
  let zombies = 0;
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const [comm, stat] = await Promise.all([
        readFile(`/proc/${entry}/comm`, "utf8"),
        readFile(`/proc/${entry}/stat`, "utf8"),
      ]);
      if (comm.trim() === "bwrap" && stat.at(stat.lastIndexOf(")") + 2) === "Z") zombies += 1;
    } catch {
      // The process can disappear between readdir and readFile.
    }
  }
  return zombies;
}

/** Host pids whose command line contains `marker`, seen from outside every sandbox. */
async function hostProcessesMatching(marker: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.split("\0").includes(marker)) pids.push(Number(entry));
    } catch {
      // The process can disappear between readdir and readFile.
    }
  }
  return pids;
}

const IFACE_COMMAND = `node -e "console.log(Object.keys(require('node:os').networkInterfaces()).join(' '))"`;

function nonLoopbackInterfaces(stdout: string): string[] {
  return stdout
    .trim()
    .split(/\s+/)
    .filter((name) => name !== "" && name !== "lo");
}

async function runOver(
  connection: BwrapSandboxConnection,
  command: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = await connection.spawn({ command, env: {}, workingDirectory: "/workspace" });
  const [stdout, { exitCode }] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.wait(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout };
}

/**
 * The provider's lifecycle over the real binary. eve's own
 * `populate` is stood in for by the calls it makes -- the `$HOME` probe, file
 * seeding, and an authored command -- so what this proves is the connection:
 * commands run in bwrap, deny-all holds, a restarted process resumes the same
 * workspace, and a session that never recorded state still ends by key.
 */
async function connectionProviderSmoke(appRoot: string): Promise<void> {
  const storagePath = path.join(appRoot, "connection-release", ".eve", "sandbox-cache");
  const cacheDir = path.join(appRoot, "connection-sessions");
  const environment = createBwrapSandboxProviderDefinition().environment({ cacheDir });
  const artifact = await environment.prepare({
    storagePath,
    log: () => {},
    templateKey: (identity) => `connection-smoke:${JSON.stringify(identity)}`,
    async populate(connection) {
      const home = await runOver(connection, EVE_SANDBOX_HOME_PROBE);
      assert.equal(home.stdout, "/workspace\n", "the template must report the sandbox HOME");
      await connection.writeFiles({
        files: [
          { path: "/workspace/seeded.txt", content: new TextEncoder().encode("connection-seed") },
        ],
      });
      const prepared = await runOver(connection, "printf prepared-in-bwrap > prepared.txt");
      assert.equal(prepared.exitCode, 0, "authored preparation must run in bwrap");
    },
  });
  const ctx = {
    kind: "session" as const,
    session: { id: "connection-session-1" },
    storagePath,
  };

  const { connection, state } = await environment.start(
    ctx,
    { networkPolicy: "deny-all" },
    artifact,
  );
  const prepared = await runOver(connection, "cat prepared.txt seeded.txt");
  assert.equal(prepared.stdout, "prepared-in-bwrapconnection-seed");
  const denied = await runOver(connection, IFACE_COMMAND);
  assert.equal(nonLoopbackInterfaces(denied.stdout).length, 0, "open-time deny-all must hold");
  await assert.rejects(connection.readFile({ path: "/workspace" }), /directory/);

  // spawn({ stdin: true }): the bytes must cross bwrap into the
  // sandboxed command, and closing the stream must reach it as EOF -- `cat`
  // only exits once it does.
  const piped = await connection.spawn({
    command: "cat; printf ':eof'",
    env: {},
    workingDirectory: "/workspace",
    stdin: true,
  });
  assert.ok(piped.stdin !== undefined, "a stdin request must return a stdin stream");
  const stdinWriter = piped.stdin.getWriter();
  await stdinWriter.write(new TextEncoder().encode("piped-through-bwrap"));
  await stdinWriter.close();
  const [pipedOut, pipedExit] = await Promise.all([
    new Response(piped.stdout).text(),
    piped.wait(),
    new Response(piped.stderr).text(),
  ]);
  assert.equal(pipedOut, "piped-through-bwrap:eof", "stdin must reach the sandboxed command");
  assert.equal(pipedExit.exitCode, 0);
  const unpiped = await runOver(connection, "cat; printf ':eof'");
  assert.equal(unpiped.stdout, ":eof", "without a stdin request the command reads EOF at once");

  const sleeper = await connection.spawn({
    command: "sleep 300",
    env: {},
    workingDirectory: "/workspace",
  });
  // eve closes the connection at the end of every step; the process lives on.
  await connection.close();
  assert.ok(sleeper.pid !== undefined && processIsAlive(sleeper.pid), "close must not kill");
  await connection.stop();
  assert.equal(processIsAlive(sleeper.pid), false, "stop must kill spawned processes");

  const restarted = createBwrapSandboxProviderDefinition().environment({ cacheDir });
  const resumed = await restarted.resume(ctx, artifact, state);
  const reread = await runOver(resumed, "cat seeded.txt");
  assert.equal(reread.stdout, "connection-seed");
  const stillDenied = await runOver(resumed, IFACE_COMMAND);
  assert.equal(nonLoopbackInterfaces(stillDenied.stdout).length, 0);

  await boundedConnectionSmoke(storagePath, cacheDir, artifact);

  await restarted.onSessionEnd(ctx, null, { reason: "deleted" });
  await assert.rejects(
    restarted.resume(ctx, artifact, state),
    (error: unknown) => error instanceof Error && error.name === "SandboxSessionGoneError",
  );
  console.log(
    "CONNECTION SMOKE: prepare, start, stdin, close, stop, restart + resume, and end by key held under real bwrap",
  );
}

/**
 * eve builds `sandbox.run()` and the bash tool from `connection.spawn`, so
 * the run limits must hold there: a command past `runTimeoutMs` is killed with
 * every process it started, and output past `maxOutputBytes` is cut at the
 * limit and fails the command. `eveRun` reads a command the way eve's `run()`
 * does.
 */
async function boundedConnectionSmoke(
  storagePath: string,
  cacheDir: string,
  artifact: BwrapPreparedArtifact,
): Promise<void> {
  const environment = createBwrapSandboxProviderDefinition().environment({
    cacheDir,
    runTimeoutMs: 1_000,
    maxOutputBytes: 1024,
  });
  const ctx = { kind: "session" as const, session: { id: "connection-bounded" }, storagePath };
  const { connection } = await environment.start(ctx, undefined, artifact);
  const spawn = (command: string) =>
    connection.spawn({ command, env: {}, workingDirectory: "/workspace" });
  const eveRun = async (command: string) => {
    const proc = await spawn(command);
    const [stdout, stderr, { exitCode }] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.wait(),
    ]);
    return { exitCode, stdout: Buffer.from(stdout).toString(), stderr: Buffer.from(stderr) };
  };

  const marker = "301.5";
  const started = Date.now();
  await assert.rejects(
    eveRun(`sleep ${marker} & (sleep ${marker} & wait) & wait`),
    /command timed out after 1000 ms/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `timeout must fire near 1000 ms, took ${elapsed} ms`);
  await sleep(200);
  assert.deepEqual(
    await hostProcessesMatching(marker),
    [],
    "a timed-out command must take its background descendants with it",
  );

  const chatty = await spawn("head -c 65536 /dev/zero; sleep 300");
  const delivered: Uint8Array[] = [];
  const reader = chatty.stdout.getReader();
  await assert.rejects(
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        delivered.push(value);
      }
    })(),
    /command output exceeded 1024 bytes/,
  );
  assert.equal(Buffer.concat(delivered).byteLength, 1024, "output must be cut at the limit");
  await assert.rejects(chatty.wait(), /command output exceeded 1024 bytes/);
  await assert.rejects(eveRun("head -c 2048 /dev/zero"), /command output exceeded 1024 bytes/);

  const fine = await eveRun("head -c 1000 /dev/zero | wc -c");
  assert.equal(fine.stdout.trim(), "1000", "a command within both limits runs normally");
  await connection.stop();
  await environment.onSessionEnd(ctx, null, { reason: "deleted" });
  console.log(
    "BOUNDED SPAWN SMOKE: timeout and output limit held on connection.spawn under real bwrap",
  );
}

/**
 * What the sandbox itself guarantees, probed from inside a command: the
 * workspace and cwd, a read-only host root, no host environment, hidden cache
 * roots, a private PID table, the network switch, executable bits across the
 * template clone, durable files across stop and restart, isolation and
 * deletion between sessions, and no zombie build-up under command churn.
 */
async function boundarySmoke(appRoot: string, hostFilePath: string): Promise<void> {
  const storagePath = path.join(appRoot, "boundary-release", ".eve", "sandbox-cache");
  const environment = createBwrapSandboxProviderDefinition().environment();
  const artifact = await environment.prepare({
    storagePath,
    log: () => {},
    templateKey: () => "boundary-smoke",
    async populate(connection) {
      await connection.writeFiles({
        files: [{ path: "/workspace/seeded.txt", content: new TextEncoder().encode("from-seed") }],
      });
      // Fixture for the EXECUTABLE BIT probe below: an executable script
      // authored inside the template, whose mode bit must survive the
      // template->session clone.
      const chmod = await runOver(
        connection,
        "printf '#!/bin/sh\\necho exec-ok\\n' > run-me.sh && chmod +x run-me.sh",
      );
      assert.equal(chmod.exitCode, 0, "chmod +x failed in the template");
    },
  });
  const ctx = (id: string) => ({ kind: "session" as const, session: { id }, storagePath });
  const { connection } = await environment.start(ctx("boundary-1"), undefined, artifact);

  const exec = await runOver(connection, "./run-me.sh");
  assert.equal(exec.exitCode, 0, "executable bit lost across the template->session clone");
  assert.equal(exec.stdout.trim(), "exec-ok");

  assert.equal((await runOver(connection, "pwd")).stdout.trim(), "/workspace");
  assert.notEqual(
    (await runOver(connection, "touch /usr/smoke-marker")).exitCode,
    0,
    "writing outside /workspace must fail",
  );
  const env = await runOver(connection, "env");
  assert.ok(!env.stdout.includes(SECRET), "host process env leaked into the sandbox");
  assert.ok(env.stdout.includes("HOME=/workspace"), "sandbox HOME must be /workspace");
  assert.ok(env.stdout.includes("AI_AGENT=eve"), "eve's SANDBOX_AGENT_ENV must reach commands");
  const cacheLs = await runOver(connection, `ls -A ${path.join(storagePath, "bwrap")}`);
  assert.equal(cacheLs.stdout.trim(), "", "the sandbox cache root must be hidden by tmpfs");

  // PID NAMESPACE probe: --unshare-pid must give the sandbox its own private
  // process table. A runner test double cannot fake a kernel namespace.
  const procCount = await runOver(connection, "ls /proc | grep -Ec '^[0-9]+$'");
  const sandboxPidCount = Number.parseInt(procCount.stdout.trim(), 10);
  assert.ok(
    Number.isInteger(sandboxPidCount) && sandboxPidCount > 0 && sandboxPidCount <= 5,
    `PID namespace isolation failed: /proc showed ${procCount.stdout.trim()} entries`,
  );

  // network: allow-all sees a non-loopback interface; deny-all does not.
  // /sys/class/net shows the namespace that mounted sysfs, so ask the kernel
  // via netlink (os.networkInterfaces) instead.
  const allowNet = await runOver(connection, IFACE_COMMAND);
  assert.ok(
    nonLoopbackInterfaces(allowNet.stdout).length > 0,
    "allow-all must see the host network",
  );
  await connection.extensions.setNetworkPolicy("deny-all");
  const denyNet = await runOver(connection, IFACE_COMMAND);
  assert.equal(
    nonLoopbackInterfaces(denyNet.stdout).length,
    0,
    "deny-all must leave only loopback",
  );
  await connection.extensions.setNetworkPolicy("allow-all");

  // Sustained short-command churn must not grow the host process table.
  const zombiesBefore = await countBwrapZombies();
  for (let index = 0; index < 500; index += 1) {
    const short = await runOver(connection, "true");
    assert.equal(short.exitCode, 0, `short command ${index} failed`);
  }
  await sleep(200);
  assert.equal(
    await countBwrapZombies(),
    zombiesBefore,
    "500 short commands must not leak zombies",
  );

  // HARD LINK probe: a hard link aliases an inode across the bind mount, which
  // realpath-based containment cannot see. The verdict is reported, not
  // asserted: it is a fact about the boundary for the operator to evaluate.
  const link = await runOver(
    connection,
    `ln '${hostFilePath}' /workspace/linked.txt 2>&1; echo rc=$?`,
  );
  const linkSucceeded = link.stdout.trim().endsWith("rc=0");
  if (linkSucceeded) await runOver(connection, "printf pwned > /workspace/linked.txt");
  const hostFileAfter = await readFile(hostFilePath, "utf8").catch(
    (error: unknown) => `<unreadable: ${String(error)}>`,
  );
  console.log(
    `HARDLINK PROBE: ${linkSucceeded ? "succeeded" : "refused"} host-file-after=${JSON.stringify(hostFileAfter)}`,
  );

  // kill() terminates the sandboxed tree promptly.
  const proc = await connection.spawn({
    command: "sleep 300",
    env: {},
    workingDirectory: "/workspace",
  });
  await sleep(200);
  await proc.kill();
  const settled = await Promise.race([
    Promise.resolve(proc.wait()).then(
      () => "settled",
      () => "settled",
    ),
    sleep(5000).then(() => "timeout"),
  ]);
  assert.equal(settled, "settled", "a killed process must settle wait() promptly");

  // Files persist across stop and a fresh generation; sessions are isolated;
  // ending one session removes its workspace and nothing else.
  await connection.writeFiles({
    files: [{ path: "/workspace/notes/hello.txt", content: new TextEncoder().encode("persisted") }],
  });
  await connection.stop();
  const again = await environment.start(ctx("boundary-1"), undefined, artifact);
  assert.equal((await runOver(again.connection, "cat notes/hello.txt")).stdout, "persisted");
  const other = await environment.start(ctx("boundary-2"), undefined, artifact);
  assert.notEqual((await runOver(other.connection, "cat notes/hello.txt")).exitCode, 0);
  const doomed = await other.connection.spawn({
    command: "sleep 300",
    env: {},
    workingDirectory: "/workspace",
  });
  await environment.onSessionEnd(ctx("boundary-2"), other.state, { reason: "deleted" });
  assert.ok(doomed.pid !== undefined);
  assert.equal(processIsAlive(doomed.pid), false, "ending a session must kill its processes");
  assert.equal((await runOver(again.connection, "cat notes/hello.txt")).stdout, "persisted");
  const recreated = await environment.start(ctx("boundary-2"), undefined, artifact);
  assert.equal((await runOver(recreated.connection, "cat seeded.txt")).stdout, "from-seed");
  await recreated.connection.stop();
  await again.connection.stop();
  console.log(
    "BOUNDARY SMOKE: workspace, filesystem, environment, PID, network, and lifecycle held under real bwrap",
  );
}

async function main(): Promise<void> {
  assert.equal(isBwrapAvailable(), true, "bwrap must be installed");
  process.env.SMOKE_SECRET = SECRET;

  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-smoke-"));
  try {
    // Fixture for the HARD LINK probe, outside every cache root, so it stays
    // visible read-only through the sandbox's root bind.
    const hostFilePath = path.join(appRoot, "hostfile.txt");
    await writeFile(hostFilePath, "host-original");

    await boundarySmoke(appRoot, hostFilePath);
    await connectionProviderSmoke(appRoot);

    console.log("BWRAP SMOKE OK");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
