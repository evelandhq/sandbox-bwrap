import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, rootCertificates, TLSSocket, type SecureContext } from "node:tls";
import type { EgressAuthority } from "./authority.js";
import type { ResolvedNetworkRule } from "./network-policy.js";

/** Where an intercepted connection was going. */
export interface InterceptedDestination {
  /** The server name of the program's TLS handshake. */
  readonly name: string;
  readonly port: number;
  /** The addresses the gateway resolved the name to and the policy admits, in the order to try. */
  readonly addresses: readonly string[];
}

export interface InterceptedConnection {
  close(): void;
  /** Settles once the program's side of the connection has closed. */
  readonly closed: Promise<void>;
}

/**
 * Reads the requests of connections to domains that carry rules. It answers
 * the program's TLS handshake with a certificate the sandbox's authority
 * issues for the name the program asked for, applies the rules to each
 * HTTP/1.1 request, and sends it on over a TLS connection of its own, whose
 * certificate it verifies as any client would.
 */
export interface EgressInterceptor {
  /**
   * Takes over a connection that has sent `head`, the start of its TLS
   * handshake, and nothing has answered yet. Rejects, leaving the connection
   * to the caller, when no certificate can be issued for the name.
   */
  accept(
    client: Socket,
    head: Buffer,
    destination: InterceptedDestination,
  ): Promise<InterceptedConnection>;
  close(): void;
}

export interface CreateEgressInterceptorInput {
  readonly authority: () => Promise<EgressAuthority>;
  /** The rules that currently apply to requests for `name`. */
  readonly rulesFor: (name: string) => readonly ResolvedNetworkRule[];
  /** Authorities trusted for a destination's certificate besides the host's own, PEM. */
  readonly upstreamRoots?: readonly string[];
}

/** Secure contexts kept before the oldest is dropped, under a `*` that carries rules. */
const MAX_CONTEXTS = 256;

interface Interception extends InterceptedDestination {
  readonly agent: Agent;
  readonly lookup: LookupFunction;
}

/** A resolver that answers with the addresses the gateway already chose, whatever is asked. */
function fixedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_host: string, options: unknown, callback?: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (
      error: Error | null,
      address: unknown,
      family?: number,
    ) => void;
    const all = typeof options === "object" && options !== null && "all" in options && options.all;
    if (all) done(null, entries);
    else done(null, entries[0]!.address, entries[0]!.family);
  }) as LookupFunction;
}

/** `rawHeaders` as pairs, the form rules match on and are applied to. */
function headerPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index]!, raw[index + 1]!]);
  }
  return pairs;
}

/** Whether a `Host` header names the server the connection was made to. */
function namesDestination(host: string, destination: InterceptedDestination): boolean {
  const written = host.trim().toLowerCase();
  const port = /:(\d+)$/.exec(written);
  if (port !== null && Number(port[1]) !== destination.port) return false;
  const name = (port === null ? written : written.slice(0, port.index)).replace(/\.$/, "");
  return name === destination.name;
}

function statusText(response: IncomingMessage): string {
  return `HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}\r\n`;
}

