import { createSocket } from "node:dgram";
import { getServers } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { BlockList, connect, createServer, isIP, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { EgressAuthority } from "./authority.js";
import { createEgressInterceptor } from "./egress-intercept.js";
import {
  answerDnsQuery,
  DNS_NAME_ERROR,
  DNS_SERVER_FAILURE,
  parseDnsQuestion,
  sniffServerName,
  type Sniffed,
} from "./egress-sniff.js";
import type { ResolvedNetworkPolicy } from "./network-policy.js";

/** Resolves a host name to its addresses, in the order to try them. */
export type EgressLookup = (host: string) => Promise<readonly string[]>;

/** Answers one DNS query, both in wire format. */
export type EgressDnsResolver = (query: Buffer) => Promise<Buffer>;

/** A destination the policy turned away. Never carries a path, a header, or a body. */
export interface EgressDenial {
  readonly host: string;
  readonly port: number;
}

/**
 * The only way out of a sandbox whose network is restricted. The kernel hands
 * every connection a sandboxed program opens, and every DNS query it sends,
 * to the capture helper (`capture.ts`), which relays each one here over a
 * Unix socket together with the destination the program asked for. The
 * gateway opens a connection only to a destination the current policy allows.
 *
 * A domain is taken from the connection itself: the server name of a TLS
 * handshake or the `Host` header of an HTTP request. A connection is passed
 * on as it is, encrypted end to end, unless its domain carries rules: those
 * connections the gateway answers itself, so it can apply the rules to each
 * request before sending it on (`egress-intercept.ts`).
 */
export interface EgressGateway {
  /** Host path of the socket the capture helper relays to. */
  readonly socketPath: string;
  /**
   * Replaces the policy. It applies to connections already open as well: one
   * whose destination the new policy does not allow is closed.
   */
  setPolicy(policy: ResolvedNetworkPolicy): void;
  close(): Promise<void>;
}

export interface StartEgressGatewayInput {
  readonly policy: ResolvedNetworkPolicy;
  readonly lookup?: EgressLookup;
  readonly resolveDns?: EgressDnsResolver;
  readonly onDenied?: (denial: EgressDenial) => void;
  /** How long a connection may take to show which domain it is for. */
  readonly sniffTimeoutMs?: number;
  /**
   * The sandbox's certificate authority, asked for when a connection to a
   * domain with rules first has to be answered. Without one such a connection
   * is refused.
   */
  readonly authority?: () => Promise<EgressAuthority>;
  /** Authorities trusted for a destination's certificate besides the host's own, PEM. */
  readonly upstreamRoots?: readonly string[];
}

const SOCKET_NAME = "egress.sock";

/** How long one address may take to accept before the next one is tried. */
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;

/** How long one DNS server may take to answer before the next one is asked. */
const DNS_ATTEMPT_TIMEOUT_MS = 5_000;

/** A TLS or HTTP client speaks first and at once; one that has not by now names no domain. */
const DEFAULT_SNIFF_TIMEOUT_MS = 5_000;

/**
 * How long a connection the policy already admits by its address is watched
 * for a domain, which decides only whether rules apply to it. A TLS client
 * sends its handshake at once; a protocol in which the server speaks first
 * waits this long for its connection.
 */
const ADMITTED_SNIFF_TIMEOUT_MS = 1_000;

/** How long the capture helper may take to say what a relayed connection is. */
const HEADER_TIMEOUT_MS = 5_000;

/** A fatal `access_denied` TLS alert: what a refused handshake is answered with. */
const TLS_ACCESS_DENIED = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);

/** A fatal `internal_error` TLS alert: a handshake the gateway could not answer. */
const TLS_INTERNAL_ERROR = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x50]);

/**
 * Addresses that mean the host itself or its link: loopback, link-local
 * (which carries cloud metadata services), and the unspecified address. The
 * gateway connects from the host's network, so a domain that resolves to one
 * of these would reach a service the host never meant to publish. They are
 * reachable only through a `subnets.allow` range that names them.
 */
const HOST_LOCAL = new BlockList();
HOST_LOCAL.addSubnet("127.0.0.0", 8, "ipv4");
HOST_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
HOST_LOCAL.addSubnet("0.0.0.0", 8, "ipv4");
HOST_LOCAL.addAddress("::1", "ipv6");
HOST_LOCAL.addAddress("::", "ipv6");
HOST_LOCAL.addSubnet("fe80::", 10, "ipv6");

function isHostLocal(address: string): boolean {
  const version = isIP(address);
  return version !== 0 && HOST_LOCAL.check(address, version === 4 ? "ipv4" : "ipv6");
}

