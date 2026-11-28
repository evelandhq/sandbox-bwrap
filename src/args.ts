import { WORKSPACE_ROOT } from "./paths.js";
import { SANDBOX_TRUST_DIR } from "./trust.js";

/** PATH the sandbox sees; the host rootfs is visible read-only, so the standard dirs apply. */
export const DEFAULT_SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * eve's `SANDBOX_AGENT_ENV` from `eve/sandbox/provider`: tells agent-aware CLIs
 * to skip interactive prompts. eve asks providers to set it beneath their own
 * environment variables. Copied rather than imported so the package root
 * loads without eve's runtime; a test pins it to eve's value.
 */
export const SANDBOX_AGENT_ENV: Readonly<Record<string, string>> = { AI_AGENT: "eve" };

/**
 * The line the holder writes to stderr once bwrap has finished building the
 * sandbox and exec'd it. Before it, the holder's namespaces exist but its
 * mounts may not, so nothing joins until it arrives.
 */
export const HOLDER_READY_MARKER = "bwrap-sandbox-ready";

/**
 * What the holder runs: announce readiness, then block on stdin. The provider
 * keeps that pipe open for as long as the sandbox should live, so the holder
 * also ends when the host process dies without relying on `--die-with-parent`
 * alone. `read` is a bash builtin, so the holder needs no other binary.
 */
const HOLDER_SCRIPT = `echo ${HOLDER_READY_MARKER} >&2; read -r _ || true`;

/**
 * What a joined command runs first. bwrap's `--chdir` belongs to the holder,
 * so each command changes directory itself, then becomes the login shell eve's
 * contract asks for.
 */
const JOIN_SCRIPT = 'cd -- "$1" || exit 1; exec bash -lc "$2"';

export interface BwrapHolderInput {
  readonly bwrapPath: string;
  readonly workspaceDir: string;
  /** Host paths mounted over with an empty tmpfs. Caller filters to existing paths. */
  readonly hidePaths: readonly string[];
  readonly shareNetwork: boolean;
  /**
   * Host directory shown read-only at `SANDBOX_TRUST_DIR`, where the sandbox
   * finds the certificates a policy with rules needs it to trust. The mounts
   * of a sandbox are fixed when it starts and a policy can gain rules later,
   * so the directory is mounted from the start and filled when needed.
   */
  readonly trustDir?: string;
}

/**
 * The argv of a sandbox's holder: one long-lived bwrap that builds the
 * sandbox's mount, PID, IPC, and UTS namespaces (and a network namespace when
 * the network is denied) and then idles. Every command joins it with
 * {@link buildSandboxJoinArgs}, so commands share `/tmp` and see each other's
 * processes, and a process may outlive the command that started it.
 *
 * `--info-fd 1` makes bwrap write the host pid of its in-sandbox init and the
 * ids of its namespaces to stdout; that process is the one commands join.
 * bwrap closes the descriptor in the sandbox, so the holder script reports
 * readiness on stderr instead.
 */
