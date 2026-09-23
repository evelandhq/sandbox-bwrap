import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/** Sandbox-visible workspace root; parity with eve's built-in local backends. */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Templates and durable session workspaces. `cacheDir` pins the location
 * outside the release directory; without it the cache follows eve's local
 * convention under the app root.
 */
export function resolveBwrapCacheRoot(appRoot: string, cacheDir?: string | null): string {
  return cacheDir ?? join(appRoot, ".eve", "sandbox-cache", "bwrap");
}

function keyDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function resolveTemplatePath(
  appRoot: string,
  templateKey: string,
  optionsHash: string,
  cacheDir?: string | null,
): string {
  return templatePathIn(resolveBwrapCacheRoot(appRoot, cacheDir), templateKey, optionsHash);
}

export function resolveSessionPath(
  appRoot: string,
  sessionKey: string,
  cacheDir?: string | null,
): string {
  return sessionPathIn(resolveBwrapCacheRoot(appRoot, cacheDir), sessionKey);
}

/**
 * The provider's cache root inside eve's sandbox storage directory
 * (`<appRoot>/.eve/sandbox-cache`), the same place the backend's default
 * cache root resolves to. eve prepares templates there at build time and
 * records their path, so templates always live here, even when `cacheDir`
 * moves session workspaces elsewhere.
 */
export function resolveProviderCacheRoot(storagePath: string): string {
  return join(storagePath, "bwrap");
}

export function templatePathIn(
  cacheRoot: string,
  templateKey: string,
  optionsHash: string,
): string {
  return join(cacheRoot, "templates", `${keyDigest(templateKey)}-${optionsHash}`);
}

export function sessionPathIn(cacheRoot: string, sessionKey: string): string {
  return join(cacheRoot, "sessions", keyDigest(sessionKey));
}

/** Anchors a sandbox-relative path to /workspace; absolute paths pass through. */
export function resolveWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}

/**
 * Translates a sandbox-visible path to the host path backing it: /workspace
 * maps to the session directory, anything else is the same path on the host.
 */
export function toHostPath(path: string, workspaceDir: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === WORKSPACE_ROOT) return workspaceDir;
  if (resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return join(workspaceDir, resolved.slice(WORKSPACE_ROOT.length + 1));
  }
  return resolved;
}

/** True when hostPath is workspaceDir or inside it after normalization. */
export function isWithinWorkspace(hostPath: string, workspaceDir: string): boolean {
  const rel = relative(workspaceDir, hostPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Symlink-aware containment: resolves the deepest existing ancestor of
 * hostPath (following symlinks) and re-checks that the real target stays
 * inside the real workspace directory. Not-yet-existing trailing components
 * cannot be symlinks, so they are appended lexically. Returns false when a
 * symlink in the chain is dangling (a write through it would create the
 * file at the symlink's target). Note: this closes the planted-symlink
 * escape; a race between this check and the following fs operation remains
 * theoretically possible (Node exposes no RESOLVE_BENEATH), which is an
 * accepted residual risk documented in the README.
 */
export function isWithinWorkspaceReal(hostPath: string, workspaceDir: string): boolean {
  if (!isWithinWorkspace(hostPath, workspaceDir)) return false;
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspaceDir);
  } catch {
    return false;
  }
  let probe = hostPath;
  const missing: string[] = [];
  while (!lexists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    missing.push(basename(probe));
    probe = parent;
  }
  let resolvedProbe: string;
  try {
    resolvedProbe = realpathSync(probe);
  } catch {
    return false; // dangling symlink in the chain
  }
  const finalPath =
    missing.length === 0 ? resolvedProbe : join(resolvedProbe, ...missing.reverse());
  return isWithinWorkspace(finalPath, realWorkspace);
}
