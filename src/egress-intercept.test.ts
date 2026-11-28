import { spawnSync } from "node:child_process";
import { Agent, createServer, request, type RequestOptions } from "node:https";
import { connect as netConnect, type AddressInfo } from "node:net";
import os from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createEgressAuthority, type EgressAuthority } from "./authority.js";
import { startEgressGateway, type EgressDenial, type EgressGateway } from "./egress-gateway.js";
import { resolveNetworkPolicy } from "./network-policy.js";
import { createNodeProcessRunner } from "./process.js";

/**
 * These tests answer real TLS handshakes with certificates a real `openssl`
 * issued, so they need the OpenSSL 3 the provider itself needs for rules.
 */
const opensslVersion = /^OpenSSL (\d+)\./.exec(
  spawnSync("openssl", ["version"], { encoding: "utf8" }).stdout ?? "",
);
const canIssue = opensslVersion !== null && Number(opensslVersion[1]) >= 3;

const NAME = "api.rules.test";

/** An address the program might have picked; the gateway resolves the name itself. */
const ELSEWHERE = "203.0.113.7";

/** Loopback is host-local, so the destination these tests reach there is allowed by range. */
const LOOPBACK = { allow: ["127.0.0.1/32"] };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface SeenRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: readonly string[];
  readonly body: string;
}

