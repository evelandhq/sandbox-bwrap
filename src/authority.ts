import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "./process.js";

/** A certificate for one host name, and the key that answers for it. Both PEM. */
export interface IssuedCertificate {
  readonly certificate: string;
  readonly key: string;
}

/**
 * The certificate authority of one sandbox. The egress gateway has to read
 * the requests a rule applies to, so it answers the TLS handshake itself, with
 * a certificate this authority issues for the name the program asked for.
 * Programs in the sandbox accept it because the authority's own certificate is
 * added to what they trust (`trust.ts`).
 *
 * Nothing outside the sandbox trusts this authority, so its key guards little:
 * whoever has it can only impersonate a server to the sandbox's own programs.
 * It is kept from the sandbox all the same. What the policy depends on is
 * that the sandbox never sees the header values of the rules, and those stay
 * in the gateway.
 */
export interface EgressAuthority {
  /** The authority's certificate, PEM. */
  readonly certificate: string;
  /** A certificate for `name`, issued once and kept. */
  issue(name: string): Promise<IssuedCertificate>;
  close(): Promise<void>;
}

export interface CreateEgressAuthorityInput {
  readonly runner: ProcessRunner;
  readonly opensslPath: string;
  /** Where the authority keeps its keys, in a directory of its own. Defaults to the temporary directory. */
  readonly parentDirectory?: string;
}

/** How long one `openssl` run may take. It signs one certificate. */
const OPENSSL_TIMEOUT_MS = 15_000;

/** Certificates outlive any sandbox by far; a sandbox's clock is the host's. */
const VALID_DAYS = "365";

/** Issued certificates kept before the oldest is dropped, under a `*` that carries rules. */
const MAX_ISSUED = 256;

const CONFIG_NAME = "authority.cnf";

/**
 * A configuration of its own, so nothing depends on the host's `openssl.cnf`.
 * The authority may sign only server certificates and nothing below itself.
 */
const CONFIG = `
[req]
distinguished_name = subject
prompt = no
[subject]
O = bwrap sandbox
[authority]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
authorityKeyIdentifier = keyid
`.trimStart();

const HOST_NAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/;

/** The argv that signs the authority's own certificate and writes it to stdout. */
export function buildAuthorityArgs(opensslPath: string, directory: string): string[] {
  return [
    opensslPath,
    "req",
    "-x509",
    "-new",
    "-config",
    path.join(directory, CONFIG_NAME),
    "-key",
    path.join(directory, "authority.key"),
    "-sha256",
    "-days",
    VALID_DAYS,
    "-subj",
    "/O=bwrap sandbox/CN=egress authority",
    "-extensions",
    "authority",
  ];
}

/**
 * The argv that issues a certificate for `name` and writes it to stdout.
 * `req -CA` signs with the authority's key and needs OpenSSL 3.
 */
export function buildServerCertificateArgs(
  opensslPath: string,
  directory: string,
  name: string,
): string[] {
  return [
    opensslPath,
    "req",
    "-x509",
    "-new",
    "-config",
    path.join(directory, CONFIG_NAME),
    "-key",
    path.join(directory, "server.key"),
    "-CA",
    path.join(directory, "authority.pem"),
    "-CAkey",
    path.join(directory, "authority.key"),
    "-sha256",
    "-days",
    VALID_DAYS,
    "-subj",
    "/O=bwrap sandbox/CN=egress",
    "-extensions",
    "server",
    "-addext",
    `subjectAltName=DNS:${name}`,
  ];
}

/** Whether `argv` is one of the authority's `openssl` runs, so a fake runner can answer it. */
export function isAuthorityArgs(argv: readonly string[]): boolean {
  return argv[1] === "req" && argv[2] === "-x509" && path.basename(argv[5] ?? "") === CONFIG_NAME;
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let collected = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return collected + decoder.decode();
    collected += decoder.decode(value, { stream: true });
  }
}

function newKey(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}

/**
 * Creates a sandbox's authority. `openssl` signs; the keys are made here,
 * because Node can make a key and cannot sign a certificate.
 */
export async function createEgressAuthority(
  input: CreateEgressAuthorityInput,
): Promise<EgressAuthority> {
  const { runner, opensslPath } = input;
  const directory = await mkdtemp(
    path.join(input.parentDirectory ?? os.tmpdir(), "bwrap-authority-"),
  );

  /** Runs one signing and returns the certificate it printed. */
  async function sign(argv: string[]): Promise<string> {
    const explain = (detail: string) =>
      new Error(
        `bwrap sandbox: cannot issue a certificate for the network policy's rules: ${detail} ` +
          "(rules on a domain need OpenSSL 3 or newer on the host)",
      );
    const timeout = AbortSignal.timeout(OPENSSL_TIMEOUT_MS);
    let certificate: string;
    let diagnostics: string;
    let exitCode: number;
    try {
      const proc = runner.spawn(argv, { abortSignal: timeout });
      [certificate, diagnostics, { exitCode }] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.wait(),
      ]);
    } catch (error) {
      throw explain(`${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (exitCode !== 0 || !certificate.includes("-----BEGIN CERTIFICATE-----")) {
      throw explain(diagnostics.trim().split("\n").slice(-3).join(" ") || `exit code ${exitCode}`);
    }
    return certificate;
  }

  let certificate: string;
  const serverKey = newKey();
  try {
    await writeFile(path.join(directory, CONFIG_NAME), CONFIG);
    await writeFile(path.join(directory, "authority.key"), newKey(), { mode: 0o600 });
    await writeFile(path.join(directory, "server.key"), serverKey, { mode: 0o600 });
    certificate = await sign(buildAuthorityArgs(opensslPath, directory));
    await writeFile(path.join(directory, "authority.pem"), certificate);
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => {});
    throw error;
  }

  const issued = new Map<string, Promise<IssuedCertificate>>();
  let closed = false;
  return {
    certificate,
    async issue(name) {
      // The name becomes part of an openssl argument.
      if (closed || name.length > 253 || !HOST_NAME.test(name)) {
        throw new Error(`bwrap sandbox: cannot issue a certificate for ${JSON.stringify(name)}`);
      }
      let pending = issued.get(name);
      if (pending === undefined) {
        pending = sign(buildServerCertificateArgs(opensslPath, directory, name)).then((leaf) => ({
          certificate: leaf,
          key: serverKey,
        }));
        issued.set(name, pending);
        pending.catch(() => {
          if (issued.get(name) === pending) issued.delete(name);
        });
        if (issued.size > MAX_ISSUED) issued.delete(issued.keys().next().value!);
      }
      return await pending;
    },
    async close() {
      closed = true;
      await Promise.allSettled(issued.values());
      await rm(directory, { force: true, recursive: true });
    },
  };
}
