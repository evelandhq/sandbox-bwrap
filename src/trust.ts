import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { rootCertificates } from "node:tls";

/**
 * Where a sandbox finds the certificates it has to trust for the egress
 * gateway to read its requests. The directory is a read-only view of a host
 * directory, mounted when the sandbox starts and empty until a policy with
 * rules needs it. It sits under `/tmp` because that is the one place in the
 * sandbox where bwrap can create a mount point: the rest of the root is the
 * host's, read-only.
 */
export const SANDBOX_TRUST_DIR = "/tmp/.bwrap-sandbox";

/** The sandbox authority's certificate alone, for programs that add to their own roots. */
export const SANDBOX_AUTHORITY_FILE = `${SANDBOX_TRUST_DIR}/authority.pem`;

/** The host's roots and the sandbox authority, for programs that take one file as all they trust. */
export const SANDBOX_ROOTS_FILE = `${SANDBOX_TRUST_DIR}/roots.pem`;

/**
 * The variables through which common TLS clients are told what to trust.
 * They are set for a command only while the policy has rules: without rules
 * nothing answers a handshake with the sandbox authority's certificates, and
 * the files these name may not exist yet.
 *
 * Each program reads its own variable, and all but Node replace their roots
 * with the file named, so those get the combined file. A program that reads
 * none of these (a JVM, for one) does not trust the authority and fails its
 * handshake with a domain that has rules.
 */
export const SANDBOX_TRUST_ENV: Readonly<Record<string, string>> = {
  SSL_CERT_FILE: SANDBOX_ROOTS_FILE,
  CURL_CA_BUNDLE: SANDBOX_ROOTS_FILE,
  GIT_SSL_CAINFO: SANDBOX_ROOTS_FILE,
  REQUESTS_CA_BUNDLE: SANDBOX_ROOTS_FILE,
  PIP_CERT: SANDBOX_ROOTS_FILE,
  NPM_CONFIG_CAFILE: SANDBOX_ROOTS_FILE,
  AWS_CA_BUNDLE: SANDBOX_ROOTS_FILE,
  CARGO_HTTP_CAINFO: SANDBOX_ROOTS_FILE,
  GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: SANDBOX_ROOTS_FILE,
  NODE_EXTRA_CA_CERTS: SANDBOX_AUTHORITY_FILE,
};

/** Where distributions keep their roots as one PEM file, most common first. */
const HOST_ROOTS_FILES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/**
 * The roots the host trusts, as one PEM text. The sandbox's root filesystem
 * is the host's, so these are what its programs trusted before. A host that
 * keeps them nowhere this knows of gets the roots Node ships with.
 */
export async function readHostRoots(
  candidates: readonly string[] = HOST_ROOTS_FILES,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      const roots = await readFile(candidate, "utf8");
      if (roots.includes("-----BEGIN CERTIFICATE-----")) return roots;
    } catch {
      // Not this distribution's layout.
    }
  }
  return rootCertificates.join("\n");
}

/** Writes a file so that a reader sees the old content or the new, never part of it. */
async function publish(file: string, content: string): Promise<void> {
  await writeFile(`${file}.tmp`, content, { mode: 0o644 });
  await rename(`${file}.tmp`, file);
}

/**
 * Puts the sandbox authority's certificate where the sandbox reads it.
 * `hostDirectory` is the host directory mounted at {@link SANDBOX_TRUST_DIR}.
 */
export async function publishAuthority(
  hostDirectory: string,
  certificate: string,
  hostRoots: string,
): Promise<void> {
  await publish(path.join(hostDirectory, path.basename(SANDBOX_AUTHORITY_FILE)), certificate);
  await publish(
    path.join(hostDirectory, path.basename(SANDBOX_ROOTS_FILE)),
    `${hostRoots.trimEnd()}\n${certificate}`,
  );
}
