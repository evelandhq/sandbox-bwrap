// Real-bwrap contract test for the provider and its connection. Requires
// Linux 5.8+ + bubblewrap + python3 + bash: run it inside the Lima VM via infra/smoke.sh, or
// in CI's smoke job, not on a dev laptop. infra/smoke.sh runs it as an
// unprivileged user under systemd hardening (NoNewPrivileges,
// ProtectSystem=strict) to mirror a deployed eve agent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CAPTURE_READY_MARKER } from "../capture.js";
import { EVE_SANDBOX_HOME_PROBE } from "../connection.js";
import type { BwrapSandboxEvent } from "../events.js";
import { isBwrapAvailable, isPythonAvailable } from "../process.js";
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

/** Zombies of the two binaries the provider launches: the holder and each command's join helper. */
async function countSandboxZombies(): Promise<number> {
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
      const launched = comm.trim() === "bwrap" || comm.trim().startsWith("python3");
      if (launched && stat.at(stat.lastIndexOf(")") + 2) === "Z") zombies += 1;
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

/** Host pids of capture helpers, which carry their marker inside the script they were given. */
async function captureHelpers(): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes(CAPTURE_READY_MARKER)) pids.push(Number(entry));
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
 * What commands share once they join one holder, which no runner test double
 * can show: `/tmp` and the process table carry from one command to the next,
 * a process may outlive the command that started it, and it ends when the
 * sandbox does -- on stop, on idle, on a network policy change, or when the
 * holder itself is killed.
 */