export function createEgressInterceptor(input: CreateEgressInterceptorInput): EgressInterceptor {
  const interceptions = new WeakMap<Duplex, Interception>();
  const sockets = new Set<Duplex>();
  const contexts = new Map<string, Promise<SecureContext>>();

  function contextFor(name: string): Promise<SecureContext> {
    let pending = contexts.get(name);
    if (pending === undefined) {
      pending = (async () => {
        const issued = await (await input.authority()).issue(name);
        return createSecureContext({ cert: issued.certificate, key: issued.key });
      })();
      contexts.set(name, pending);
      pending.catch(() => {
        if (contexts.get(name) === pending) contexts.delete(name);
      });
      if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
    }
    return pending;
  }

  /**
   * What is wrong with a request before any rule is looked at, or null.
   *
   * The request is sent to the server the handshake named. A `Host` that
   * names another would let a program have a credential, set for one domain,
   * delivered to a different site served from the same address.
   */
  function problem(request: IncomingMessage, interception: Interception): [number, string] | null {
    const target = request.url ?? "";
    if (!target.startsWith("/") && target !== "*") {
      return [400, "the request target must be a path"];
    }
    const hosts = headerPairs(request.rawHeaders).filter(([name]) => name.toLowerCase() === "host");
    if (hosts.length !== 1 || !namesDestination(hosts[0]![1], interception)) {
      return [421, `the connection is to ${interception.name} and the request names another host`];
    }
    return null;
  }

  /**
   * The headers to send on: the program's own, in its order and spelling,
   * with those of the first matching rule set over them.
   */
  function outgoingHeaders(request: IncomingMessage, interception: Interception): string[] {
    const received = headerPairs(request.rawHeaders);
    const rule = input.rulesFor(interception.name).find((candidate) =>
      candidate.matches({
        method: request.method ?? "",
        target: request.url ?? "",
        headers: received,
      }),
    );
    // `Expect` was answered here: the request reaches this code only after Node has sent `100 Continue`.
    let headers = received.filter(([name]) => name.toLowerCase() !== "expect");
    for (const [name, value] of rule?.headers ?? []) {
      headers = headers.filter(([existing]) => existing.toLowerCase() !== name);
      headers.push([name, value]);
    }
    return headers.flat();
  }

  function upstreamOptions(
    request: IncomingMessage,
    interception: Interception,
    agent: Agent | false,
  ): RequestOptions {
    return {
      host: interception.name,
      servername: interception.name,
      port: interception.port,
      method: request.method,
      path: request.url,
      // The raw form keeps order, spelling, and repeats; Node adds no `Host` of its own to it.
      headers: outgoingHeaders(request, interception) as unknown as OutgoingHttpHeaders,
      setHost: false,
      agent,
      lookup: interception.lookup,
      // Naming authorities replaces Node's own roots, so those are named again.
      ...(input.upstreamRoots === undefined
        ? {}
        : { ca: [...rootCertificates, ...input.upstreamRoots] }),
    };
  }

  function answer(response: ServerResponse, status: number, reason: string) {
    const body = `bwrap sandbox: ${reason}\n`;
    response.writeHead(status, {
      "content-type": "text/plain",
      "content-length": Buffer.byteLength(body),
      connection: "close",
    });
    response.end(body);
  }

  function onRequest(request: IncomingMessage, response: ServerResponse) {
    const interception = interceptions.get(request.socket);
    if (interception === undefined) return void request.socket.destroy();
    const wrong = problem(request, interception);
    if (wrong !== null) {
      request.resume();
      return answer(response, wrong[0], wrong[1]);
    }
    const upstream = httpsRequest(upstreamOptions(request, interception, interception.agent));
    upstream.on("response", (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.rawHeaders);
      reply.on("error", () => request.socket.destroy());
      reply.pipe(response);
    });
    upstream.on("error", (error) => {
      // Past the head, the only honest answer is a response that ends short.
      if (response.headersSent) return void request.socket.destroy();
      answer(response, 502, `cannot reach ${interception.name}: ${error.message}`);
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    const hasBody =
      request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined;
    if (hasBody) request.pipe(upstream);
    else upstream.end();
  }

  /** A request to switch protocols, a WebSocket's opening: the two sides are joined once the server agrees. */
  function onUpgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    const interception = interceptions.get(request.socket);
    if (interception === undefined) return void client.destroy();
    const wrong = problem(request, interception);
    if (wrong !== null) {
      return void client.end(
        `HTTP/1.1 ${wrong[0]} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
    // A connection of its own: it stops being HTTP and cannot go back to the pool.
    const upstream = httpsRequest(upstreamOptions(request, interception, false));
    const lines = (raw: readonly string[]) =>
      headerPairs(raw)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
    upstream.on("upgrade", (reply, server, serverHead) => {
      client.write(`${statusText(reply)}${lines(reply.rawHeaders)}\r\n`);
      if (serverHead.length > 0) client.write(serverHead);
      if (head.length > 0) server.write(head);
      server.on("error", () => client.destroy());
      server.once("close", () => client.destroy());
      client.once("close", () => server.destroy());
      server.pipe(client);
      client.pipe(server);
    });
    upstream.on("response", (reply) => {
      // The server answered as plain HTTP. The body arrives decoded, so the
      // headers that framed it are replaced by closing the connection after it.
      const framing = new Set(["connection", "content-length", "transfer-encoding", "keep-alive"]);
      const kept = headerPairs(reply.rawHeaders).filter(
        ([name]) => !framing.has(name.toLowerCase()),
      );
      client.write(`${statusText(reply)}${lines(kept.flat())}Connection: close\r\n\r\n`);
      reply.on("error", () => client.destroy());
      reply.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.end();
  }

  // Never listens: connections are handed to it once their handshake is under
  // way. A connection is the program's to keep open, as it would be with the
  // server itself, so no idle or request timeout ends it.
  const server = createServer({ keepAliveTimeout: 0, requestTimeout: 0 });
  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);

  return {
    async accept(client, head, destination) {
      const secureContext = await contextFor(destination.name);
      if (client.destroyed) throw new Error("the connection closed");
      // Only HTTP/1.1 is offered, so a program that would speak HTTP/2 falls
      // back to it and one that speaks nothing else fails its handshake.
      client.unshift(head);
      const secured = new TLSSocket(client, {
        isServer: true,
        secureContext,
        ALPNProtocols: ["http/1.1"],
      });
      const agent = new Agent({ keepAlive: true });
      interceptions.set(secured, {
        ...destination,
        agent,
        lookup: fixedLookup(destination.addresses),
      });
      sockets.add(secured);
      const closed = new Promise<void>((resolve) => {
        secured.once("close", () => {
          sockets.delete(secured);
          agent.destroy();
          client.destroy();
          resolve();
        });
      });
      secured.on("error", () => {});
      server.emit("connection", secured);
      return { close: () => secured.destroy(), closed };
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
    },
  };
}
