import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as FloorEveSandboxBackend } from "eve-floor/sandbox";
import type { SandboxSession as LegacyEveSandboxSession } from "eve-legacy/sandbox";
import type { SandboxProviderDefinition as LegacyEveSandboxProviderDefinition } from "eve-legacy/sandbox/provider";
import type { SandboxEnvironment, SandboxSession } from "eve/sandbox";
import type { SandboxProviderDefinition } from "eve/sandbox/provider";
import { createBwrapSandboxBackend } from "./backend.js";
import { EVE_SANDBOX_HOME_PROBE } from "./connection.js";
import type { BwrapConnectionExtensions } from "./provider-contract.js";
import type {
  BwrapPreparedArtifact,
  BwrapSandboxEnvironmentOptions,
  BwrapSandboxOpenOptions,
  BwrapSessionState,
} from "./provider-definition.js";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";
import { BwrapSandbox } from "./provider.js";

/**
 * The peer range is deliberately wide (`>=0.62.0 <1.0.0`), and it spans three
 * sandbox APIs: eve 0.62 and 0.63 call a `SandboxBackend`, eve 0.64 replaced
 * that with sandbox providers that hand eve a session handle, and eve 0.83
 * replaced the handle with a byte-level connection. This package implements
 * all three, so the type-level tests below pin each face to a real installed
 * eve package:
 *
 * - the backend against the range's floor (`eve-floor`); 0.63, the last eve
 *   that calls backends, ships byte-identical sandbox types,
 * - the handle provider against the last eve that calls it (`eve-legacy`,
 *   0.81.1; 0.82's provider types are byte-identical), and
 * - the connection provider against the newest verified eve (`eve`).
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

  test("the provider definition satisfies the handle contract of eve 0.64 through 0.82", () => {
    const definition: LegacyEveSandboxProviderDefinition<
      BwrapSandboxEnvironmentOptions,
      BwrapSandboxOpenOptions,
      BwrapPreparedArtifact,
      BwrapSessionState,
      LegacyEveSandboxSession & {
        setNetworkPolicy(policy: "allow-all" | "deny-all"): Promise<void>;
      }
    > = createBwrapSandboxProviderDefinition();

    expect(definition.name).toBe("bwrap");
  });

  test("the same definition satisfies the connection contract of the newest verified eve", () => {
    const definition: SandboxProviderDefinition<
      BwrapSandboxEnvironmentOptions,
      BwrapSandboxOpenOptions,
      BwrapPreparedArtifact,
      BwrapSessionState,
      BwrapConnectionExtensions
    > = createBwrapSandboxProviderDefinition();

    expect(definition.name).toBe("bwrap");
  });

  test("the provider yields an eve sandbox environment with mutable networking", () => {
    const environment: SandboxEnvironment<
      BwrapSandboxOpenOptions,
      SandboxSession & BwrapConnectionExtensions
    > = BwrapSandbox.environment();

    expect(environment.provider).toBe("bwrap");
  });

  /**
   * eve seeds skills under `$HOME/.agents/skills` after asking the template
   * connection for `$HOME`, and the connection answers that exact command
   * without launching bwrap (see `createBwrapConnection`). If eve changes the
   * probe, the connection would launch bwrap for it instead -- and on a build
   * host without bwrap eve swallows the failure and seeds skills under the
   * workspace, where the runtime never looks. This pins the command eve runs.
   */
  test("the template connection answers the newest verified eve's $HOME probe", async () => {
    const eveEntry = createRequire(import.meta.url).resolve("eve/sandbox");
    const eveDist = eveEntry.slice(0, eveEntry.indexOf("/dist/") + "/dist/".length);
    const skillPaths = await readFile(path.join(eveDist, "src/shared/skill-paths.js"), "utf8");

    expect(skillPaths).toContain(`command:\`${EVE_SANDBOX_HOME_PROBE.replace("\\", "\\\\")}\``);
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
