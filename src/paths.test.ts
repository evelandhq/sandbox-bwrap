import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isWithinWorkspace,
  isWithinWorkspaceReal,
  resolveProviderCacheRoot,
  resolveWorkspacePath,
  sessionPathIn,
  templatePathIn,
  toHostPath,
  WORKSPACE_ROOT,
} from "./paths.js";

describe("cache layout", () => {
  test("templates live under eve's storage directory", () => {
    expect(resolveProviderCacheRoot("/app/.eve/sandbox-cache")).toBe(
      "/app/.eve/sandbox-cache/bwrap",
    );
  });

  test("template paths are hash-keyed and options-scoped", () => {
    const a = templatePathIn("/cache", "tpl-key", "aaaa");
    const b = templatePathIn("/cache", "tpl-key", "bbbb");
    const c = templatePathIn("/cache", "other-key", "aaaa");
    expect(a).toMatch(/^\/cache\/templates\/[0-9a-f]{32}-aaaa$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  /**
   * Durable session workspaces live at this path and recorded session state
   * names only the key, so the derivation must not change: a different one
   * would orphan every existing workspace.
   */
  test("session paths are the first 32 hex digits of the key's SHA-256", () => {
    expect(sessionPathIn("/cache", "session:sess-1")).toBe(
      "/cache/sessions/23251b97fd7a584906713d0d073feee1",
    );
  });
});

describe("workspace paths", () => {
  test("anchors relative paths to /workspace and passes absolute through", () => {
    expect(resolveWorkspacePath("notes/a.txt")).toBe("/workspace/notes/a.txt");
    expect(resolveWorkspacePath("/etc/hosts")).toBe("/etc/hosts");
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });

  test("translates workspace paths to host paths", () => {
    expect(toHostPath("notes/a.txt", "/data/sess1")).toBe("/data/sess1/notes/a.txt");
    expect(toHostPath("/workspace", "/data/sess1")).toBe("/data/sess1");
    expect(toHostPath("/workspace/x", "/data/sess1")).toBe("/data/sess1/x");
    expect(toHostPath("/etc/hosts", "/data/sess1")).toBe("/etc/hosts");
  });

  test("containment check rejects escapes", () => {
    expect(isWithinWorkspace("/data/sess1/notes", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/sess1", "/data/sess1")).toBe(true);
    expect(isWithinWorkspace("/data/other", "/data/sess1")).toBe(false);
    // traversal normalizes out of the workspace
    expect(isWithinWorkspace(toHostPath("a/../../escape", "/data/sess1"), "/data/sess1")).toBe(
      false,
    );
  });
});

describe("isWithinWorkspaceReal", () => {
  test("symlink escaping the workspace is rejected; inside-workspace symlink is allowed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bwrap-real-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, "escape"));
    symlinkSync(path.join(workspace, "inner-target"), path.join(workspace, "inner-link"));
    mkdirSync(path.join(workspace, "inner-target"), { recursive: true });

    expect(isWithinWorkspaceReal(path.join(workspace, "escape", "victim.txt"), workspace)).toBe(
      false,
    );
    expect(isWithinWorkspaceReal(path.join(workspace, "inner-link", "ok.txt"), workspace)).toBe(
      true,
    );
    expect(isWithinWorkspaceReal(path.join(workspace, "new-dir", "new-file.txt"), workspace)).toBe(
      true,
    );
  });

  test("dangling symlink is rejected", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bwrap-real-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(path.join(root, "nowhere"), path.join(workspace, "dangling"));
    expect(isWithinWorkspaceReal(path.join(workspace, "dangling"), workspace)).toBe(false);
  });
});
