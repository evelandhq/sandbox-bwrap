import { existsSync } from "node:fs";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startEgressGateway, type EgressDenial, type EgressGateway } from "./egress-gateway.js";
import { DNS_NAME_ERROR, DNS_SERVER_FAILURE } from "./egress-sniff.js";
import { resolveNetworkPolicy } from "./network-policy.js";
import { clientHello, dnsQuery } from "./provider.test-support.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A destination that records the bytes each connection sent and answers
 * `reply` once it has seen some. With `banner` it speaks first instead.
 */
async function destination(options: { host?: string; port?: number; banner?: string } = {}) {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const index = received.push("") - 1;
    socket.on("error", () => {});
    if (options.banner !== undefined) socket.write(options.banner);
    socket.on("data", (chunk) => {
      received[index] += chunk.toString("latin1");
      if (options.banner === undefined) socket.end(`reached:${received[index]!.length}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received };
}

/** Names that resolve to loopback, so no test needs a real resolver. */
const lookup = async (host: string) => {
  if (host.endsWith(".test")) return ["127.0.0.1"];
  throw new Error(`no such host ${host}`);
};

/** Loopback is host-local, so a test that reaches a destination there allows it by range. */
const LOOPBACK = { allow: ["127.0.0.1/32"] };

async function gatewayWith(policy: unknown, extra: { sniffTimeoutMs?: number } = {}) {
  const denied: EgressDenial[] = [];
  const dnsQueries: Buffer[] = [];
  const gateway = await startEgressGateway({
    policy: resolveNetworkPolicy(policy),
    lookup,
    resolveDns: async (query) => {
      dnsQueries.push(query);
      if (query.includes("broken")) throw new Error("no answer");
      return Buffer.concat([query, Buffer.from("answer")]);
    },
    onDenied: (denial) => denied.push(denial),
    ...extra,
  });
  cleanups.push(() => gateway.close());
  return { gateway, denied, dnsQueries };
}

/**
 * Relays one connection the way the capture helper does: a line naming what
 * the sandboxed program connected to, then the bytes it sent. Resolves with
 * everything the gateway sent back once it closes the connection.
 */
async function relay(
  gateway: EgressGateway,
  header: string,
  payload?: Buffer | string,
  options: { end?: boolean } = {},
) {
  const socket = connect({ path: gateway.socketPath, allowHalfOpen: true });
  socket.on("error", () => {});
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<Buffer>((resolve) =>
    socket.once("close", () => resolve(Buffer.concat(chunks))),
  );
  socket.on("end", () => socket.end());
  socket.write(`${header}\n`);
  if (payload !== undefined) socket.write(payload);
  if (options.end === true) socket.end();
  return { socket, closed, received: () => Buffer.concat(chunks) };
}

const httpGet = (host: string) => `GET /path HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

/** An address the program might have picked that no policy in these tests allows. */
const ELSEWHERE = "203.0.113.7";

describe("egress gateway: connections", () => {
  test("a plain HTTP request to an allowed domain reaches it, byte for byte", async () => {
    const target = await destination();
    const { gateway, denied } = await gatewayWith({ allow: ["allowed.test"], subnets: LOOPBACK });

    const request = httpGet(`allowed.test:${target.port}`);
    const { closed } = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, request);

    expect((await closed).toString()).toBe(`reached:${request.length}`);
    expect(target.received).toEqual([request]);
    expect(denied).toEqual([]);
  });

  test("a TLS handshake for an allowed domain is passed through undecrypted", async () => {
    const target = await destination();
    const { gateway } = await gatewayWith({ allow: ["*.allowed.test"], subnets: LOOPBACK });

    const hello = clientHello("api.allowed.test");
    const { closed } = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, hello);

    expect((await closed).toString()).toBe(`reached:${hello.length}`);
    expect(target.received).toEqual([hello.toString("latin1")]);
  });

  test("a domain that is not on the list is refused in the protocol it spoke, and only its name is reported", async () => {
    const target = await destination();
    const { gateway, denied } = await gatewayWith({ allow: ["allowed.test"], subnets: LOOPBACK });

    const http = await relay(
      gateway,
      `T ${ELSEWHERE} ${target.port}`,
      `GET /secret?token=abc HTTP/1.1\r\nHost: other.test\r\nAuthorization: Bearer x\r\n\r\n`,
    );
    expect((await http.closed).toString()).toMatch(
      /^HTTP\/1\.1 403 Forbidden\r\n[\s\S]*the network policy does not allow other\.test\n$/,
    );
    const tls = await relay(gateway, `T ${ELSEWHERE} 443`, clientHello("other.test"));
    // A fatal access_denied alert.
    expect([...(await tls.closed)]).toEqual([0x15, 3, 3, 0, 2, 2, 49]);

    expect(target.received).toEqual([]);
    expect(denied).toEqual([
      { host: "other.test", port: target.port },
      { host: "other.test", port: 443 },
    ]);
  });

  /**
   * The name in a handshake is something the program wrote. The gateway
   * resolves it itself and connects there, so naming an allowed domain while
   * connecting somewhere else reaches only the allowed domain.
   */
  test("a connection goes to the named domain's address, not to the one the program chose", async () => {
    const real = await destination();
    const decoy = await destination({ host: "127.0.0.2", port: real.port });
    const { gateway } = await gatewayWith({ allow: ["allowed.test"], subnets: LOOPBACK });

    const hello = clientHello("allowed.test");
    const { closed } = await relay(gateway, `T 127.0.0.2 ${real.port}`, hello);
    await closed;

    expect(real.received).toEqual([hello.toString("latin1")]);
    expect(decoy.received).toEqual([]);
  });

  /**
   * The gateway connects from the host's network. A domain that resolves to
   * loopback or a link-local address would otherwise reach the host's own
   * services, or a cloud metadata endpoint.
   */
  test("an allowed domain that resolves to a host-local address is refused unless a range allows it", async () => {
    const target = await destination();
    const listed = await gatewayWith({ allow: ["allowed.test"] });
    const named = await relay(
      listed.gateway,
      `T ${ELSEWHERE} ${target.port}`,
      clientHello("allowed.test"),
    );
    await named.closed;
    expect(listed.denied).toEqual([{ host: "allowed.test", port: target.port }]);

    // Not even a catch-all reaches them.
    const { gateway, denied } = await gatewayWith({ allow: ["*"] });
    const direct = await relay(gateway, `T 127.0.0.1 ${target.port}`, "hello");
    await direct.closed;
    const metadata = await relay(gateway, `T 169.254.169.254 80`, "hello");
    await metadata.closed;

    expect(target.received).toEqual([]);
    expect(denied).toEqual([
      { host: "127.0.0.1", port: target.port },
      { host: "169.254.169.254", port: 80 },
    ]);
  });

  test("traffic that names no domain is refused by a list of domains", async () => {
    const target = await destination();
    const { gateway, denied } = await gatewayWith({ allow: ["allowed.test"] });

    const { closed } = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, "SSH-2.0-client\r\n");

    expect((await closed).length).toBe(0);
    expect(denied).toEqual([{ host: ELSEWHERE, port: target.port }]);
  });

  test("a connection that never says what it is for is refused once the wait is over", async () => {
    const { gateway, denied } = await gatewayWith(
      { allow: ["allowed.test"] },
      { sniffTimeoutMs: 30 },
    );

    const { closed } = await relay(gateway, `T ${ELSEWHERE} 22`);

    expect((await closed).length).toBe(0);
    expect(denied).toEqual([{ host: ELSEWHERE, port: 22 }]);
  });

  /** A server that speaks first, like SSH, must not have to wait for the client. */
  test("an allowed range is reached by address, without waiting to see a domain", async () => {
    const target = await destination({ banner: "SSH-2.0-server\r\n" });
    const { gateway, denied } = await gatewayWith(
      { subnets: LOOPBACK },
      { sniffTimeoutMs: 60_000 },
    );

    const { socket, received } = await relay(gateway, `T 127.0.0.1 ${target.port}`);
    await expect.poll(() => received().toString()).toBe("SSH-2.0-server\r\n");
    socket.destroy();

    expect(denied).toEqual([]);
  });

  const outward = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

  test.skipIf(outward === undefined)(
    "a catch-all admits traffic that names no domain",
    async () => {
      const target = await destination({ host: "0.0.0.0", banner: "220 ready\r\n" });
      const { gateway, denied } = await gatewayWith({ allow: ["*"] }, { sniffTimeoutMs: 60_000 });

      const { socket, received } = await relay(gateway, `T ${outward} ${target.port}`);
      await expect.poll(() => received().toString()).toBe("220 ready\r\n");
      socket.destroy();

      expect(denied).toEqual([]);
    },
  );

  test("a denied range overrides an allowed domain and an allowed range", async () => {
    const target = await destination();
    const { gateway, denied } = await gatewayWith({
      allow: ["allowed.test"],
      subnets: { allow: ["127.0.0.0/8"], deny: ["127.0.0.1/32"] },
    });

    const named = await relay(
      gateway,
      `T ${ELSEWHERE} ${target.port}`,
      clientHello("allowed.test"),
    );
    await named.closed;
    const direct = await relay(gateway, `T 127.0.0.1 ${target.port}`, "hello");
    await direct.closed;

    expect(target.received).toEqual([]);
    expect(denied.map((denial) => denial.host)).toEqual(["allowed.test", "127.0.0.1"]);
  });

  test("deny-all refuses everything", async () => {
    const target = await destination();
    const { gateway, denied } = await gatewayWith("deny-all");

    const { closed } = await relay(gateway, `T 127.0.0.1 ${target.port}`, httpGet("allowed.test"));
    await closed;

    expect(target.received).toEqual([]);
    expect(denied).toEqual([{ host: "127.0.0.1", port: target.port }]);
  });

  /** A program may finish sending before it reads; the answer must still arrive. */
  test("a client that has finished sending still receives the answer", async () => {
    const target = await destination();
    const { gateway } = await gatewayWith({ allow: ["allowed.test"], subnets: LOOPBACK });

    const request = httpGet("allowed.test");
    const { closed } = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, request, {
      end: true,
    });

    expect((await closed).toString()).toBe(`reached:${request.length}`);
  });

  test("an unreachable destination closes the connection, with a 502 for HTTP", async () => {
    const closedPort = (await destination()).port;
    // Close it, so the port is one nothing listens on.
    for (const cleanup of cleanups.splice(0)) await cleanup();
    const { gateway } = await gatewayWith({ allow: ["allowed.test"], subnets: LOOPBACK });

    const { closed } = await relay(
      gateway,
      `T ${ELSEWHERE} ${closedPort}`,
      httpGet("allowed.test"),
    );

    expect((await closed).toString()).toMatch(
      /^HTTP\/1\.1 502 Bad Gateway\r\n[\s\S]*cannot reach allowed\.test/,
    );
  });

  test("a new policy closes the connections it no longer allows and keeps the rest", async () => {
    const target = await destination({ banner: "hi" });
    const { gateway } = await gatewayWith({ allow: ["a.test", "b.test"], subnets: LOOPBACK });

    const a = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, clientHello("a.test"));
    const b = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, clientHello("b.test"));
    await expect.poll(() => a.received().toString() + b.received().toString()).toBe("hihi");

    gateway.setPolicy(resolveNetworkPolicy({ allow: ["b.test"] }));
    // Loopback is no longer allowed by range, so both lose their destination.
    await a.closed;
    await b.closed;

    const c = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, clientHello("b.test"));
    await c.closed;
    gateway.setPolicy(resolveNetworkPolicy({ allow: ["b.test"], subnets: LOOPBACK }));
    const d = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, clientHello("b.test"));
    const e = await relay(gateway, `T ${ELSEWHERE} ${target.port}`, clientHello("a.test"));
    await e.closed;
    await expect.poll(() => d.received().toString()).toBe("hi");
    gateway.setPolicy(resolveNetworkPolicy({ allow: ["b.test"], subnets: LOOPBACK }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.socket.destroyed).toBe(false);
    gateway.setPolicy(resolveNetworkPolicy("deny-all"));
    await d.closed;
  });

  test("a connection that does not say what it carries is dropped", async () => {
    const { gateway, denied } = await gatewayWith("allow-all");
    for (const header of ["CONNECT example.com:443 HTTP/1.1", "T example.com 443", "T 1.2.3.4"]) {
      const { closed } = await relay(gateway, header);
      expect((await closed).length).toBe(0);
    }
    expect(denied).toEqual([]);
  });

  test("close removes the socket and ends what was open", async () => {
    const target = await destination({ banner: "hi" });
    const { gateway } = await gatewayWith({ subnets: LOOPBACK });
    const open = await relay(gateway, `T 127.0.0.1 ${target.port}`);
    await expect.poll(() => open.received().toString()).toBe("hi");

    await gateway.close();
    await open.closed;

    expect(existsSync(path.dirname(gateway.socketPath))).toBe(false);
  });
});