describe.skipIf(!canIssue)("egress gateway: domains with rules", () => {
  /** The sandbox's authority, and one standing in for the public authorities a host trusts. */
  let sandboxAuthority: EgressAuthority;
  let publicAuthority: EgressAuthority;

  beforeAll(async () => {
    const runner = createNodeProcessRunner();
    sandboxAuthority = await createEgressAuthority({ runner, opensslPath: "openssl" });
    publicAuthority = await createEgressAuthority({ runner, opensslPath: "openssl" });
  });
  afterAll(async () => {
    await sandboxAuthority?.close();
    await publicAuthority?.close();
  });

  /** The real service: an HTTPS server holding a certificate for `name`. */
  async function service(name = NAME, host = "127.0.0.1") {
    const issued = await publicAuthority.issue(name);
    const seen: SeenRequest[] = [];
    const server = createServer(
      { cert: issued.certificate, key: issued.key },
      (incoming, reply) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          seen.push({
            method: incoming.method ?? "",
            target: incoming.url ?? "",
            headers: incoming.rawHeaders,
            body,
          });
          if (incoming.url === "/stream") {
            reply.writeHead(200, { "content-type": "text/plain" });
            reply.write("one,");
            setTimeout(() => reply.end("two"), 20);
          } else if (incoming.url === "/missing") {
            reply.writeHead(404, "Nowhere", { "x-reason": "absent", "set-cookie": ["a=1", "b=2"] });
            reply.end("no such thing");
          } else {
            reply.writeHead(200, { "content-type": "text/plain" });
            reply.end(`echo:${body}`);
          }
        });
      },
    );
    server.on("upgrade", (incoming, socket) => {
      seen.push({
        method: incoming.method ?? "",
        target: incoming.url ?? "",
        headers: incoming.rawHeaders,
        body: "",
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (chunk: Buffer) => socket.write(`back:${chunk.toString()}`));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port: (server.address() as AddressInfo).port, seen };
  }

  async function gatewayWith(policy: unknown, options: { authority?: boolean } = {}) {
    const denied: EgressDenial[] = [];
    const gateway = await startEgressGateway({
      policy: resolveNetworkPolicy(policy),
      lookup: async (host) => {
        if (host.endsWith(".test")) return ["127.0.0.1"];
        throw new Error(`no such host ${host}`);
      },
      onDenied: (denial) => denied.push(denial),
      upstreamRoots: [publicAuthority.certificate],
      ...(options.authority === false ? {} : { authority: async () => sandboxAuthority }),
    });
    cleanups.push(() => gateway.close());
    return { gateway, denied };
  }

  /**
   * A TLS connection as a sandboxed program makes it: relayed the way the
   * capture helper does, to an address of the program's choosing, trusting
   * the host's roots and the sandbox's authority.
   */
  function dial(
    gateway: EgressGateway,
    port: number,
    name = NAME,
    protocols: string[] = ["http/1.1"],
    address = ELSEWHERE,
  ): TLSSocket {
    const raw = netConnect({ path: gateway.socketPath });
    raw.write(`T ${address} ${port}\n`);
    const secured = tlsConnect({
      socket: raw,
      servername: name,
      ca: [sandboxAuthority.certificate],
      ALPNProtocols: protocols,
    });
    cleanups.push(() => void secured.destroy());
    return secured;
  }

  /** An agent whose connections are the sandboxed program's. */
  function program(gateway: EgressGateway, port: number) {
    const dialed: TLSSocket[] = [];
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => {
      const socket = dial(gateway, port);
      dialed.push(socket);
      return socket;
    };
    cleanups.push(() => agent.destroy());
    return { agent, dialed };
  }

  function send(
    agent: Agent,
    port: number,
    options: RequestOptions & { body?: string | string[] } = {},
  ) {
    const { body, ...rest } = options;
    return new Promise<{
      status: number;
      message: string;
      headers: readonly string[];
      body: string;
    }>((resolve, reject) => {
      const outgoing = request({ agent, host: NAME, port, path: "/", ...rest }, (reply) => {
        const chunks: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("error", reject);
        reply.on("end", () =>
          resolve({
            status: reply.statusCode ?? 0,
            message: reply.statusMessage ?? "",
            headers: reply.rawHeaders,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      outgoing.on("error", reject);
      // A list is sent piece by piece, which Node frames as chunks.
      if (Array.isArray(body)) for (const piece of body) outgoing.write(piece);
      outgoing.end(typeof body === "string" ? body : undefined);
    });
  }

  const header = (headers: readonly string[], name: string) =>
    headers.flatMap((entry, index) =>
      index % 2 === 0 && entry.toLowerCase() === name ? [headers[index + 1]!] : [],
    );

  /** eve's own shape: swap a placeholder the sandbox holds for the credential it must not. */
  const lease = {
    allow: {
      [NAME]: [
        {
          match: {
            headers: [{ key: { exact: "authorization" }, value: { exact: "Bearer placeholder" } }],
          },
          transform: [{ headers: { authorization: "Bearer real-token" } }],
        },
      ],
    },
    subnets: LOOPBACK,
  };

  test("a matching request reaches the service with the rule's header in place of its own", async () => {
    const target = await service();
    const { gateway, denied } = await gatewayWith(lease);
    const { agent } = program(gateway, target.port);

    const reply = await send(agent, target.port, {
      method: "POST",
      path: "/repos/eve?per_page=2",
      headers: {
        Authorization: "Bearer placeholder",
        "X-Trace": "abc",
        "content-type": "text/plain",
      },
      body: "payload",
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toBe("echo:payload");
    expect(target.seen).toHaveLength(1);
    const [seen] = target.seen;
    expect(seen!.method).toBe("POST");
    expect(seen!.target).toBe("/repos/eve?per_page=2");
    expect(seen!.body).toBe("payload");
    expect(header(seen!.headers, "authorization")).toEqual(["Bearer real-token"]);
    expect(header(seen!.headers, "x-trace")).toEqual(["abc"]);
    expect(header(seen!.headers, "host")).toEqual([`${NAME}:${target.port}`]);
    expect(denied).toEqual([]);
  });

  test("a request no rule matches goes out as the program sent it", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);
    const { agent } = program(gateway, target.port);

    await send(agent, target.port, { headers: { authorization: "Bearer something-else" } });
    await send(agent, target.port);

    expect(header(target.seen[0]!.headers, "authorization")).toEqual(["Bearer something-else"]);
    expect(header(target.seen[1]!.headers, "authorization")).toEqual([]);
  });

  test("a rule without a match sets its headers on every request, adding one the program did not send", async () => {
    const target = await service();
    const { gateway } = await gatewayWith({
      allow: { [NAME]: [{ transform: [{ headers: { Authorization: "Basic injected" } }] }] },
      subnets: LOOPBACK,
    });
    const { agent } = program(gateway, target.port);

    await send(agent, target.port, { path: "/info/refs?service=git-upload-pack" });

    expect(header(target.seen[0]!.headers, "authorization")).toEqual(["Basic injected"]);
  });

  test("the first matching rule handles the request, and only that one", async () => {
    const target = await service();
    const { gateway } = await gatewayWith({
      allow: {
        [NAME]: [
          {
            match: { path: { startsWith: "/v1/" } },
            transform: [{ headers: { "x-rule": "first" } }],
          },
          { transform: [{ headers: { "x-rule": "second", "x-also": "second" } }] },
        ],
      },
      subnets: LOOPBACK,
    });
    const { agent } = program(gateway, target.port);

    await send(agent, target.port, { path: "/v1/items" });
    await send(agent, target.port, { path: "/v2/items" });

    expect(header(target.seen[0]!.headers, "x-rule")).toEqual(["first"]);
    expect(header(target.seen[0]!.headers, "x-also")).toEqual([]);
    expect(header(target.seen[1]!.headers, "x-rule")).toEqual(["second"]);
  });

  test("bodies and responses pass through whole, however they are framed", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);
    const { agent } = program(gateway, target.port);

    const chunked = await send(agent, target.port, { method: "PUT", body: ["first,", "second"] });
    const streamed = await send(agent, target.port, { path: "/stream" });
    const missing = await send(agent, target.port, { path: "/missing" });
    const head = await send(agent, target.port, { method: "HEAD" });

    expect(chunked.body).toBe("echo:first,second");
    expect(header(target.seen[0]!.headers, "transfer-encoding")).toEqual(["chunked"]);
    expect(streamed.body).toBe("one,two");
    expect(missing.status).toBe(404);
    expect(missing.message).toBe("Nowhere");
    expect(missing.body).toBe("no such thing");
    expect(header(missing.headers, "x-reason")).toEqual(["absent"]);
    expect(header(missing.headers, "set-cookie")).toEqual(["a=1", "b=2"]);
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  test("requests on one connection each get the rules of the moment", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);
    const { agent, dialed } = program(gateway, target.port);
    const placeholder = { headers: { authorization: "Bearer placeholder" } };

    await send(agent, target.port, placeholder);
    gateway.setPolicy(
      resolveNetworkPolicy({
        ...lease,
        allow: { [NAME]: [{ transform: [{ headers: { authorization: "Bearer rotated" } }] }] },
      }),
    );
    await send(agent, target.port, placeholder);

    expect(dialed).toHaveLength(1);
    expect(target.seen.map((seen) => header(seen.headers, "authorization")[0])).toEqual([
      "Bearer real-token",
      "Bearer rotated",
    ]);
  });

  /**
   * A credential is set for one domain. A request that names another host on
   * a connection to that domain could be routed, at a shared front end, to a
   * site the credential was never meant for.
   */
  test("a request that names another host is refused before any rule applies", async () => {
    const target = await service();
    const { gateway } = await gatewayWith({
      allow: { [NAME]: [{ transform: [{ headers: { authorization: "Bearer real-token" } }] }] },
      subnets: LOOPBACK,
    });
    const { agent } = program(gateway, target.port);

    const other = await send(agent, target.port, { headers: { host: "attacker.test" } });
    const otherPort = await send(agent, target.port, { headers: { host: `${NAME}:1` } });
    const bare = await send(agent, target.port, { headers: { host: NAME.toUpperCase() } });

    expect(other.status).toBe(421);
    expect(other.body).toMatch(/the request names another host/);
    expect(otherPort.status).toBe(421);
    expect(bare.status).toBe(200);
    expect(target.seen).toHaveLength(1);
  });

  test("a domain with rules is reachable over TLS only", async () => {
    const target = await service();
    const { gateway, denied } = await gatewayWith(lease);

    const raw = netConnect({ path: gateway.socketPath });
    cleanups.push(() => void raw.destroy());
    const chunks: Buffer[] = [];
    raw.on("data", (chunk: Buffer) => chunks.push(chunk));
    raw.write(
      `T ${ELSEWHERE} ${target.port}\nGET / HTTP/1.1\r\nHost: ${NAME}\r\nAuthorization: Bearer placeholder\r\n\r\n`,
    );
    await new Promise((resolve) => raw.once("close", resolve));

    expect(Buffer.concat(chunks).toString()).toMatch(
      /^HTTP\/1\.1 403 Forbidden\r\n[\s\S]*has rules for api\.rules\.test, which is reachable over TLS only\n$/,
    );
    expect(denied).toEqual([{ host: NAME, port: target.port }]);
    expect(target.seen).toEqual([]);
  });

  test("the handshake settles on HTTP/1.1, and fails for a program that speaks only HTTP/2", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);

    const both = dial(gateway, target.port, NAME, ["h2", "http/1.1"]);
    await new Promise<void>((resolve, reject) => {
      both.once("secureConnect", resolve);
      both.once("error", reject);
    });
    expect(both.alpnProtocol).toBe("http/1.1");
    expect(both.authorized).toBe(true);
    expect(both.getPeerCertificate().subjectaltname).toBe(`DNS:${NAME}`);

    const only = dial(gateway, target.port, NAME, ["h2"]);
    await expect(
      new Promise<void>((resolve, reject) => {
        only.once("secureConnect", resolve);
        only.once("error", reject);
      }),
    ).rejects.toThrow(/no application protocol|alert/i);
  });

  test("the service's own certificate is verified: one the host does not trust is a 502", async () => {
    const target = await service();
    const denied: EgressDenial[] = [];
    const gateway = await startEgressGateway({
      policy: resolveNetworkPolicy(lease),
      lookup: async () => ["127.0.0.1"],
      onDenied: (denial) => denied.push(denial),
      authority: async () => sandboxAuthority,
      // No upstreamRoots: the test service's authority is unknown to the host.
    });
    cleanups.push(() => gateway.close());
    const { agent } = program(gateway, target.port);

    const reply = await send(agent, target.port, {
      headers: { authorization: "Bearer placeholder" },
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toMatch(/^bwrap sandbox: cannot reach api\.rules\.test: /);
    expect(target.seen).toEqual([]);
  });

  test("a switch of protocols is joined through, with the rule applied to its opening request", async () => {
    const target = await service();
    const { gateway } = await gatewayWith({
      allow: { [NAME]: [{ transform: [{ headers: { authorization: "Bearer real-token" } }] }] },
      subnets: LOOPBACK,
    });

    const socket = dial(gateway, target.port);
    const chunks: string[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: ${NAME}:${target.port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    );
    await expect.poll(() => chunks.join("")).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r\n/);
    socket.write("ping");
    await expect.poll(() => chunks.join("")).toMatch(/back:ping$/);

    expect(header(target.seen[0]!.headers, "authorization")).toEqual(["Bearer real-token"]);
    expect(header(target.seen[0]!.headers, "upgrade")).toEqual(["test"]);
  });

  test("taking a domain's rules away closes the connections that were answered under them", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);
    const { agent, dialed } = program(gateway, target.port);
    await send(agent, target.port);
    const closed = new Promise((resolve) => dialed[0]!.once("close", resolve));

    gateway.setPolicy(resolveNetworkPolicy({ allow: [NAME], subnets: LOOPBACK }));

    await closed;
  });

  test("giving a domain rules closes the connections passed on before it had any", async () => {
    const target = await service();
    const { gateway } = await gatewayWith({ allow: [NAME], subnets: LOOPBACK });
    // Passed through untouched: the program sees the service's own certificate.
    const raw = netConnect({ path: gateway.socketPath });
    raw.write(`T ${ELSEWHERE} ${target.port}\n`);
    const direct = tlsConnect({ socket: raw, servername: NAME, ca: [publicAuthority.certificate] });
    cleanups.push(() => void direct.destroy());
    direct.on("error", () => {});
    await new Promise((resolve) => direct.once("secureConnect", resolve));
    const closed = new Promise((resolve) => direct.once("close", resolve));

    gateway.setPolicy(resolveNetworkPolicy(lease));

    await closed;
  });

  /** An address of this host that is not host-local, which a catch-all admits. */
  const outward = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

  /** eve's git broker writes exactly this: a catch-all beside domains that carry credentials. */
  test.skipIf(outward === undefined)(
    "beside a catch-all, a domain with rules is still answered here and others are passed on",
    async () => {
      const target = await service();
      const other = await service("other.rules.test", "0.0.0.0");
      const { gateway } = await gatewayWith({
        allow: {
          "*": [],
          [NAME]: [{ transform: [{ headers: { authorization: "Basic injected" } }] }],
        },
        subnets: LOOPBACK,
      });
      const { agent } = program(gateway, target.port);

      await send(agent, target.port);
      expect(header(target.seen[0]!.headers, "authorization")).toEqual(["Basic injected"]);

      // Another domain keeps its own certificate, which the sandbox authority did not issue.
      const raw = netConnect({ path: gateway.socketPath });
      raw.write(`T ${outward} ${other.port}\n`);
      const direct = tlsConnect({
        socket: raw,
        servername: "other.rules.test",
        ca: [publicAuthority.certificate],
      });
      cleanups.push(() => void direct.destroy());
      await new Promise<void>((resolve, reject) => {
        direct.once("secureConnect", resolve);
        direct.once("error", reject);
      });
      expect(direct.authorized).toBe(true);
    },
  );

  /** A protocol in which the server speaks first names no domain, and must not wait long for that. */
  test.skipIf(outward === undefined)(
    "beside a catch-all, a connection that names no domain is passed on after a short wait",
    async () => {
      const target = await service(NAME, "0.0.0.0");
      const { gateway } = await gatewayWith({
        allow: {
          "*": [],
          [NAME]: [{ transform: [{ headers: { authorization: "Basic injected" } }] }],
        },
      });
      const started = Date.now();
      const raw = netConnect({ path: gateway.socketPath });
      cleanups.push(() => void raw.destroy());
      raw.on("error", () => {});
      raw.write(`T ${outward} ${target.port}\n`);
      // Nothing more is sent until the wait is over: the gateway cannot know a domain.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      // Passed on unread, the handshake is the service's own.
      // No server name is sent, so there is none to hold the certificate to.
      const direct = tlsConnect({
        socket: raw,
        ca: [publicAuthority.certificate],
        checkServerIdentity: () => undefined,
      });
      cleanups.push(() => void direct.destroy());
      await new Promise<void>((resolve, reject) => {
        direct.once("secureConnect", resolve);
        direct.once("error", reject);
      });
      expect(direct.getPeerCertificate().subjectaltname).toBe(`DNS:${NAME}`);
      expect(Date.now() - started).toBeLessThan(4_000);
    },
  );

  /** An address range is allowed whatever the traffic is, so nothing on it is read. */
  test("a connection to an allowed address is passed on unread, even for a domain with rules", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease);

    const raw = netConnect({ path: gateway.socketPath });
    raw.write(`T 127.0.0.1 ${target.port}\n`);
    const direct = tlsConnect({ socket: raw, servername: NAME, ca: [publicAuthority.certificate] });
    cleanups.push(() => void direct.destroy());
    await new Promise<void>((resolve, reject) => {
      direct.once("secureConnect", resolve);
      direct.once("error", reject);
    });

    expect(direct.authorized).toBe(true);
  });

  test("without an authority a connection to a domain with rules is refused, not passed on", async () => {
    const target = await service();
    const { gateway } = await gatewayWith(lease, { authority: false });

    const socket = dial(gateway, target.port);
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      }),
    ).rejects.toThrow(/internal error|alert/i);
    expect(target.seen).toEqual([]);
  });
});
