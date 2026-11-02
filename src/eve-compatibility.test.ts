import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type {
  SandboxConnection as ConnectionLegacyEveSandboxConnection,
  SandboxProviderDefinition as ConnectionLegacyEveSandboxProviderDefinition,
  SandboxSessionContext as ConnectionLegacyEveSandboxSessionContext,
  SandboxSessionEndOptions as ConnectionLegacyEveSandboxSessionEndOptions,
} from "eve-connection-legacy/sandbox/provider";
import type { SandboxBackend as FloorEveSandboxBackend } from "eve-floor/sandbox";
import type {
  SandboxRunOptions as LegacyEveSandboxRunOptions,
  SandboxSession as LegacyEveSandboxSession,
  SandboxSpawnOptions as LegacyEveSandboxSpawnOptions,
} from "eve-legacy/sandbox";
import type { SandboxProviderDefinition as LegacyEveSandboxProviderDefinition } from "eve-legacy/sandbox/provider";
import type {
  SandboxEnvironment,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
} from "eve/sandbox";
import type {
  SandboxConnection,
  SandboxProviderDefinition,
  SandboxSessionContext,
  SandboxSessionEndOptions,
} from "eve/sandbox/provider";
import { createBwrapSandboxBackend } from "./backend.js";
import { EVE_SANDBOX_HOME_PROBE } from "./connection.js";
import type {
  BwrapConnectionExtensions,
  BwrapSandboxConnection,
  ConnectionProviderSessionContext,
  ConnectionSessionEndOptions,
} from "./provider-contract.js";
import type {
  BwrapPreparedArtifact,
  BwrapSandboxEnvironmentOptions,
  BwrapSandboxOpenOptions,
  BwrapSessionState,
} from "./provider-definition.js";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";
import { BwrapSandbox } from "./provider.js";
import type { BwrapRunOptions, BwrapSpawnOptions } from "./session.js";

/**
 * Every option name eve passes (`Theirs`) is one the bwrap side declares
 * (`Ours`). Plain assignability cannot say this: the options are all optional,
 * so a contract that silently dropped `abortSignal` -- the name eve 0.83 and
 * earlier pass -- would still typecheck while ignoring their aborts.
 */
type DeclaresEvery<Ours, Theirs> = [Exclude<keyof Theirs, keyof Ours>] extends [never]
  ? true
  : Exclude<keyof Theirs, keyof Ours>;
type OptionsOf<Method> = Method extends (options: infer Options) => unknown ? Options : never;

