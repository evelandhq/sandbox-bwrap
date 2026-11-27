import { DEFAULT_SANDBOX_PATH } from "./args.js";
import type { ProcessRunner } from "./process.js";

/** The line the capture helper writes to stderr once the sandbox's traffic reaches it. */
export const CAPTURE_READY_MARKER = "bwrap-capture-ready";

/** The exit code of a capture helper that could not take over the sandbox's network. */
export const CAPTURE_FAILED_EXIT_CODE = 125;

/** How long the capture helper may take to set up before it is given up on. */
export const DEFAULT_CAPTURE_START_TIMEOUT_MS = 10_000;

/** Cap on the helper stderr kept for a start failure's message. */
const MAX_DIAGNOSTIC_CHARS = 4_096;

/**
 * The capture helper, run on the host as
 * `python3 -I -S -c <this> <pid> <mnt ns> <gateway socket>`.
 *
 * A sandbox whose network is restricted has a network namespace with nothing
 * in it but loopback. The helper enters that namespace, and the user
 * namespace that owns it, from outside: the sandbox's own processes run in a
 * second user namespace nested inside that one, so they hold no capability
 * over the network and can neither see nor signal the helper. There it
 *
 * - routes every destination to loopback, so a connection to any address
 *   gets as far as the netfilter output hook instead of failing for want of
 *   a route;
 * - loads nftables rules that redirect every TCP connection not bound for
 *   loopback, and every DNS query, to sockets the helper listens on;
 * - relays each one to the egress gateway's Unix socket, telling it the
 *   destination the program asked for.
 *
 * The helper decides nothing. The gateway, in the host process, enforces the
 * policy; a sandboxed program that bypasses the helper's sockets has no other
 * route, and one that reaches the gateway's socket is held to the same policy.
 *
 * It ends when the sandbox does or when the provider closes its stdin, which
 * also happens if the host process dies. The rules outlive it and point at
 * ports nobody listens on, so a sandbox without its helper has no network
 * rather than an open one.
 */
const CAPTURE_HELPER = `
import ctypes, fcntl, os, select, socket, struct, subprocess, sys, threading
pid, expected, upstream = int(sys.argv[1]), sys.argv[2], sys.argv[3]
libc = ctypes.CDLL(None, use_errno=True)
def refuse(reason):
    sys.stderr.write("bwrap sandbox: cannot take over the sandbox's network: " + reason + "\\n")
    sys.exit(${CAPTURE_FAILED_EXIT_CODE})
def failed(call):
    refuse(call + ": " + os.strerror(ctypes.get_errno()))
holder = libc.syscall(434, pid, 0)
if holder < 0:
    failed("pidfd_open")
try:
    if expected and os.readlink("/proc/%d/ns/mnt" % pid) != expected:
        refuse("process %d is not in this sandbox" % pid)
    net = os.open("/proc/%d/ns/net" % pid, os.O_RDONLY)
    if os.fstat(net).st_ino == os.stat("/proc/self/ns/net").st_ino:
        refuse("the sandbox shares the host's network")
    owner = fcntl.ioctl(net, 0xb701)
    joined = os.fstat(owner).st_ino == os.stat("/proc/self/ns/user").st_ino
except OSError as error:
    refuse("the sandbox is gone (" + os.strerror(error.errno) + ")")
if not joined and libc.setns(owner, 0x10000000) != 0:
    failed("setns(user)")
if libc.setns(net, 0x40000000) != 0:
    failed("setns(net)")
libc.prctl(1, 9, 0, 0, 0)
def listen(family, kind, address):
    opened = socket.socket(family, kind)
    opened.bind((address, 0))
    if kind == socket.SOCK_STREAM:
        opened.listen(128)
    return opened
tcp4 = listen(socket.AF_INET, socket.SOCK_STREAM, "127.0.0.1")
dns4 = listen(socket.AF_INET, socket.SOCK_DGRAM, "127.0.0.1")
try:
    tcp6 = listen(socket.AF_INET6, socket.SOCK_STREAM, "::1")
    dns6 = listen(socket.AF_INET6, socket.SOCK_DGRAM, "::1")
except OSError:
    tcp6 = dns6 = None
def run(argv, text=None):
    try:
        done = subprocess.run(argv, input=text, env={"PATH": "${DEFAULT_SANDBOX_PATH}"},
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    except OSError as error:
        return argv[0] + ": " + os.strerror(error.errno)
    return None if done.returncode == 0 else " ".join(argv[:3]) + ": " + done.stdout.strip()
def rules(family, loopback, tcp, dns):
    table = family + " bwrap_egress"
    return ("add table %s\\ndelete table %s\\ntable %s {\\n chain output {\\n"
            "  type nat hook output priority -100;\\n"
            "  udp dport 53 redirect to :%d\\n"
            "  %s daddr %s return\\n"
            "  meta l4proto tcp redirect to :%d\\n }\\n}\\n"
            % (table, table, table, dns.getsockname()[1], family, loopback, tcp.getsockname()[1]))
problem = (run(["nft", "-f", "-"], rules("ip", "127.0.0.0/8", tcp4, dns4))
           or run(["ip", "route", "replace", "local", "default", "dev", "lo"]))
if problem:
    refuse(problem + " (an allow-list needs nft and ip on the host, and nftables NAT in the kernel)")
if tcp6 is not None and (run(["nft", "-f", "-"], rules("ip6", "::1", tcp6, dns6))
                         or run(["ip", "-6", "route", "replace", "local", "default", "dev", "lo"])):
    tcp6 = dns6 = None
def pump(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        try:
            sink.shutdown(socket.SHUT_WR)
        except OSError:
            pass
def original(client, v6):
    if v6:
        raw = client.getsockopt(41, 80, 28)
        return socket.inet_ntop(socket.AF_INET6, raw[8:24]), struct.unpack("!H", raw[2:4])[0]
    raw = client.getsockopt(0, 80, 16)
    return socket.inet_ntoa(raw[4:8]), struct.unpack("!H", raw[2:4])[0]
def serve(client, v6):
    gateway = socket.socket(socket.AF_UNIX)
    try:
        address, port = original(client, v6)
        gateway.connect(upstream)
        gateway.sendall(("T %s %d\\n" % (address, port)).encode())
        back = threading.Thread(target=pump, args=(gateway, client), daemon=True)
        back.start()
        pump(client, gateway)
        back.join()
    except OSError:
        pass
    finally:
        client.close()
        gateway.close()
def accept(listener, v6):
    while True:
        try:
            client = listener.accept()[0]
        except OSError:
            continue
        threading.Thread(target=serve, args=(client, v6), daemon=True).start()
def resolve(sock, query, peer):
    gateway = socket.socket(socket.AF_UNIX)
    gateway.settimeout(30)
    try:
        gateway.connect(upstream)
        gateway.sendall(b"D\\n" + struct.pack("!H", len(query)) + query)
        reply = b""
        while len(reply) < 2 or len(reply) < 2 + struct.unpack("!H", reply[:2])[0]:
            data = gateway.recv(65536)
            if not data:
                return
            reply += data
        sock.sendto(reply[2:], peer)
    except OSError:
        pass
    finally:
        gateway.close()
def answer(sock):
    while True:
        try:
            query, peer = sock.recvfrom(65535)
        except OSError:
            continue
        threading.Thread(target=resolve, args=(sock, query, peer), daemon=True).start()
for listener, v6 in ((tcp4, False), (tcp6, True)):
    if listener is not None:
        threading.Thread(target=accept, args=(listener, v6), daemon=True).start()
for sock in (dns4, dns6):
    if sock is not None:
        threading.Thread(target=answer, args=(sock,), daemon=True).start()
sys.stderr.write("${CAPTURE_READY_MARKER}\\n")
sys.stderr.flush()
select.select([holder, 0], [], [])
os._exit(0)
`.trim();

