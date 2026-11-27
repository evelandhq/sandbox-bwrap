import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { ResolvedNetworkPolicy } from "./network-policy.js";

/** Resolves a host name to its addresses, in the order to try them. */
export type EgressLookup = (host: string) => Promise<readonly string[]>;

/** A destination the policy turned away. Never carries a path, a header, or a body. */
export interface EgressDenial {
  readonly host: string;
  readonly port: number;
}

/**
 * The only way out of a sandbox whose network is denied: an HTTP proxy in the
 * host process, listening on a Unix socket that is bound into the sandbox.
 * It serves `CONNECT` tunnels and plain HTTP requests and opens a connection
 * only to a destination the current policy allows. The sandbox has no route
 * of its own, so a program that does not use the proxy reaches nothing.
 */
export interface EgressProxy {
  /** Host directory holding the socket; bound read-only into the sandbox. */
  readonly socketDir: string;
  /** File name of the socket inside `socketDir`. */
  readonly socketName: string;
  /**
   * Replaces the policy. It applies to connections already open as well: one
   * whose destination the new policy does not allow is closed.
   */
  setPolicy(policy: ResolvedNetworkPolicy): void;
  close(): Promise<void>;
}

export interface StartEgressProxyInput {
  readonly policy: ResolvedNetworkPolicy;
  readonly lookup?: EgressLookup;
  readonly onDenied?: (denial: EgressDenial) => void;
}

const SOCKET_NAME = "proxy.sock";

/** How long one address may take to accept before the next one is tried. */
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;

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
        const attempt = connect({ host: address, port });
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

/** Headers that address the proxy itself and must not reach the destination. */
const PROXY_HEADERS = new Set(["proxy-connection", "proxy-authorization"]);

const systemLookup: EgressLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(authority);
  if (match === null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: (match[1] ?? match[2])!, port };
}

export async function startEgressProxy(input: StartEgressProxyInput): Promise<EgressProxy> {
  const lookup = input.lookup ?? systemLookup;
  let policy = input.policy;
  // A short path of its own: a Unix socket path is limited to about 100
  // bytes, which a path under a deep cache directory can exceed.
  const socketDir = await mkdtemp(path.join(os.tmpdir(), "bwrap-egress-"));
  const open = new Set<{ host: string; address: string; close(): void }>();

  /** Whether an open connection to `address`, reached as `host`, may stay. */
  function allows(host: string, address: string): boolean {
    if (policy.kind !== "allow-list") return policy.kind === "allow-all";
    if (policy.deniesAddress(address)) return false;
    return (isIP(host) === 0 && policy.allowsDomain(host)) || policy.allowsAddress(address);
  }

  /**
   * The addresses `host` may be reached at, in the order to try them; empty
   * when the policy allows none. The name is resolved here, once, and the
   * connection goes to one of these addresses, so a name cannot be allowed
   * as one address and reached as another.
   */
  async function authorize(host: string): Promise<readonly string[]> {
    if (policy.kind === "deny-all") return [];
    if (isIP(host) !== 0) return allows(host, host) ? [host] : [];
    if (policy.kind === "allow-list" && !policy.allowsDomain(host)) {
      // An address range can still admit it, so the name has to be resolved.
      if (policy.recorded.subnets?.allow === undefined) return [];
    }
    let addresses: readonly string[];
    try {
      addresses = await lookup(host);
    } catch {
      return [];
    }
    return addresses.filter((address) => allows(host, address));
  }

  function deny(host: string, port: number) {
    try {
      input.onDenied?.({ host, port });
    } catch {
      // Reporting is best effort and never changes what the proxy decided.
    }
    return `bwrap sandbox: the network policy does not allow ${host}\n`;
  }

  function track(host: string, address: string, close: () => void): () => void {
    const entry = { host, address, close };
    open.add(entry);
    return () => void open.delete(entry);
  }

  async function tunnel(req: IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => {});
    const refuse = (status: string, body: string) =>
      client.end(
        `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    const target = parseAuthority(req.url ?? "");
    if (target === null)
      return refuse("400 Bad Request", "bwrap sandbox: malformed CONNECT target\n");
    const addresses = await authorize(target.host);
    if (addresses.length === 0) return refuse("403 Forbidden", deny(target.host, target.port));
    let upstream: Socket;
    let address: string;
    try {
      ({ socket: upstream, address } = await connectAny(addresses, target.port));
    } catch (error) {
      return refuse(
        "502 Bad Gateway",
        `bwrap sandbox: cannot reach ${target.host}: ${(error as Error).message}\n`,
      );
    }
    // The policy may have changed while the connection was being made.
    if (client.destroyed || !allows(target.host, address)) {
      upstream.destroy();
      return client.destroy();
    }
    const untrack = track(target.host, address, () => {
      upstream.destroy();
      client.destroy();
    });
    upstream.on("error", () => {});
    upstream.once("close", () => {
      untrack();
      client.destroy();
    });
    client.once("close", () => upstream.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  const server = createServer((req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
        if (url.protocol !== "http:") throw new Error("not http");
      } catch {
        res.writeHead(400, { "content-type": "text/plain", connection: "close" });
        return res.end("bwrap sandbox: the proxy takes absolute http:// URLs and CONNECT\n");
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const port = url.port === "" ? 80 : Number(url.port);
      const addresses = await authorize(host);
      if (addresses.length === 0) {
        res.writeHead(403, { "content-type": "text/plain", connection: "close" });
        return res.end(deny(host, port));
      }
      let socket: Socket;
      let address: string;
      try {
        ({ socket, address } = await connectAny(addresses, port));
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain", connection: "close" });
        return res.end(`bwrap sandbox: cannot reach ${host}: ${(error as Error).message}\n`);
      }
      if (res.destroyed || !allows(host, address)) {
        socket.destroy();
        return res.destroy();
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !PROXY_HEADERS.has(name)),
      );
      const upstream = httpRequest({
        createConnection: () => socket,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, connection: "close" },
        setHost: false,
      });
      const untrack = track(host, address, () => {
        upstream.destroy();
        socket.destroy();
        res.destroy();
      });
      upstream.once("response", (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.once("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain", connection: "close" });
          res.end(`bwrap sandbox: cannot reach ${host}: ${error.message}\n`);
        } else {
          res.destroy();
        }
      });
      upstream.once("close", () => {
        untrack();
        socket.destroy();
      });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream);
    })();
  });
  server.on("connect", (req, client, head) => void tunnel(req, client, head));
  server.on("clientError", (_error, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(socketDir, SOCKET_NAME), resolve);
    });
  } catch (error) {
    await rm(socketDir, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
  // The proxy lives as long as its sandbox, which must not keep the host alive.
  server.unref();

  return {
    socketDir,
    socketName: SOCKET_NAME,
    setPolicy(next) {
      policy = next;
      for (const connection of open) {
        if (!allows(connection.host, connection.address)) connection.close();
      }
    },
    async close() {
      for (const connection of open) connection.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketDir, { force: true, recursive: true });
    },
  };
}