/** An IPv4 address written as IPv6 is the IPv4 address, for every range check. */
function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

/**
 * Connects to the first of `addresses` that accepts. A name often resolves to
 * several, and a destination that listens on only one family must not be
 * unreachable because another was listed first.
 */
async function connectAny(
  addresses: readonly string[],
  port: number,
): Promise<{ socket: Socket; address: string }> {
  let failure: unknown = new Error("no address to connect to");
  for (const address of addresses) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const attempt = connect({ host: address, port, allowHalfOpen: true });
        attempt.setTimeout(CONNECT_ATTEMPT_TIMEOUT_MS, () =>
          attempt.destroy(new Error(`connect to ${address} timed out`)),
        );
        attempt.once("connect", () => {
          attempt.setTimeout(0);
          attempt.removeAllListeners("error");
          resolve(attempt);
        });
        attempt.once("error", reject);
      });
      return { socket, address };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

const systemLookup: EgressLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

/** `dns.getServers()` writes a server as an address, `address:port`, or `[address]:port`. */
function parseDnsServer(server: string): { address: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(server);
  if (bracketed) return { address: bracketed[1]!, port: Number(bracketed[2] ?? 53) };
  if (isIP(server) !== 0) return { address: server, port: 53 };
  const separator = server.lastIndexOf(":");
  return { address: server.slice(0, separator), port: Number(server.slice(separator + 1)) };
}

function askDnsServer(query: Buffer, address: string, port: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = createSocket(isIP(address) === 6 ? "udp6" : "udp4");
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`DNS server ${address} did not answer`))),
      DNS_ATTEMPT_TIMEOUT_MS,
    );
    socket.once("error", (error) => settle(() => reject(error)));
    socket.on("message", (message) => {
      // Anything but the answer to this query is not ours to pass on.
      if (message.length < 12 || message.readUInt16BE(0) !== query.readUInt16BE(0)) return;
      settle(() => resolve(message));
    });
    socket.send(query, port, address);
  });
}