async function sharedSandboxSmoke(appRoot: string): Promise<void> {
  const storagePath = path.join(appRoot, "shared-release", ".eve", "sandbox-cache");
  const environment = createBwrapSandboxProviderDefinition().environment({ runTimeoutMs: 20_000 });
  const artifact = await environment.prepare({
    storagePath,
    log: () => {},
    templateKey: () => "shared-smoke",
    async populate() {},
  });
  const ctx = { kind: "session" as const, session: { id: "shared-1" }, storagePath };
  const { connection, state } = await environment.start(ctx, undefined, artifact);

  // /tmp belongs to the sandbox, not to one command.
  await runOver(connection, "echo carried > /tmp/note");
  assert.equal((await runOver(connection, "cat /tmp/note")).stdout, "carried\n");

  // A process in its own session outlives the command that started it, and a
  // later command can see it, signal it, and read what it wrote.
  const marker = "302.25";
  const launched = await runOver(
    connection,
    `setsid sh -c 'echo $$ > /tmp/bg.pid; exec sleep ${marker}' > /tmp/bg.out 2>&1 < /dev/null & ` +
      "while [ ! -s /tmp/bg.pid ]; do sleep 0.05; done; cat /tmp/bg.pid",
  );
  assert.equal(launched.exitCode, 0);
  const backgroundPid = launched.stdout.trim();
  assert.match(backgroundPid, /^\d+$/);
  assert.equal(
    (await runOver(connection, `kill -0 ${backgroundPid} && echo alive`)).stdout,
    "alive\n",
    "a background process must outlive the command that started it",
  );
  assert.equal((await hostProcessesMatching(marker)).length, 1);

  // eve's bash tool hands a long command off as a background job this way: a
  // launcher waits on the job, and a second command signals the launcher by
  // pid to let go of it. That needs both the shared /tmp and the shared
  // process table.
  const handoffMarker = "303.75";
  const launcher = await connection.spawn({
    command: [
      "mkdir -p /tmp/job",
      "trap 'exit 0' USR1",
      'echo "$$" > /tmp/job/launcher',
      "set -m",
      `(sleep ${handoffMarker}; echo "$?" > /tmp/job/exit) < /dev/null > /tmp/job/stdout 2>&1 &`,
      "pid=$!",
      "set +m",
      'echo "$pid" > /tmp/job/pid',
      'wait "$pid"',
    ].join("\n"),
    env: {},
    workingDirectory: "/workspace",
  });
  const claimed = await runOver(
    connection,
    "while [ ! -s /tmp/job/pid ]; do sleep 0.05; done; " +
      'kill -USR1 "$(cat /tmp/job/launcher)" && cat /tmp/job/pid',
  );
  assert.equal(claimed.exitCode, 0, "a later command must be able to signal an earlier one");
  const handedOff = await Promise.race([
    launcher.wait().then(({ exitCode }) => exitCode),
    sleep(5_000).then(() => "timeout" as const),
  ]);
  assert.equal(handedOff, 0, "the launcher must let go of its job when signalled");
  assert.equal(
    (await runOver(connection, `kill -0 -- -${claimed.stdout.trim()} && echo running`)).stdout,
    "running\n",
    "the handed-off job must keep running as its own process group",
  );
  assert.equal((await hostProcessesMatching(handoffMarker)).length, 1);

  // Idle: the sandbox's processes end, its files stay, and nothing restarts.
  await connection.writeFiles({
    files: [{ path: "/workspace/kept.txt", content: new TextEncoder().encode("kept") }],
  });
  await environment.onSessionIdle(ctx, state, {});
  await sleep(200);
  assert.deepEqual(await hostProcessesMatching(marker), [], "idle must end background processes");
  assert.deepEqual(await hostProcessesMatching(handoffMarker), []);
  await environment.onSessionIdle(ctx, state, {});

  // A resumed sandbox is a new one over the same workspace: fresh /tmp, same files.
  const resumed = await environment.resume(ctx, artifact, state);
  assert.equal((await runOver(resumed, "cat kept.txt")).stdout, "kept");
  assert.notEqual(
    (await runOver(resumed, "cat /tmp/note")).exitCode,
    0,
    "a new holder must start from an empty /tmp",
  );

  // Changing the network policy ends what the old one left running, so a
  // process started with the network cannot keep it after deny-all.
  const networked = "304.5";
  await runOver(resumed, `setsid sleep ${networked} > /dev/null 2>&1 < /dev/null &`);
  assert.equal((await hostProcessesMatching(networked)).length, 1);
  await resumed.extensions.setNetworkPolicy("deny-all");
  await sleep(200);
  assert.deepEqual(
    await hostProcessesMatching(networked),
    [],
    "deny-all must end processes started while the network was allowed",
  );
  const denied = await runOver(resumed, IFACE_COMMAND);
  assert.equal(nonLoopbackInterfaces(denied.stdout).length, 0, "deny-all must hold after a switch");
  await runOver(resumed, "echo isolated > /tmp/denied-note");
  assert.equal((await runOver(resumed, "cat /tmp/denied-note")).stdout, "isolated\n");
  await resumed.extensions.setNetworkPolicy("allow-all");
  assert.ok(nonLoopbackInterfaces((await runOver(resumed, IFACE_COMMAND)).stdout).length > 0);

  // A sandboxed command can kill the holder shell. That ends the sandbox's
  // processes, the killer included; the next command gets a fresh holder.
  const stray = "305.125";
  await runOver(resumed, `setsid sleep ${stray} > /dev/null 2>&1 < /dev/null &`);
  const suicide = await runOver(resumed, "kill -9 2; sleep 30");
  assert.notEqual(suicide.exitCode, 0, "killing the holder must end the command that did it");
  await sleep(200);
  assert.deepEqual(await hostProcessesMatching(stray), [], "a dead holder takes its sandbox along");
  assert.equal(
    (await runOver(resumed, "echo back")).stdout,
    "back\n",
    "the next command must start a new holder",
  );

  // stop() ends background processes too, not only commands still awaited.
  const stopped = "306.5";
  await runOver(resumed, `setsid sleep ${stopped} > /dev/null 2>&1 < /dev/null &`);
  assert.equal((await hostProcessesMatching(stopped)).length, 1);
  await resumed.stop();
  await sleep(200);
  assert.deepEqual(await hostProcessesMatching(stopped), [], "stop must end background processes");

  await environment.onSessionEnd(ctx, state, { reason: "deleted" });

  // An idle sandbox must not keep its host alive. This one is left running on
  // purpose: if its holder held the event loop, this process would never exit
  // and the run would hang instead of printing its result and returning.
  const lingering = { kind: "session" as const, session: { id: "shared-lingering" }, storagePath };
  const left = await environment.start(lingering, undefined, artifact);
  assert.equal((await runOver(left.connection, "echo up")).stdout, "up\n");
  console.log(
    "SHARED SANDBOX SMOKE: shared /tmp and process table, background hand-off, idle stop, policy switch, and holder loss held under real bwrap",
  );
}

/**
 * An allow-list over the real binaries: bwrap, the capture helper, nft, and
 * the gateway. The destinations run in this process and are reached at this
 * host's own address, under a name only the gateway's resolver knows, so the
 * test needs no outside network. Programs in the sandbox are given no proxy
 * and deliberately connect to an address that does not exist: what reaches
 * the destination is decided by the name the connection carries.
 */