/**
 * The peer range is deliberately wide (`>=0.62.0 <1.0.0 || >=1.0.0-0 <2.0.0-0`),
 * and it spans three sandbox APIs: eve 0.62 and 0.63 call a `SandboxBackend`,
 * eve 0.64 replaced that with sandbox providers that hand eve a session
 * handle, and eve 0.83 replaced the handle with a byte-level connection, whose
 * options eve 0.84 then renamed (`abortSignal` became `signal`, and `spawn`
 * gained `stdin`). This package implements all of it, so the type-level tests
 * below pin each face to a real installed eve package:
 *
 * - the backend against the range's floor (`eve-floor`); 0.63, the last eve
 *   that calls backends, ships byte-identical sandbox types,
 * - the handle provider against the last eve that calls it (`eve-legacy`,
 *   0.81.1; 0.82's provider types are byte-identical),
 * - the connection provider against the last eve that passes `abortSignal`
 *   (`eve-connection-legacy`, 0.83.3), and
 * - the connection provider against the newest verified eve (`eve`, 1.x),
 *   whose `eve/sandbox/provider` is stable under semver until 2.0.
 *
 * The ceiling is not pinnable the same way: eve releases newer than this
 * package cannot be typechecked here at all. `.github/workflows/eve-drift.yml`
 * covers that end by re-running the suite against `eve@latest` on a schedule,
 * so a 1.x minor that breaks the contract anyway surfaces as a failed
 * scheduled run instead of a user bug report.
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

  test("the same definition satisfies eve 0.83's connection contract, before the rename", () => {
    const definition: ConnectionLegacyEveSandboxProviderDefinition<
      BwrapSandboxEnvironmentOptions,
      BwrapSandboxOpenOptions,
      BwrapPreparedArtifact,
      BwrapSessionState,
      BwrapConnectionExtensions
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
   * Both sides of eve 0.84's `abortSignal` -> `signal` rename, and 0.84.1's
   * `stdin`, are declared by name wherever eve passes them: on the connection
   * eve 0.83 and later call, on the session eve 0.62 through 0.82 call
   * directly, and on `onSessionEnd`. The assertion is the annotation.
   */
  test("every option each eve passes is one the provider declares", () => {
    type Conn = BwrapSandboxConnection;
    const declared: [
      DeclaresEvery<OptionsOf<Conn["spawn"]>, OptionsOf<SandboxConnection["spawn"]>>,
      DeclaresEvery<OptionsOf<Conn["readFile"]>, OptionsOf<SandboxConnection["readFile"]>>,
      DeclaresEvery<OptionsOf<Conn["writeFiles"]>, OptionsOf<SandboxConnection["writeFiles"]>>,
      DeclaresEvery<OptionsOf<Conn["removePath"]>, OptionsOf<SandboxConnection["removePath"]>>,
      DeclaresEvery<
        OptionsOf<Conn["spawn"]>,
        OptionsOf<ConnectionLegacyEveSandboxConnection["spawn"]>
      >,
      DeclaresEvery<
        OptionsOf<Conn["readFile"]>,
        OptionsOf<ConnectionLegacyEveSandboxConnection["readFile"]>
      >,
      DeclaresEvery<
        OptionsOf<Conn["writeFiles"]>,
        OptionsOf<ConnectionLegacyEveSandboxConnection["writeFiles"]>
      >,
      DeclaresEvery<
        OptionsOf<Conn["removePath"]>,
        OptionsOf<ConnectionLegacyEveSandboxConnection["removePath"]>
      >,
      DeclaresEvery<ConnectionSessionEndOptions, SandboxSessionEndOptions>,
      DeclaresEvery<ConnectionSessionEndOptions, ConnectionLegacyEveSandboxSessionEndOptions>,
      DeclaresEvery<BwrapRunOptions, SandboxRunOptions>,
      DeclaresEvery<BwrapSpawnOptions, SandboxSpawnOptions>,
      DeclaresEvery<BwrapRunOptions, LegacyEveSandboxRunOptions>,
      DeclaresEvery<BwrapSpawnOptions, LegacyEveSandboxSpawnOptions>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

    expect(declared.every(Boolean)).toBe(true);
  });

  /**
   * eve 1.0's stability policy lets a minor add session kinds and end reasons,
   * so the locally declared contract must accept any string there rather than
   * a closed union a new value would fall outside of.
   */
  test("session kinds and end reasons stay open to values a later eve adds", () => {
    const kinds: [
      SandboxSessionContext["kind"],
      ConnectionLegacyEveSandboxSessionContext["kind"],
      "a-kind-eve-adds-later",
    ] = ["session", "tool-session", "a-kind-eve-adds-later"];
    const accepted: ConnectionProviderSessionContext["kind"][] = kinds;
    const reasons: ConnectionSessionEndOptions["reason"][] = [
      "completed" satisfies SandboxSessionEndOptions["reason"],
      "a-reason-eve-adds-later",
    ];

    expect([...accepted, ...reasons]).toHaveLength(5);
  });

  /**
   * eve seeds skills under `$HOME/.agents/skills` after asking the template
   * connection for `$HOME`, and the connection answers that exact command
   * without launching bwrap (see `createBwrapConnection`). If eve changes the
   * probe, the connection would launch bwrap for it instead -- and on a build
   * host without bwrap eve swallows the failure and seeds skills under the
   * workspace, where the runtime never looks. This pins the command eve runs.
   */
  test.each(["eve-connection-legacy", "eve"])(
    "the template connection answers the $HOME probe %s runs",
    async (eve) => {
      const eveEntry = createRequire(import.meta.url).resolve(`${eve}/sandbox`);
      const eveDist = eveEntry.slice(0, eveEntry.indexOf("/dist/") + "/dist/".length);
      const skillPaths = await readFile(path.join(eveDist, "src/shared/skill-paths.js"), "utf8");

      expect(skillPaths).toContain(`command:\`${EVE_SANDBOX_HOME_PROBE.replace("\\", "\\\\")}\``);
    },
  );

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