/** Passes a query to the host's own DNS servers, in their configured order. */
const systemDnsResolver: EgressDnsResolver = async (query) => {
  let failure: unknown = new Error("the host has no DNS server configured");
  for (const server of getServers()) {
    const { address, port } = parseDnsServer(server);
    try {
      return await askDnsServer(query, address, port);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
};

/**
 * The bytes a relayed connection has delivered so far, held until the gateway
 * knows where they go.
 */
function createIntake(socket: Socket) {
  let buffered: Buffer = Buffer.alloc(0);
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const onData = (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  return {
    bytes: () => buffered,
    /** Removes and returns the first `count` bytes. */
    take(count: number): Buffer {
      const head = buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      return head;
    },
    /** Resolves true once more bytes have arrived, false if none will in time. */
    async more(timeoutMs: number): Promise<boolean> {
      if (ended || timeoutMs <= 0) return false;
      const before = buffered.length;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(notify, timeoutMs);
        timer.unref?.();
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      return buffered.length > before;
    },
    /** Stops collecting and returns what is held; the socket is left paused. */
    release(): Buffer {
      socket.pause();
      socket.off("data", onData);
      const held = buffered;
      buffered = Buffer.alloc(0);
      return held;
    },
  };
}

type Intake = ReturnType<typeof createIntake>;

export async function startEgressGateway(input: StartEgressGatewayInput): Promise<EgressGateway> {
  const lookup = input.lookup ?? systemLookup;
  const resolveDns = input.resolveDns ?? systemDnsResolver;
  const sniffTimeoutMs = input.sniffTimeoutMs ?? DEFAULT_SNIFF_TIMEOUT_MS;
  let policy = input.policy;
  // A short path of its own: a Unix socket path is limited to about 100
  // bytes, which a path under a deep cache directory can exceed.
  const socketDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-egress-"));
  const socketPath = path.join(socketDir, SOCKET_NAME);
  /** Connections passed on or answered, each able to say whether the policy still wants it. */
  const open = new Set<{ allowed(): boolean; close(): void }>();
  const relayed = new Set<Socket>();
  const interceptor = createEgressInterceptor({
    authority:
      input.authority ??
      (async () => {
        throw new Error("no certificate authority");
      }),
    rulesFor: (name) => (policy.kind === "allow-list" ? policy.rulesFor(name) : []),
    ...(input.upstreamRoots === undefined ? {} : { upstreamRoots: input.upstreamRoots }),
  });

  /**
   * Whether `address` may be connected to, for a connection that named the
   * domain `name` or, without one, named none. A denied range refuses
   * everything, an allowed range admits everything else, and a host-local
   * address is admitted by nothing but an allowed range.
   */
  function admits(name: string | undefined, address: string): boolean {
    if (policy.kind !== "allow-list") return policy.kind === "allow-all";
    if (policy.deniesAddress(address)) return false;
    if (policy.allowsAddress(address)) return true;
    if (isHostLocal(address)) return false;
    return name === undefined ? policy.allowsAnyDomain : policy.allowsDomain(name);
  }

  /** Whether connections to `name` are answered here, so its rules can be applied. */
  function intercepts(name: string): boolean {
    return policy.kind === "allow-list" && policy.rulesFor(name).length > 0;
  }

  /** Whether a query for `name` is passed on. An allowed range leaves every name resolvable. */
  function resolves(name: string): boolean {
    if (policy.kind !== "allow-list") return policy.kind === "allow-all";
    return policy.allowsDomain(name) || (policy.recorded.subnets?.allow?.length ?? 0) > 0;
  }

  function report(host: string, port: number) {
    try {
      input.onDenied?.({ host, port });
    } catch {
      // Reporting is best effort and never changes what the gateway decided.
    }
  }

  /** Ends a connection the policy turned away, in the terms of the protocol it spoke. */
  function refuse(
    client: Socket,
    protocol: "tls" | "http" | undefined,
    host: string,
    port: number,
    reason = `the network policy does not allow ${host}`,
  ) {
    report(host, port);
    if (protocol === "http") {
      const body = `bwrap sandbox: ${reason}\n`;
      client.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        () => client.destroy(),
      );
    } else if (protocol === "tls") {
      client.end(TLS_ACCESS_DENIED, () => client.destroy());
    } else {
      client.destroy();
    }
  }

  async function forward(
    client: Socket,
    intake: Intake,
    name: string | undefined,
    addresses: readonly string[],
    port: number,
    protocol: "tls" | "http" | undefined,
  ) {
    let upstream: Socket;
    let address: string;
    try {
      ({ socket: upstream, address } = await connectAny(addresses, port));
    } catch (error) {
      if (protocol === "http") {
        const body = `bwrap sandbox: cannot reach ${name ?? addresses[0]}: ${(error as Error).message}\n`;
        client.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          () => client.destroy(),
        );
      } else {
        client.destroy();
      }
      return;
    }
    // The policy may have changed while the connection was being made.
    if (client.destroyed || !admits(name, address)) {
      upstream.destroy();
      client.destroy();
      return;
    }
    const entry = {
      // A connection passed on as it is has no place under rules made since.
      allowed: () => admits(name, address) && (name === undefined || !intercepts(name)),
      close: () => {
        upstream.destroy();
        client.destroy();
      },
    };
    open.add(entry);
    upstream.on("error", () => {});
    upstream.once("close", () => {
      open.delete(entry);
      client.destroy();
    });
    client.once("close", () => upstream.destroy());
    const head = intake.release();
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  /**
   * Answers a connection to a domain with rules. The program's handshake is
   * completed here, and what it sends is read, changed as the rules say, and
   * sent on to one of `addresses`.
   */
  async function intercept(
    client: Socket,
    intake: Intake,
    name: string,
    addresses: readonly string[],
    port: number,
  ) {
    const head = intake.release();
    let connection;
    try {
      connection = await interceptor.accept(client, head, { name, port, addresses });
    } catch {
      if (!client.destroyed) client.end(TLS_INTERNAL_ERROR, () => client.destroy());
      return;
    }
    const entry = {
      allowed: () => intercepts(name) && addresses.every((address) => admits(name, address)),
      close: connection.close,
    };
    // The policy may have changed while the certificate was being issued.
    if (!entry.allowed()) return connection.close();
    open.add(entry);
    void connection.closed.then(() => open.delete(entry));
  }

  async function serveTcp(client: Socket, intake: Intake, address: string, port: number) {
    const byAddress = admits(undefined, address);
    if (policy.kind !== "allow-list") {
      if (!byAddress) return refuse(client, undefined, address, port);
      return await forward(client, intake, undefined, [address], port, undefined);
    }
    // An allowed range admits the address whatever it is for, and so does a
    // catch-all when no domain has rules a connection could fall under.
    if (byAddress && (policy.allowsAddress(address) || !policy.hasRules)) {
      return await forward(client, intake, undefined, [address], port, undefined);
    }
    if (!byAddress && policy.recorded.allow.length === 0) {
      return refuse(client, undefined, address, port);
    }
    const deadline =
      Date.now() +
      (byAddress ? Math.min(sniffTimeoutMs, ADMITTED_SNIFF_TIMEOUT_MS) : sniffTimeoutMs);
    let sniffed: Sniffed;
    for (;;) {
      sniffed = sniffServerName(intake.bytes());
      if (sniffed.kind !== "more") break;
      if (!(await intake.more(deadline - Date.now()))) {
        sniffed = { kind: "none" };
        break;
      }
    }
    if (client.destroyed) return;
    if (sniffed.kind !== "name") {
      // Only a catch-all admits a connection that names no domain.
      if (admits(undefined, address)) {
        return await forward(client, intake, undefined, [address], port, undefined);
      }
      return refuse(client, sniffed.kind === "none" ? sniffed.protocol : undefined, address, port);
    }
    const { name, protocol } = sniffed;
    if (policy.kind !== "allow-list" || !policy.allowsDomain(name)) {
      return refuse(client, protocol, name, port);
    }
    const ruled = intercepts(name);
    if (!ruled && admits(undefined, address)) {
      return await forward(client, intake, name, [address], port, protocol);
    }
    // The name is resolved here and the connection goes to one of these
    // addresses, not to the one the program chose: a program cannot reach an
    // address of its choosing by naming an allowed domain in its handshake.
    let resolved: readonly string[];
    try {
      resolved = (await lookup(name)).map(normalizeAddress);
    } catch {
      resolved = [];
    }
    const allowed = resolved.filter((candidate) => admits(name, candidate));
    if (allowed.length === 0) return refuse(client, protocol, name, port);
    const ordered = allowed.includes(address)
      ? [address, ...allowed.filter((candidate) => candidate !== address)]
      : allowed;
    if (!ruled) return await forward(client, intake, name, ordered, port, protocol);
    if (protocol !== "tls") {
      // A rule sets credentials, which do not go out over a connection anyone can read.
      return refuse(
        client,
        protocol,
        name,
        port,
        `the network policy has rules for ${name}, which is reachable over TLS only`,
      );
    }
    await intercept(client, intake, name, ordered, port);
  }

  async function serveDns(client: Socket, intake: Intake) {
    for (;;) {
      const held = intake.bytes();
      if (held.length >= 2 && held.length >= 2 + held.readUInt16BE(0)) break;
      if (!(await intake.more(HEADER_TIMEOUT_MS))) return client.destroy();
    }
    const query = Buffer.from(intake.take(2 + intake.bytes().readUInt16BE(0)).subarray(2));
    const question = parseDnsQuestion(query);
    if (question === null) return client.destroy();
    let answer: Buffer;
    if (!resolves(question.name)) {
      report(question.name, 53);
      answer = answerDnsQuery(query, question.end, DNS_NAME_ERROR);
    } else {
      try {
        answer = await resolveDns(query);
      } catch {
        answer = answerDnsQuery(query, question.end, DNS_SERVER_FAILURE);
      }
    }
    const frame = Buffer.alloc(2 + answer.length);
    frame.writeUInt16BE(answer.length, 0);
    answer.copy(frame, 2);
    client.end(frame, () => client.destroy());
  }

  /**
   * One relayed connection. The capture helper opens it with a line saying
   * what it carries: `T <address> <port>` for a TCP connection a sandboxed
   * program made to that destination, or `D` for one DNS query, which follows
   * with a two-byte length as it would over TCP.
   */
  async function serve(client: Socket) {
    const intake = createIntake(client);
    let line: string;
    for (;;) {
      const end = intake.bytes().indexOf(0x0a);
      if (end !== -1) {
        line = intake
          .take(end + 1)
          .toString("latin1")
          .trimEnd();
        break;
      }
      if (intake.bytes().length > 256 || !(await intake.more(HEADER_TIMEOUT_MS))) {
        return client.destroy();
      }
    }
    if (line === "D") return await serveDns(client, intake);
    const target = /^T (\S+) (\d{1,5})$/.exec(line);
    if (target === null || isIP(target[1]!) === 0) return client.destroy();
    await serveTcp(client, intake, normalizeAddress(target[1]!), Number(target[2]));
  }

  const server = createServer({ allowHalfOpen: true }, (client) => {
    relayed.add(client);
    client.on("error", () => {});
    client.once("close", () => relayed.delete(client));
    void serve(client).catch(() => client.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rm(socketDir, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
  // The gateway lives as long as its sandbox, which must not keep the host alive.
  server.unref();

  return {
    socketPath,
    setPolicy(next) {
      policy = next;
      for (const connection of open) {
        if (!connection.allowed()) connection.close();
      }
    },
    async close() {
      for (const connection of open) connection.close();
      interceptor.close();
      for (const client of relayed) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketDir, { force: true, recursive: true });
    },
  };
}
