import { describe, expect, test } from "vitest";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";

describe("resolveBwrapSandboxOptions", () => {
  test("applies defaults", () => {
    expect(resolveBwrapSandboxOptions()).toEqual({
      env: {},
      networkPolicy: "allow-all",
      hidePaths: [],
      bwrapPath: "bwrap",
      cacheDir: null,
      templateRevision: null,
      runTimeoutMs: 600_000,
    });
  });

  test("keeps explicit values", () => {
    const resolved = resolveBwrapSandboxOptions({
      env: { FOO: "1" },
      networkPolicy: "deny-all",
      hidePaths: ["/srv/private"],
      bwrapPath: "/usr/bin/bwrap",
      runTimeoutMs: 12_345,
    });
    expect(resolved.networkPolicy).toBe("deny-all");
    expect(resolved.env).toEqual({ FOO: "1" });
    expect(resolved.hidePaths).toEqual(["/srv/private"]);
    expect(resolved.bwrapPath).toBe("/usr/bin/bwrap");
    expect(resolved.runTimeoutMs).toBe(12_345);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid runTimeoutMs %s",
    (runTimeoutMs) => {
      expect(() => resolveBwrapSandboxOptions({ runTimeoutMs })).toThrow(/runTimeoutMs/);
    },
  );

  test("allows the run timeout to be disabled explicitly", () => {
    expect(resolveBwrapSandboxOptions({ runTimeoutMs: null }).runTimeoutMs).toBeNull();
  });
});

describe("createBwrapOptionsHash", () => {
  test("is stable across env key ordering and distinct for different options", () => {
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "2" } }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { B: "2", A: "1" } }));
    const c = createBwrapOptionsHash(resolveBwrapSandboxOptions({ env: { A: "1", B: "3" } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("cacheDir option", () => {
  test("defaults to null and is part of the options hash", () => {
    expect(resolveBwrapSandboxOptions().cacheDir).toBeNull();
    expect(resolveBwrapSandboxOptions({ cacheDir: "/a" }).cacheDir).toBe("/a");
    const a = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/a" }));
    const b = createBwrapOptionsHash(resolveBwrapSandboxOptions({ cacheDir: "/b" }));
    expect(a).not.toBe(b);
  });
});

describe("templateRevision option", () => {
  test("changes the template options hash without changing other defaults", () => {
    const first = resolveBwrapSandboxOptions({ templateRevision: "release-1" });
    const second = resolveBwrapSandboxOptions({ templateRevision: "release-2" });

    expect(first.templateRevision).toBe("release-1");
    expect(createBwrapOptionsHash(first)).not.toBe(createBwrapOptionsHash(second));
  });
});

describe("runTimeoutMs option", () => {
  test("participates in the options hash", () => {
    const bounded = createBwrapOptionsHash(resolveBwrapSandboxOptions({ runTimeoutMs: 1_000 }));
    const unbounded = createBwrapOptionsHash(resolveBwrapSandboxOptions({ runTimeoutMs: null }));

    expect(bounded).not.toBe(unbounded);
  });
});
