import { existsSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startEgressProxy, type EgressDenial, type EgressProxy } from "./egress-proxy.js";
import { resolveNetworkPolicy } from "./network-policy.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A destination on loopback that reports what reached it. */
async function destination() {
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`reached ${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => void server.closeAllConnections());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** Names that resolve to loopback, so no test needs a real resolver. */
const lookup = async (host: string) => {
  if (host.endsWith(".test")) return ["127.0.0.1"];
  throw new Error(`no such host ${host}`);
};

async function proxyWith(policy: unknown) {
  const denied: EgressDenial[] = [];
  const proxy = await startEgressProxy({
    policy: resolveNetworkPolicy(policy),
    lookup,
    onDenied: (denial) => denied.push(denial),
  });
  cleanups.push(() => proxy.close());
  return { proxy, denied };
}

const socketPath = (proxy: EgressProxy) => path.join(proxy.socketDir, proxy.socketName);

/** A plain HTTP request sent the way a client configured with HTTP_PROXY sends it. */
async function get(proxy: EgressProxy, url: string, headers: Record<string, string> = {}) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: socketPath(proxy),
        path: url,
        headers: { host: new URL(url).host, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT tunnel, as a client configured with HTTPS_PROXY opens it. */
async function tunnelTo(proxy: EgressProxy, authority: string) {
  return await new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = request({ socketPath: socketPath(proxy), method: "CONNECT", path: authority });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("error", reject);
    req.end();
  });
}

async function getThrough(socket: Socket, pathname: string) {
  return await new Promise<string>((resolve) => {
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("close", () => resolve(received));
    socket.write(`GET ${pathname} HTTP/1.1\r\nHost: tunnel\r\nConnection: close\r\n\r\n`);
  });
}

describe("egress proxy", () => {
  test("forwards a plain HTTP request to an allowed domain, without the proxy's own headers", async () => {
    const target = await destination();
    const { proxy, denied } = await proxyWith({ allow: ["allowed.test"] });

    const response = await get(proxy, `http://allowed.test:${target.port}/path?q=1`, {
      "proxy-authorization": "Basic c2VjcmV0",
      "x-kept": "yes",
    });

    expect(response).toEqual({ status: 200, body: "reached /path?q=1" });
    expect(target.seen[0]?.headers.host).toBe(`allowed.test:${target.port}`);
    expect(target.seen[0]?.headers["x-kept"]).toBe("yes");
    expect(target.seen[0]?.headers["proxy-authorization"]).toBeUndefined();
    expect(denied).toEqual([]);
  });

  test("refuses a domain that is not on the allow-list and reports only where it was going", async () => {
    const target = await destination();
    const { proxy, denied } = await proxyWith({ allow: ["allowed.test"] });

    const response = await get(proxy, `http://other.test:${target.port}/secret?token=abc`);

    expect(response.status).toBe(403);
    expect(response.body).toContain("the network policy does not allow other.test");
    expect(target.seen).toEqual([]);
    expect(denied).toEqual([{ host: "other.test", port: target.port }]);
  });

  test("opens a tunnel to an allowed domain and refuses one to any other", async () => {
    const target = await destination();
    const { proxy } = await proxyWith({ allow: ["*.allowed.test"] });

    const allowed = await tunnelTo(proxy, `api.allowed.test:${target.port}`);
    expect(allowed.status).toBe(200);
    expect(await getThrough(allowed.socket, "/through")).toContain("reached /through");

    const refused = await tunnelTo(proxy, `allowed.test:${target.port}`);
    expect(refused.status).toBe(403);
    refused.socket.destroy();
  });

  /**
   * A name often resolves to several addresses, and a destination may listen
   * on only one of them.
   */
  test("tries the next resolved address when one refuses the connection", async () => {
    const target = await destination();
    const proxy = await startEgressProxy({
      policy: resolveNetworkPolicy({ allow: ["allowed.test"] }),
      // Nothing listens on the IPv6 loopback at this port.
      lookup: async () => ["::1", "127.0.0.1"],
    });
    cleanups.push(() => proxy.close());

    expect(await get(proxy, `http://allowed.test:${target.port}/second`)).toEqual({
      status: 200,
      body: "reached /second",
    });
    const tunnel = await tunnelTo(proxy, `allowed.test:${target.port}`);
    expect(tunnel.status).toBe(200);
    tunnel.socket.destroy();
  });

  test("answers 502 when no allowed address accepts the connection", async () => {
    const target = await destination();
    const { proxy } = await proxyWith({ allow: ["allowed.test"] });
    const unused = target.port === 65_535 ? 1 : target.port + 1;
    const response = await get(proxy, `http://allowed.test:${unused}/`);
    expect(response.status).toBe(502);
    expect(response.body).toContain("cannot reach allowed.test");
  });

  test("an address is reachable only through an allowed range", async () => {
    const target = await destination();
    const byDomainOnly = await proxyWith({ allow: ["allowed.test"] });
    expect((await get(byDomainOnly.proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(403);

    const byRange = await proxyWith({ subnets: { allow: ["127.0.0.0/8"] } });
    expect((await get(byRange.proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(200);
    // A name that resolves into an allowed range bypasses the domain list.
    expect((await get(byRange.proxy, `http://unlisted.test:${target.port}/`)).status).toBe(200);
  });

  test("a denied range overrides an allowed domain and an allowed range", async () => {
    const target = await destination();
    const { proxy } = await proxyWith({
      allow: ["allowed.test"],
      subnets: { allow: ["127.0.0.0/8"], deny: ["127.0.0.1/32"] },
    });

    expect((await get(proxy, `http://allowed.test:${target.port}/`)).status).toBe(403);
    expect((await get(proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(403);
    expect(target.seen).toEqual([]);
  });

  test("deny-all refuses everything, and a name that does not resolve is refused", async () => {
    const target = await destination();
    const closed = await proxyWith("deny-all");
    expect((await get(closed.proxy, `http://allowed.test:${target.port}/`)).status).toBe(403);

    const open = await proxyWith({ allow: ["*"] });
    expect((await get(open.proxy, `http://nowhere.invalid:${target.port}/`)).status).toBe(403);
  });

  /**
   * `setNetworkPolicy` is how an agent withdraws access mid-session, so a
   * tunnel opened under the old policy must not outlive it.
   */
  test("a policy change closes the tunnels it no longer allows and keeps the rest", async () => {
    const target = await destination();
    const { proxy } = await proxyWith({ allow: ["allowed.test", "kept.test"] });
    const dropped = await tunnelTo(proxy, `allowed.test:${target.port}`);
    const kept = await tunnelTo(proxy, `kept.test:${target.port}`);
    const droppedClosed = new Promise<void>((resolve) =>
      dropped.socket.once("close", () => resolve()),
    );
    dropped.socket.resume();

    proxy.setPolicy(resolveNetworkPolicy({ allow: ["kept.test"] }));

    await droppedClosed;
    expect(await getThrough(kept.socket, "/still")).toContain("reached /still");
    expect((await get(proxy, `http://allowed.test:${target.port}/`)).status).toBe(403);
  });

  test("answers 400 to anything that is not a proxy request", async () => {
    const { proxy } = await proxyWith({ allow: ["*"] });
    const response = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: socketPath(proxy), path: "/not-absolute" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(response).toBe(400);
  });

  test("close removes the socket directory", async () => {
    const proxy = await startEgressProxy({ policy: resolveNetworkPolicy("deny-all"), lookup });
    expect(existsSync(socketPath(proxy))).toBe(true);
    await proxy.close();
    expect(existsSync(proxy.socketDir)).toBe(false);
  });
});
