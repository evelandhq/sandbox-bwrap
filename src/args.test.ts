import { describe, expect, test } from "vitest";
import {
  buildBwrapHolderArgs,
  buildSandboxJoinArgs,
  DEFAULT_SANDBOX_PATH,
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  egressEnvironment,
  HOLDER_READY_MARKER,
  SANDBOX_JOIN_FAILED_EXIT_CODE,
} from "./args.js";

describe("buildBwrapHolderArgs", () => {
  test("pins the exact sandbox argv (order is load-bearing)", () => {
    const args = buildBwrapHolderArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/app/.eve/sandbox-cache/bwrap/sessions/abc",
      hidePaths: ["/app/.eve/sandbox-cache/bwrap"],
      shareNetwork: true,
    });

    expect(args).toEqual([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/app/.eve/sandbox-cache/bwrap",
      "--bind",
      "/app/.eve/sandbox-cache/bwrap/sessions/abc",
      "/workspace",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--clearenv",
      "--setenv",
      "PATH",
      DEFAULT_SANDBOX_PATH,
      "--info-fd",
      "1",
      "--chdir",
      "/",
      "bash",
      "-c",
      `echo ${HOLDER_READY_MARKER} >&2; read -r _ || true`,
    ]);
  });

  test("deny-all adds --unshare-net after the workspace bind", () => {
    const args = buildBwrapHolderArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/w",
      hidePaths: [],
      shareNetwork: false,
    });
    const bindIndex = args.indexOf("--bind");
    const unshareNetIndex = args.indexOf("--unshare-net");
    expect(unshareNetIndex).toBeGreaterThan(bindIndex);
    expect(args).toContain("--clearenv");
  });

  test("tmpfs hides come before the workspace bind so the bind punches through", () => {
    const args = buildBwrapHolderArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/data/cache/sessions/s1",
      hidePaths: ["/data/cache", "/srv/private"],
      shareNetwork: true,
    });
    const lastTmpfs = args.lastIndexOf("--tmpfs");
    expect(lastTmpfs).toBeLessThan(args.indexOf("--bind"));
    expect(args.slice(lastTmpfs, lastTmpfs + 2)).toEqual(["--tmpfs", "/srv/private"]);
  });

  /**
   * The holder carries none of the session's environment: every command sets
   * its own when it joins, so a secret in a per-call `env` never sits in a
   * long-lived process's environment.
   */
  test("the holder's environment is PATH alone", () => {
    const args = buildBwrapHolderArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/w",
      hidePaths: [],
      shareNetwork: true,
    });
    expect(args.filter((arg) => arg === "--setenv")).toHaveLength(1);
  });
});

describe("buildBwrapHolderArgs with an egress socket", () => {
  const args = buildBwrapHolderArgs({
    bwrapPath: "bwrap",
    workspaceDir: "/w",
    hidePaths: [],
    shareNetwork: false,
    egress: { socketDir: "/tmp/bwrap-egress-abc", socketName: "proxy.sock", pythonPath: "python3" },
  });

  /** Read-only, so a sandboxed program can connect to the socket but not replace it. */
  test("binds the proxy's socket directory read-only, after the workspace", () => {
    const bind = args.indexOf("--ro-bind", args.indexOf("--bind"));
    expect(args.slice(bind, bind + 3)).toEqual([
      "--ro-bind",
      "/tmp/bwrap-egress-abc",
      EGRESS_SOCKET_DIR,
    ]);
    expect(args).toContain("--unshare-net");
  });

  test("the holder starts the forwarder on demand, against the bound socket", () => {
    const script = args.indexOf("-c", args.indexOf("bash"));
    expect(args[script + 1]).toBe(
      `echo ${HOLDER_READY_MARKER} >&2; while read -r _; do "$1" -I -S -c "$2" ${EGRESS_PROXY_PORT} "$3" & done`,
    );
    expect(args.slice(script + 2, script + 4)).toEqual(["bash", "python3"]);
    expect(args[script + 4]).toContain('listener.bind(("127.0.0.1", port))');
    expect(args[script + 5]).toBe(`${EGRESS_SOCKET_DIR}/proxy.sock`);
  });
});

describe("egressEnvironment", () => {
  test("points both spellings of the proxy variables at the forwarder", () => {
    const proxy = `http://127.0.0.1:${EGRESS_PROXY_PORT}`;
    expect(egressEnvironment()).toEqual({
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      http_proxy: proxy,
      https_proxy: proxy,
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    });
  });
});

describe("buildSandboxJoinArgs", () => {
  const base = {
    pythonPath: "python3",
    targetPid: 4242,
    mountNamespace: 4026532392,
    joinNetwork: false,
    env: { PATH: DEFAULT_SANDBOX_PATH, HOME: "/workspace" },
    chdir: "/workspace/sub",
    command: "echo hi",
  };
  // CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS
  const WITHOUT_NETWORK = 0x3c02_0000;
  const CLONE_NEWNET = 0x4000_0000;

  test("pins the exact join argv around the helper", () => {
    const args = buildSandboxJoinArgs(base);
    const helper = args[4]!;

    expect([...args.slice(0, 4), ...args.slice(5)]).toEqual([
      "python3",
      "-I",
      "-S",
      "-c",
      "4242",
      String(WITHOUT_NETWORK),
      "mnt:[4026532392]",
      "/usr/bin/env",
      "-i",
      `PATH=${DEFAULT_SANDBOX_PATH}`,
      "HOME=/workspace",
      "bash",
      "-c",
      'cd -- "$1" || exit 1; exec bash -lc "$2"',
      "bash",
      "/workspace/sub",
      "echo hi",
    ]);
    // One setns over a pidfd: joining namespace by namespace is refused when
    // bwrap nested the sandbox's user namespace, which `--dev` makes it do.
    expect(helper).toContain("libc.syscall(434, pid, 0)");
    expect(helper).toContain("libc.setns(fd, flags)");
    expect(helper).toContain(`sys.exit(${SANDBOX_JOIN_FAILED_EXIT_CODE})`);
  });

  /**
   * A holder that shares the host network owns no network namespace, and
   * nothing may join the host's from inside a user namespace, so the flag is
   * present only for a holder that unshared its own.
   */
  test("joins the network namespace only when the holder has its own", () => {
    expect(Number(buildSandboxJoinArgs(base)[6]) & CLONE_NEWNET).toBe(0);
    expect(Number(buildSandboxJoinArgs({ ...base, joinNetwork: true })[6])).toBe(
      WITHOUT_NETWORK | CLONE_NEWNET,
    );
  });

  test("without a reported mount namespace the helper is told to skip the identity check", () => {
    const { mountNamespace: _unreported, ...unreported } = base;
    expect(buildSandboxJoinArgs(unreported)[7]).toBe("");
  });

  /** `env -i` is what keeps the host process's environment out of the command. */
  test("the command's environment is exactly the one it is given", () => {
    const args = buildSandboxJoinArgs({ ...base, env: { A: "1", B: "two words" } });
    const envIndex = args.indexOf("/usr/bin/env");
    expect(args.slice(envIndex, envIndex + 5)).toEqual([
      "/usr/bin/env",
      "-i",
      "A=1",
      "B=two words",
      "bash",
    ]);
  });
});
