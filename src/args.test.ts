import { describe, expect, test } from "vitest";
import {
  buildBwrapHolderArgs,
  buildSandboxJoinArgs,
  DEFAULT_SANDBOX_PATH,
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
   * `/tmp` is the sandbox's own, so bwrap can make a mount point there; and
   * a host directory under a hidden path must still show, so the bind comes
   * after every tmpfs.
   */
  test("the directory of certificates to trust is bound read-only, after everything that hides", () => {
    const args = buildBwrapHolderArgs({
      bwrapPath: "bwrap",
      workspaceDir: "/data/cache/sessions/s1",
      hidePaths: ["/data/cache"],
      shareNetwork: false,
      trustDir: "/data/cache/trust-1",
    });
    const bind = args.lastIndexOf("--ro-bind");
    expect(args.slice(bind, bind + 3)).toEqual([
      "--ro-bind",
      "/data/cache/trust-1",
      "/tmp/.bwrap-sandbox",
    ]);
    expect(bind).toBeGreaterThan(args.lastIndexOf("--tmpfs"));
    expect(
      buildBwrapHolderArgs({
        bwrapPath: "bwrap",
        workspaceDir: "/w",
        hidePaths: [],
        shareNetwork: true,
      }),
    ).not.toContain("/tmp/.bwrap-sandbox");
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
