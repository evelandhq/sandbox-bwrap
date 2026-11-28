import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildAuthorityArgs,
  buildServerCertificateArgs,
  createEgressAuthority,
  isAuthorityArgs,
  type EgressAuthority,
} from "./authority.js";
import { createNodeProcessRunner } from "./process.js";
import {
  FAKE_CERTIFICATE,
  failNextAuthority,
  fakeAuthorityRuns,
  exitingRunner,
  withFakeHolder,
} from "./provider.test-support.js";

const opensslVersion = /^OpenSSL (\d+)\./.exec(
  spawnSync("openssl", ["version"], { encoding: "utf8" }).stdout ?? "",
);
const canIssue = opensslVersion !== null && Number(opensslVersion[1]) >= 3;

const open: EgressAuthority[] = [];
afterEach(async () => {
  for (const authority of open.splice(0)) await authority.close();
});

async function authorityWith(runner = withFakeHolder({ ...exitingRunner })) {
  const authority = await createEgressAuthority({ runner, opensslPath: "openssl" });
  open.push(authority);
  return { authority, runner, runs: () => fakeAuthorityRuns(runner) };
}

describe("authority argv", () => {
  /** Pinned whole: this is the one place the provider's certificates are shaped. */
  test("the authority signs itself, under a configuration of the provider's own", () => {
    expect(buildAuthorityArgs("/usr/bin/openssl", "/run/a")).toEqual([
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-new",
      "-config",
      "/run/a/authority.cnf",
      "-key",
      "/run/a/authority.key",
      "-sha256",
      "-days",
      "365",
      "-subj",
      "/O=bwrap sandbox/CN=egress authority",
      "-extensions",
      "authority",
    ]);
  });

  test("a server certificate is signed by the authority, for one name", () => {
    const argv = buildServerCertificateArgs("openssl", "/run/a", "api.github.com");
    expect(argv.slice(0, 3)).toEqual(["openssl", "req", "-x509"]);
    expect(argv[argv.indexOf("-CA") + 1]).toBe("/run/a/authority.pem");
    expect(argv[argv.indexOf("-CAkey") + 1]).toBe("/run/a/authority.key");
    expect(argv[argv.indexOf("-key") + 1]).toBe("/run/a/server.key");
    expect(argv[argv.indexOf("-extensions") + 1]).toBe("server");
    expect(argv.slice(-2)).toEqual(["-addext", "subjectAltName=DNS:api.github.com"]);
    expect(isAuthorityArgs(argv)).toBe(true);
    expect(isAuthorityArgs(["openssl", "version"])).toBe(false);
  });
});

describe("createEgressAuthority", () => {
  test("issues one certificate per name and keeps it", async () => {
    const { authority, runs } = await authorityWith();
    expect(authority.certificate).toBe(FAKE_CERTIFICATE);

    const [first, again, other] = await Promise.all([
      authority.issue("api.github.com"),
      authority.issue("api.github.com"),
      authority.issue("github.com"),
    ]);

    expect(again).toBe(first);
    expect(first.certificate).toBe(FAKE_CERTIFICATE);
    expect(first.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(other.key).toBe(first.key);
    // The authority's own, then one for each name.
    expect(runs().map((argv) => argv.at(-1))).toEqual([
      "authority",
      "subjectAltName=DNS:api.github.com",
      "subjectAltName=DNS:github.com",
    ]);
  });

  /** The name ends up in an `openssl` argument, so only a host name gets that far. */
  test.each(["", "a,DNS:evil.test", "a b", "-x", "a..b/c", "x".repeat(254)])(
    "refuses to issue for %j",
    async (name) => {
      const { authority, runs } = await authorityWith();
      await expect(authority.issue(name)).rejects.toThrow(/cannot issue a certificate for/);
      expect(runs()).toHaveLength(1);
    },
  );

  test("keeps its keys to the owner and removes them when closed", async () => {
    const { authority, runs } = await authorityWith();
    const directory = path.dirname(runs()[0]![5]!);
    expect(statSync(path.join(directory, "authority.key")).mode & 0o077).toBe(0);
    expect(statSync(path.join(directory, "server.key")).mode & 0o077).toBe(0);

    await authority.close();
    expect(existsSync(directory)).toBe(false);
    await expect(authority.issue("github.com")).rejects.toThrow(/cannot issue/);
  });

  test("a host whose openssl cannot sign says so, with what openssl said", async () => {
    const runner = withFakeHolder({ ...exitingRunner });
    failNextAuthority(runner, "req: Unrecognized flag CA\nreq: Use -help for summary.");
    await expect(createEgressAuthority({ runner, opensslPath: "openssl" })).rejects.toThrow(
      /cannot issue a certificate for the network policy's rules: req: Unrecognized flag CA req: Use -help for summary\. \(rules on a domain need OpenSSL 3 or newer on the host\)/,
    );
  });

  test("a failed issue is not kept: the next request for the name tries again", async () => {
    const { authority, runner, runs } = await authorityWith();
    failNextAuthority(runner, "disk full");
    await expect(authority.issue("github.com")).rejects.toThrow(/disk full/);
    await expect(authority.issue("github.com")).resolves.toMatchObject({
      certificate: FAKE_CERTIFICATE,
    });
    expect(runs()).toHaveLength(3);
  });

  test("a host without openssl says which command was missing", async () => {
    await expect(
      createEgressAuthority({
        runner: createNodeProcessRunner(),
        opensslPath: "/nonexistent/openssl",
      }),
    ).rejects.toThrow(/\/nonexistent\/openssl: .*ENOENT/);
  });
});

/** What the argv above produces, read back with Node rather than trusted. */
describe.skipIf(!canIssue)("createEgressAuthority with the host's openssl", () => {
  test("issues a server certificate that chains to an authority which can sign nothing else", async () => {
    const authority = await createEgressAuthority({
      runner: createNodeProcessRunner(),
      opensslPath: "openssl",
    });
    open.push(authority);
    const issued = await authority.issue("api.github.com");

    const root = new X509Certificate(authority.certificate);
    const leaf = new X509Certificate(issued.certificate);
    expect(root.ca).toBe(true);
    expect(root.checkIssued(root)).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:api.github.com");
    expect(leaf.checkHost("api.github.com")).toBe("api.github.com");
    expect(leaf.checkHost("github.com")).toBeUndefined();
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(Date.parse(leaf.validTo)).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  });
});
