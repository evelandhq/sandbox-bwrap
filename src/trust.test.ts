import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { describe, expect, test } from "vitest";
import {
  publishAuthority,
  readHostRoots,
  SANDBOX_AUTHORITY_FILE,
  SANDBOX_ROOTS_FILE,
  SANDBOX_TRUST_DIR,
  SANDBOX_TRUST_ENV,
} from "./trust.js";

const pem = (label: string) => `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`;

describe("readHostRoots", () => {
  test("reads the first file that holds certificates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bwrap-roots-"));
    const empty = path.join(directory, "empty.pem");
    const roots = path.join(directory, "roots.pem");
    await writeFile(empty, "");
    await writeFile(roots, pem("host"));

    expect(await readHostRoots([path.join(directory, "absent.pem"), empty, roots])).toBe(
      pem("host"),
    );
  });

  test("falls back to the roots Node ships when the host keeps none it knows of", async () => {
    expect(await readHostRoots(["/nonexistent/roots.pem"])).toBe(rootCertificates.join("\n"));
  });
});

describe("publishAuthority", () => {
  test("writes the authority alone and with the host's roots, and leaves nothing else", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bwrap-trust-test-"));
    await publishAuthority(directory, pem("authority"), `${pem("host")}\n\n`);

    expect(await readFile(path.join(directory, "authority.pem"), "utf8")).toBe(pem("authority"));
    expect(await readFile(path.join(directory, "roots.pem"), "utf8")).toBe(
      pem("host") + pem("authority"),
    );
    expect((await readdir(directory)).sort()).toEqual(["authority.pem", "roots.pem"]);
  });
});

describe("what a command under rules is told to trust", () => {
  test("every variable names a file the provider publishes", () => {
    expect(SANDBOX_AUTHORITY_FILE).toBe(`${SANDBOX_TRUST_DIR}/authority.pem`);
    expect(SANDBOX_ROOTS_FILE).toBe(`${SANDBOX_TRUST_DIR}/roots.pem`);
    for (const file of Object.values(SANDBOX_TRUST_ENV)) {
      expect([SANDBOX_AUTHORITY_FILE, SANDBOX_ROOTS_FILE]).toContain(file);
    }
  });

  /** Node adds to its own roots; every other client replaces its roots with the file named. */
  test("only Node is given the authority alone", () => {
    const alone = Object.entries(SANDBOX_TRUST_ENV)
      .filter(([, file]) => file === SANDBOX_AUTHORITY_FILE)
      .map(([name]) => name);
    expect(alone).toEqual(["NODE_EXTRA_CA_CERTS"]);
    expect(SANDBOX_TRUST_ENV.GIT_SSL_CAINFO).toBe(SANDBOX_ROOTS_FILE);
    expect(SANDBOX_TRUST_ENV.CURL_CA_BUNDLE).toBe(SANDBOX_ROOTS_FILE);
    expect(SANDBOX_TRUST_ENV.SSL_CERT_FILE).toBe(SANDBOX_ROOTS_FILE);
  });
});
