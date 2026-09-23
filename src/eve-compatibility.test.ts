import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as FloorEveSandboxBackend } from "eve-floor/sandbox";
import type { MutableNetworkSandboxSession, SandboxEnvironment } from "eve/sandbox";
import type { SandboxProviderDefinition } from "eve/sandbox/provider";
import { createBwrapSandboxBackend } from "./backend.js";
import type { BwrapSandboxOpenOptions } from "./provider-definition.js";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";
import { BwrapSandbox } from "./provider.js";

/**
 * The peer range is deliberately wide (`>=0.62.0 <1.0.0`), and it spans two
 * sandbox APIs: eve 0.62 and 0.63 call a `SandboxBackend`, and eve 0.64
 * replaced that with sandbox providers. This package implements both, so the
 * type-level tests below pin each face to real installed eve packages:
 *
 * - the backend against the range's floor (`eve-floor`); 0.63, the last eve
 *   that calls backends, ships byte-identical sandbox types, and
 * - the provider against the newest verified eve (`eve`).
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

  test("the provider definition satisfies the newest verified Eve's provider contract", () => {
    const definition: SandboxProviderDefinition<
      object,
      BwrapSandboxOpenOptions,
      { readonly version: 1; readonly templatePath: string },
      unknown,
      MutableNetworkSandboxSession
    > = createBwrapSandboxProviderDefinition();

    expect(definition.name).toBe("bwrap");
  });

  test("the provider yields an eve sandbox environment with mutable networking", () => {
    const environment: SandboxEnvironment<BwrapSandboxOpenOptions, MutableNetworkSandboxSession> =
      BwrapSandbox.environment();

    expect(environment.provider).toBe("bwrap");
  });

  /**
   * The declared floor names a minor line (`>=0.62.0`) while `eve-floor` pins
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