async function egressSmoke(appRoot: string): Promise<void> {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;
  assert.ok(address, "the egress smoke needs a non-loopback IPv4 address on the host");

  const web = createServer((req, res) => res.end(`reached ${req.url}`));
  await new Promise<void>((resolve) => web.listen(0, "0.0.0.0", resolve));
  const port = (web.address() as AddressInfo).port;
  // A destination that speaks first, like SSH, and records how each client opened.
  const openings: number[] = [];
  const raw = createTcpServer((socket) => {
    socket.on("error", () => {});
    socket.write("SMOKE-BANNER\n");
    socket.once("data", (chunk: Buffer) => void openings.push(chunk[0]!));
  });
  await new Promise<void>((resolve) => raw.listen(0, "0.0.0.0", resolve));
  const rawPort = (raw.address() as AddressInfo).port;

  const ALLOWED = "allowed.smoke.test";
  const OTHER = "other.smoke.test";
  // TEST-NET-2: an address nothing answers on.
  const NOWHERE = "198.51.100.7";
  const pinned = (name: string, to: number) => `--resolve ${name}:${to}:${NOWHERE}`;

  const storagePath = path.join(appRoot, "egress-release", ".eve", "sandbox-cache");
  const events: BwrapSandboxEvent[] = [];
  const environment = createBwrapSandboxProviderDefinition({
    egressLookup: async (host) => {
      if (host === ALLOWED) return [address];
      throw new Error(`no such host ${host}`);
    },
  }).environment({ onEvent: (event) => void events.push(event) });
  const artifact = await environment.prepare({
    storagePath,
    log: () => {},
    templateKey: () => "egress-smoke",
    async populate() {},
  });
  const ctx = { kind: "session" as const, session: { id: "egress-1" }, storagePath };
  const { connection } = await environment.start(
    ctx,
    { networkPolicy: { allow: [ALLOWED] } },
    artifact,
  );
  const status = async (command: string) =>
    (await runOver(connection, `${command} -s -o /dev/null -w '%{http_code}' --max-time 10`))
      .stdout;
  const denials = () =>
    events.flatMap((event) =>
      event.type === "network.denied" ? [`${event.host}:${event.port}`] : [],
    );

  // The sandbox has no interface but loopback and is told about no proxy.
  const interfaces = await runOver(connection, IFACE_COMMAND);
  assert.equal(nonLoopbackInterfaces(interfaces.stdout).length, 0, "an allow-list has no network");
  const proxies = await runOver(connection, "env | grep -ci proxy || true");
  assert.equal(proxies.stdout.trim(), "0", "no proxy variable may be set");

  // An allowed name is reached whatever address the program connected to.
  const allowed = await runOver(
    connection,
    `curl -sS --max-time 10 ${pinned(ALLOWED, port)} http://${ALLOWED}:${port}/plain`,
  );
  assert.equal(allowed.stdout, "reached /plain", "an allowed domain must be reachable");
  // A program with no notion of a proxy: a bare socket from Node.
  const fromNode = await runOver(
    connection,
    `node -e "const s=require('net').connect(${port},'${NOWHERE}',()=>s.end('GET /node HTTP/1.0\\r\\nHost: ${ALLOWED}\\r\\n\\r\\n'));s.pipe(process.stdout)"`,
  );
  assert.match(fromNode.stdout, /reached \/node$/, "a bare socket must be captured");
  // IPv6 is captured like IPv4, whether or not the host has an IPv6 route.
  const overV6 = await runOver(
    connection,
    `curl -sS --max-time 10 -H 'Host: ${ALLOWED}' 'http://[2001:db8::7]:${port}/v6'`,
  );
  assert.equal(overV6.stdout, "reached /v6", "an IPv6 connection must be captured");
  // TLS is matched by the name in its handshake and passed on undecrypted.
  await runOver(
    connection,
    `curl -sk --max-time 5 ${pinned(ALLOWED, rawPort)} https://${ALLOWED}:${rawPort}/`,
  );
  assert.deepEqual(openings, [0x16], "an allowed TLS handshake must reach its destination");

  // Anything else is refused: another name by HTTP and by TLS, a bare
  // address, and a protocol that names no domain.
  assert.equal(
    await status(`curl ${pinned(OTHER, port)} http://${OTHER}:${port}/`),
    "403",
    "an unlisted domain is refused",
  );
  const otherTls = await runOver(
    connection,
    `curl -sk --max-time 5 ${pinned(OTHER, rawPort)} https://${OTHER}:${rawPort}/`,
  );
  assert.notEqual(otherTls.exitCode, 0, "an unlisted TLS name is refused");
  assert.equal(await status(`curl http://${address}:${port}/`), "403", "an address needs a range");
  const banner = `timeout 5 bash -c 'exec 3<>/dev/tcp/${address}/${rawPort} && head -n 1 <&3'`;
  assert.equal((await runOver(connection, banner)).stdout, "", "a nameless protocol is refused");
  assert.deepEqual(openings, [0x16], "nothing refused may reach a destination");
  assert.deepEqual(
    denials(),
    [`${OTHER}:${port}`, `${OTHER}:${rawPort}`, `${address}:${port}`, `${address}:${rawPort}`],
    "refused destinations must be reported",
  );

  // DNS: a query to any server is answered by the gateway. An allowed name is
  // passed to the host's resolver; any other is answered here and never
  // leaves the host.
  const dig = (name: string) =>
    `python3 -I -c "
import socket, struct
q = struct.pack('!6H', 0x4242, 0x0100, 1, 0, 0, 0) + b''.join(bytes([len(l)]) + l.encode() for l in '${name}'.split('.')) + b'\\0' + struct.pack('!2H', 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(10); s.sendto(q, ('${NOWHERE}', 53))
r, peer = s.recvfrom(4096)
print(peer[0], struct.unpack('!H', r[:2])[0] == 0x4242, r[3] & 15)
"`;
  events.length = 0;
  const [, matched] = (await runOver(connection, dig(ALLOWED))).stdout.trim().split(" ");
  assert.equal(matched, "True", "a query for an allowed name must be answered");
  assert.deepEqual(denials(), [], "a query for an allowed name is not a denial");
  assert.equal(
    (await runOver(connection, dig(OTHER))).stdout.trim(),
    `${NOWHERE} True 3`,
    "a query for an unlisted name is answered as nonexistent, from the address it was sent to",
  );
  assert.deepEqual(denials(), [`${OTHER}:53`], "a refused lookup must be reported");

  // The sandbox cannot undo the capture: its processes hold no capability
  // over their network namespace.
  const tamper = await runOver(
    connection,
    "nft flush ruleset 2>&1; ip route flush table local 2>&1; ip link add x type dummy 2>&1; true",
  );
  assert.match(
    tamper.stdout,
    /not permitted/i,
    "the sandbox must not be able to change its network",
  );
  assert.equal(
    (
      await runOver(
        connection,
        `curl -sS --max-time 10 ${pinned(ALLOWED, port)} http://${ALLOWED}:${port}/still`,
      )
    ).stdout,
    "reached /still",
  );
  assert.equal(
    await status(`curl ${pinned(OTHER, port)} http://${OTHER}:${port}/`),
    "403",
    "the policy must still hold after an attempt to remove it",
  );

  // Address ranges: an allowed one admits the address and whatever protocol
  // is spoken to it, a denied one overrides both it and the allowed domain.
  // Both take effect without a new sandbox.
  await runOver(connection, "echo kept > /tmp/egress-note");
  await connection.extensions.setNetworkPolicy({
    allow: [ALLOWED],
    subnets: { allow: [`${address}/32`] },
  });
  assert.equal(await status(`curl http://${address}:${port}/`), "200", "an allowed range admits");
  assert.equal(
    (await runOver(connection, banner)).stdout,
    "SMOKE-BANNER\n",
    "an allowed range admits a protocol that names no domain",
  );
  await connection.extensions.setNetworkPolicy({
    allow: [ALLOWED],
    subnets: { allow: [`${address}/32`], deny: [`${address}/32`] },
  });
  assert.equal(await status(`curl http://${address}:${port}/`), "403", "a denied range overrides");
  assert.equal(
    await status(`curl ${pinned(ALLOWED, port)} http://${ALLOWED}:${port}/`),
    "403",
    "a denied range overrides an allowed domain",
  );

  // A catch-all admits everything but the host's own addresses.
  await connection.extensions.setNetworkPolicy({ allow: ["*"] });
  assert.equal(await status(`curl http://${address}:${port}/`), "200", "a catch-all admits");
  assert.equal(
    (
      await runOver(connection, `curl -s --max-time 5 http://127.0.0.1:${port}/ || echo unreached`)
    ).stdout.trim(),
    "unreached",
    "loopback in the sandbox is the sandbox's own, not the host's",
  );

  // deny-all withdraws access from the same sandbox, at once, and an
  // allow-list gives it back.
  await connection.extensions.setNetworkPolicy("deny-all");
  const afterDeny = await runOver(connection, `curl -s --max-time 5 http://${address}:${port}/`);
  assert.notEqual(afterDeny.stdout, "reached /", "deny-all must withdraw access");
  await connection.extensions.setNetworkPolicy({ allow: [ALLOWED] });
  assert.equal(
    await status(`curl ${pinned(ALLOWED, port)} http://${ALLOWED}:${port}/`),
    "200",
    "an allow-list after deny-all must restore access",
  );
  assert.equal(
    (await runOver(connection, "cat /tmp/egress-note")).stdout,
    "kept\n",
    "moving among restricted policies must not restart the sandbox",
  );

  await assert.rejects(
    connection.extensions.setNetworkPolicy({
      allow: { [ALLOWED]: [{ transform: [{ headers: { authorization: "x" } }] }] },
    } as never),
    /rules on a domain/,
  );

  assert.equal((await captureHelpers()).length, 1, "one capture helper per sandbox");
  await connection.stop();
  await environment.onSessionEnd(ctx, null, { reason: "deleted" });
  assert.deepEqual(await captureHelpers(), [], "stopping the sandbox must end its capture helper");
  web.closeAllConnections();
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await new Promise<void>((resolve) => raw.close(() => resolve()));
  console.log(
    "EGRESS SMOKE: capture of every connection and DNS query, allow-list by domain and range, refusal, tamper resistance, live policy change, and deny-all held under real bwrap",
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
  // process table, and a joined command must land in it. A runner test double
  // cannot fake a kernel namespace. The table holds bwrap's init, the holder
  // shell, and this command's own processes.
  const procCount = await runOver(connection, "ls /proc | grep -Ec '^[0-9]+$'");
  const sandboxPidCount = Number.parseInt(procCount.stdout.trim(), 10);
  assert.ok(
    Number.isInteger(sandboxPidCount) && sandboxPidCount > 0 && sandboxPidCount <= 8,
    `PID namespace isolation failed: /proc showed ${procCount.stdout.trim()} entries`,
  );
  const hostPid = await runOver(connection, `test -e /proc/${process.pid}/cmdline; echo rc=$?`);
  const init = await runOver(connection, "cat /proc/1/comm");
  assert.ok(
    hostPid.stdout.trim() === "rc=1" || process.pid <= 8,
    "the host process must not be visible from the sandbox",
  );
  assert.equal(init.stdout.trim(), "bwrap", "the sandbox's init must be bwrap");

  // A joined command drops every capability it held while entering the
  // namespaces and has no-new-privileges set, as a bwrap child would.
  const privileges = await runOver(connection, "grep -E '^(CapEff|NoNewPrivs)' /proc/self/status");
  assert.match(privileges.stdout, /CapEff:\s+0+\n/, "a command must run without capabilities");
  assert.match(privileges.stdout, /NoNewPrivs:\s+1\n/, "a command must not gain privileges");

  const missingCwd = await connection.spawn({
    command: "echo unreachable",
    env: {},
    workingDirectory: "/workspace/no-such-directory",
  });
  const [missingCwdOut, missingCwdExit] = await Promise.all([
    new Response(missingCwd.stdout).text(),
    missingCwd.wait(),
    new Response(missingCwd.stderr).text(),
  ]);
  assert.equal(missingCwdExit.exitCode, 1, "a missing working directory must fail the command");
  assert.equal(missingCwdOut, "", "a command must not run outside its working directory");

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
  const zombiesBefore = await countSandboxZombies();
  for (let index = 0; index < 500; index += 1) {
    const short = await runOver(connection, "true");
    assert.equal(short.exitCode, 0, `short command ${index} failed`);
  }
  await sleep(200);
  assert.equal(
    await countSandboxZombies(),
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
  assert.equal(isPythonAvailable(), true, "python3 with ctypes must be installed");
  process.env.SMOKE_SECRET = SECRET;

  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-smoke-"));
  try {
    // Fixture for the HARD LINK probe, outside every cache root, so it stays
    // visible read-only through the sandbox's root bind.
    const hostFilePath = path.join(appRoot, "hostfile.txt");
    await writeFile(hostFilePath, "host-original");

    await boundarySmoke(appRoot, hostFilePath);
    await connectionProviderSmoke(appRoot);
    await sharedSandboxSmoke(appRoot);
    await egressSmoke(appRoot);

    console.log("BWRAP SMOKE OK");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  // Exit now: a command still running in a sandbox would otherwise hold the
  // process open until its run timeout.
  process.exit(1);
});
