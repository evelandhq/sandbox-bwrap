import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as FloorEveSandboxBackend } from "eve-floor/sandbox";
import type { SandboxBackend as LatestEveSandboxBackend } from "eve/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";

/**
 * The peer range is deliberately wide (`>=0.27.0 <1.0.0`): this backend
 * implements one small eve interface, `SandboxBackend`, and re-declaring a
 * narrow window every time eve ships a minor produced nothing but version-bump
 * churn for consumers. The two type-level tests below are what makes the wide
 * range a verified claim rather than a hope — they pin the range's floor and
 * the newest eve release to real installed packages and fail the build if
 * either drifts out of structural compatibility.
 *
 * The ceiling is not pinnable the same way: eve releases newer than this
 * package cannot be typechecked here at all. `.github/workflows/eve-drift.yml`
 * covers that end by re-running the suite against `eve@latest` on a schedule,
 * so a breaking 0.x minor surfaces as a failed scheduled run instead of a user
 * bug report.
 */
describe("published Eve compatibility", () => {
  test("the backend remains structurally compatible with the peer range's floor", () => {
    const floorBackend: FloorEveSandboxBackend = createBwrapSandboxBackend();

    expect(floorBackend.name).toBe("bwrap");
  });

  test("the backend remains structurally compatible with the newest verified Eve", () => {
    const latestBackend: LatestEveSandboxBackend = createBwrapSandboxBackend();

    expect(latestBackend.name).toBe("bwrap");
  });

  /**
   * The declared floor names a minor line (`>=0.27.0`) while `eve-floor` pins
   * that line's newest patch, so these are compared at minor granularity, not
   * exactly. What this catches is the drift that actually happens: raising the
   * peer floor without moving the pin the typecheck above runs against, which
   * would leave the package claiming a floor nothing verifies.
   */
  test("the advertised peer floor is the eve line actually typechecked against", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      peerDependencies: { eve: string };
    };

    const declaredFloor = /^>=(\d+\.\d+)\.\d+/.exec(packageJson.peerDependencies.eve)?.[1];
    const testedFloor = /^npm:eve@(\d+\.\d+)\.\d+$/.exec(
      packageJson.devDependencies["eve-floor"] ?? "",
    )?.[1];

    expect(declaredFloor, "peerDependencies.eve must declare a >= floor").toBeDefined();
    expect(testedFloor, "devDependencies eve-floor must pin an exact eve version").toBeDefined();
    expect(testedFloor).toBe(declaredFloor);
  });
});