export function buildBwrapHolderArgs(input: BwrapHolderInput): string[] {
  const args = [
    input.bwrapPath,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  // Hide paths BEFORE re-binding the workspace: bind sources resolve against
  // the host filesystem, so a later bind punches through an earlier tmpfs.
  for (const path of input.hidePaths) {
    args.push("--tmpfs", path);
  }
  if (input.trustDir !== undefined) {
    args.push("--ro-bind", input.trustDir, SANDBOX_TRUST_DIR);
  }
  args.push("--bind", input.workspaceDir, WORKSPACE_ROOT);
  if (!input.shareNetwork) {
    args.push("--unshare-net");
  }
  args.push(
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
    HOLDER_SCRIPT,
  );
  return args;
}

/**
 * Namespace flags for `setns(2)`, from `<linux/sched.h>`. The helper joins
 * every namespace the holder unshared in one call.
 */
const CLONE_NEWNS = 0x0002_0000;
const CLONE_NEWUTS = 0x0400_0000;
const CLONE_NEWIPC = 0x0800_0000;
const CLONE_NEWUSER = 0x1000_0000;
const CLONE_NEWPID = 0x2000_0000;
const CLONE_NEWNET = 0x4000_0000;

/**
 * The exit code of a command that could not join its sandbox. The helper
 * writes the reason to the command's stderr.
 */
export const SANDBOX_JOIN_FAILED_EXIT_CODE = 125;

/**
 * The join helper, run as `python3 -I -S -c <this> <pid> <flags> <mnt ns> <argv...>`.
 *
 * It moves into the holder's namespaces with one `setns(pidfd, flags)`, which
 * is the only way an unprivileged process can: bwrap's `--dev` leaves the
 * sandbox's processes in a second, nested user namespace, while the mount,
 * PID, and IPC namespaces belong to the first. One `setns` per namespace
 * would enter the inner user namespace and then be refused the rest. The
 * single call is checked against the caller's original credentials, which
 * own the outer namespace. It needs Linux 5.8.
 *
 * A pid can be reused, so before joining the helper checks that the process
 * it opened is in the mount namespace bwrap reported; anything else is not
 * this sandbox. It then sets `no_new_privs`, as bwrap does for its own
 * children, and forks, because a PID namespace only applies to children. The
 * exec drops every capability the join granted: the command is not root in
 * the sandbox.
 */
const JOIN_HELPER = `
import ctypes, os, sys
pid, flags, expected = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
libc = ctypes.CDLL(None, use_errno=True)
def refuse(reason):
    sys.stderr.write("bwrap sandbox: cannot join the sandbox: " + reason + "\\n")
    sys.exit(${SANDBOX_JOIN_FAILED_EXIT_CODE})
def failed(call, hint=""):
    refuse(call + ": " + os.strerror(ctypes.get_errno()) + hint)
fd = libc.syscall(434, pid, 0)
if fd < 0:
    failed("pidfd_open")
try:
    actual = os.readlink("/proc/%d/ns/mnt" % pid)
except OSError as error:
    refuse("the sandbox is gone (" + os.strerror(error.errno) + ")")
if expected and actual != expected:
    refuse("process %d is not in this sandbox" % pid)
if libc.setns(fd, flags) != 0:
    failed("setns", " (joining a sandbox needs Linux 5.8 or newer)")
os.close(fd)
if libc.prctl(38, 1, 0, 0, 0) != 0:
    failed("prctl(PR_SET_NO_NEW_PRIVS)")
child = os.fork()
if child == 0:
    try:
        os.execv(sys.argv[4], sys.argv[4:])
    except OSError as error:
        sys.stderr.write("bwrap sandbox: cannot run " + sys.argv[4] + ": " + os.strerror(error.errno) + "\\n")
        os._exit(127)
status = os.waitpid(child, 0)[1]
sys.exit(128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status))
`.trim();

export interface SandboxJoinInput {
  readonly pythonPath: string;
  /** Host pid of the holder's in-sandbox init, from bwrap's `--info-fd`. */
  readonly targetPid: number;
  /**
   * The holder's mount namespace id, from bwrap's `--info-fd`, which the
   * helper checks the target against. Without one the check is skipped.
   */
  readonly mountNamespace?: number;
  /** Whether the holder unshared its network namespace. */
  readonly joinNetwork: boolean;
  /** Final merged environment; with `env -i` the command sees exactly these variables. */
  readonly env: Readonly<Record<string, string>>;
  /** Sandbox-visible working directory (already /workspace-anchored). */
  readonly chdir: string;
  readonly command: string;
}

/**
 * The argv that runs one command inside a holder's sandbox: the join helper,
 * then `env -i`, which drops the host process's environment as bwrap's
 * `--clearenv` did when every command was its own bwrap, then the join
 * script. `-I -S` keep Python from reading that environment or any site
 * configuration. A holder that shares the host network owns no network
 * namespace, so that flag is set only for one that unshared it.
 */
export function buildSandboxJoinArgs(input: SandboxJoinInput): string[] {
  const flags =
    CLONE_NEWUSER |
    CLONE_NEWNS |
    CLONE_NEWPID |
    CLONE_NEWIPC |
    CLONE_NEWUTS |
    (input.joinNetwork ? CLONE_NEWNET : 0);
  return [
    input.pythonPath,
    "-I",
    "-S",
    "-c",
    JOIN_HELPER,
    String(input.targetPid),
    String(flags),
    input.mountNamespace === undefined ? "" : `mnt:[${input.mountNamespace}]`,
    "/usr/bin/env",
    "-i",
    ...Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    "bash",
    "-c",
    JOIN_SCRIPT,
    "bash",
    input.chdir,
    input.command,
  ];
}