describe("egress gateway: DNS", () => {
  const frame = (packet: Buffer) => {
    const framed = Buffer.alloc(2 + packet.length);
    framed.writeUInt16BE(packet.length);
    packet.copy(framed, 2);
    return framed;
  };
  async function ask(gateway: EgressGateway, name: string) {
    const query = dnsQuery(name);
    const { closed } = await relay(gateway, "D", frame(query));
    const reply = await closed;
    expect(reply.readUInt16BE(0)).toBe(reply.length - 2);
    return { query, answer: reply.subarray(2) };
  }

  test("a query for an allowed domain is passed to the resolver and its answer returned", async () => {
    const { gateway, dnsQueries, denied } = await gatewayWith({ allow: ["*.allowed.test"] });

    const { query, answer } = await ask(gateway, "api.allowed.test");

    expect(answer).toEqual(Buffer.concat([query, Buffer.from("answer")]));
    expect(dnsQueries).toEqual([query]);
    expect(denied).toEqual([]);
  });

  /** A name that is not allowed never leaves the host, so a lookup cannot carry data out. */
  test("a query for any other domain is answered here, as a name that does not exist", async () => {
    const { gateway, dnsQueries, denied } = await gatewayWith({ allow: ["allowed.test"] });

    const { query, answer } = await ask(gateway, "leak.other.test");

    expect(answer.readUInt16BE(0)).toBe(query.readUInt16BE(0));
    expect(answer[3]! & 0x0f).toBe(DNS_NAME_ERROR);
    expect(dnsQueries).toEqual([]);
    expect(denied).toEqual([{ host: "leak.other.test", port: 53 }]);
  });

  test("an allowed range leaves every name resolvable; deny-all resolves none", async () => {
    const ranged = await gatewayWith({ subnets: { allow: ["10.0.0.0/8"] } });
    await ask(ranged.gateway, "db.internal.test");
    expect(ranged.dnsQueries).toHaveLength(1);

    const closed = await gatewayWith("deny-all");
    const { answer } = await ask(closed.gateway, "allowed.test");
    expect(answer[3]! & 0x0f).toBe(DNS_NAME_ERROR);
    expect(closed.dnsQueries).toEqual([]);
  });

  test("a resolver that fails is reported as a server failure, not left to time out", async () => {
    const { gateway } = await gatewayWith({ allow: ["*"] });
    const { answer } = await ask(gateway, "broken.test");
    expect(answer[3]! & 0x0f).toBe(DNS_SERVER_FAILURE);
  });

  test("something that is not a DNS query is dropped", async () => {
    const { gateway, dnsQueries } = await gatewayWith("allow-all");
    const { closed } = await relay(gateway, "D", frame(Buffer.from("not dns")));
    expect((await closed).length).toBe(0);
    expect(dnsQueries).toEqual([]);
  });
});