export interface NetworkCaptureArgsInput {
  readonly pythonPath: string;
  /** Host pid of the holder's in-sandbox init, from bwrap's `--info-fd`. */
  readonly targetPid: number;
  /** The holder's mount namespace id, which the helper checks the target against. */
  readonly mountNamespace?: number;
  /** Host path of the egress gateway's socket. */
  readonly socketPath: string;
}

/** The argv that runs the capture helper against one holder. */
export function buildNetworkCaptureArgs(input: NetworkCaptureArgsInput): string[] {
  return [
    input.pythonPath,
    "-I",
    "-S",
    "-c",
    CAPTURE_HELPER,
    String(input.targetPid),
    input.mountNamespace === undefined ? "" : `mnt:[${input.mountNamespace}]`,
    input.socketPath,
  ];
}

/** Whether `argv` is a capture helper's, so a fake runner can tell it from a command's. */
export function isNetworkCaptureArgs(argv: readonly string[]): boolean {
  return argv[4] === CAPTURE_HELPER;
}

/** One sandbox's capture helper: while it runs, the sandbox's traffic reaches the gateway. */
export interface NetworkCapture {
  /** False once the helper has exited, however it ended. */
  alive(): boolean;
  /** Ends the helper. The sandbox is left with no route at all. Idempotent. */
  stop(): Promise<void>;
}

export interface StartNetworkCaptureInput extends NetworkCaptureArgsInput {
  readonly runner: ProcessRunner;
  readonly startTimeoutMs?: number;
}

/**
 * Starts the capture helper for a holder and resolves once the sandbox's
 * traffic reaches the gateway. A helper that exits first, or is not ready in
 * time, is killed and the failure carries what it wrote to stderr.
 */
export async function startNetworkCapture(
  input: StartNetworkCaptureInput,
): Promise<NetworkCapture> {
  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_CAPTURE_START_TIMEOUT_MS;
  // The stdin pipe is the helper's lifeline: it exits when the pipe closes,
  // which is also what happens when this process dies.
  const proc = input.runner.spawn(buildNetworkCaptureArgs(input), { stdin: true });
  let exited = false;
  const exit = proc.wait().then(
    () => void (exited = true),
    () => void (exited = true),
  );

  let diagnostics = "";
  const ready = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        diagnostics = (diagnostics + decoder.decode(value, { stream: true })).slice(
          -MAX_DIAGNOSTIC_CHARS,
        );
        if (diagnostics.includes(CAPTURE_READY_MARKER)) {
          // Keep draining: a pipe nobody reads would block the helper's next write.
          void (async () => {
            try {
              while (!(await reader.read()).done);
            } catch {
              // The stream fails when the helper is killed; nothing to report.
            }
          })();
          return true;
        }
      }
    } catch {
      return false;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = await Promise.race([
    ready,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), startTimeoutMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!started) {
    await proc.kill().catch(() => {});
    const detail = diagnostics.trim();
    throw new Error(
      detail === ""
        ? "bwrap sandbox: cannot take over the sandbox's network: the capture helper did not start"
        : detail,
    );
  }
  // Like the holder, the helper idles for as long as the sandbox lives and
  // must not hold the host process open.
  proc.unref?.();

  return {
    alive: () => !exited,
    async stop() {
      if (exited) return;
      await proc.kill();
      await exit;
    },
  };
}
