import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxEnvironment, SandboxSession } from "eve/sandbox";
import { SANDBOX_AGENT_ENV as EVE_SANDBOX_AGENT_ENV } from "eve/sandbox/provider";
import type {
  SandboxConnection,
  SandboxProviderDefinition,
  SandboxSessionContext,
  SandboxSessionEndOptions,
} from "eve/sandbox/provider";
import { SANDBOX_AGENT_ENV } from "./args.js";
import { EVE_SANDBOX_HOME_PROBE } from "./connection.js";
import type { BwrapSandboxEnvironmentOptions } from "./options.js";
import type {
  BwrapConnectionExtensions,
  BwrapSandboxConnection,
  BwrapSessionContext,
  BwrapSessionEndOptions,
} from "./provider-contract.js";
import type {
  BwrapPreparedArtifact,
  BwrapSandboxOpenOptions,
  BwrapSessionState,
} from "./provider-definition.js";
import { createBwrapSandboxProviderDefinition } from "./provider-definition.js";
import { BwrapSandbox } from "./provider.js";

/**
 * Every option name eve passes (`Theirs`) is one the bwrap side declares
 * (`Ours`). Plain assignability cannot say this: the options are all optional,
 * so a contract that silently dropped `signal` would still typecheck while
 * ignoring eve's aborts.
 */
type DeclaresEvery<Ours, Theirs> = [Exclude<keyof Theirs, keyof Ours>] extends [never]
  ? true
  : Exclude<keyof Theirs, keyof Ours>;
type OptionsOf<Method> = Method extends (options: infer Options) => unknown ? Options : never;

/**
 * The provider's contract is declared locally (`src/provider-contract.ts`) and
 * checked here against the installed eve, the peer range's floor. The type
 * annotations are the assertions, so `pnpm typecheck` must run in CI. Newer
 * eve releases inside the range are covered by `.github/workflows/eve-drift.yml`,
 * which re-runs this suite against `eve@latest` on a schedule.
 */
describe("eve sandbox provider contract", () => {
  test("the definition satisfies eve's provider definition", () => {
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

  test("every option eve passes is one the provider declares", () => {
    type Conn = BwrapSandboxConnection;
    const declared: [
      DeclaresEvery<OptionsOf<Conn["spawn"]>, OptionsOf<SandboxConnection["spawn"]>>,
      DeclaresEvery<OptionsOf<Conn["readFile"]>, OptionsOf<SandboxConnection["readFile"]>>,
      DeclaresEvery<OptionsOf<Conn["writeFiles"]>, OptionsOf<SandboxConnection["writeFiles"]>>,
      DeclaresEvery<OptionsOf<Conn["removePath"]>, OptionsOf<SandboxConnection["removePath"]>>,
      DeclaresEvery<BwrapSessionEndOptions, SandboxSessionEndOptions>,
    ] = [true, true, true, true, true];

    expect(declared.every(Boolean)).toBe(true);
  });

  /**
   * eve's stability policy lets a minor add session kinds and end reasons, so
   * the local contract must accept any string there rather than a closed union
   * a new value would fall outside of.
   */
  test("session kinds and end reasons stay open to values a later eve adds", () => {
    const kinds: [SandboxSessionContext["kind"], "a-kind-eve-adds-later"] = [
      "tool-session",
      "a-kind-eve-adds-later",
    ];
    const accepted: BwrapSessionContext["kind"][] = kinds;
    const reasons: BwrapSessionEndOptions["reason"][] = [
      "completed" satisfies SandboxSessionEndOptions["reason"],
      "a-reason-eve-adds-later",
    ];

    expect([...accepted, ...reasons]).toHaveLength(4);
  });

  /**
   * The package root imports nothing from eve at run time, so it carries its
   * own copy of the variables eve asks providers to set in every sandbox.
   */
  test("the sandbox environment carries eve's SANDBOX_AGENT_ENV", () => {
    expect(SANDBOX_AGENT_ENV).toEqual(EVE_SANDBOX_AGENT_ENV);
  });

  /**
   * eve seeds skills under `$HOME/.agents/skills` after asking the template
   * connection for `$HOME`, and the connection answers that exact command
   * without launching bwrap (see `createBwrapConnection`). If eve changes the
   * probe, the connection would launch bwrap for it instead -- and on a build
   * host without bwrap eve swallows the failure and seeds skills under the
   * workspace, where the runtime never looks. This pins the command eve runs.
   */
  test("the template connection answers the $HOME probe eve runs", async () => {
    const eveEntry = createRequire(import.meta.url).resolve("eve/sandbox");
    const eveDist = eveEntry.slice(0, eveEntry.indexOf("/dist/") + "/dist/".length);
    const skillPaths = await readFile(path.join(eveDist, "src/shared/skill-paths.js"), "utf8");

    expect(skillPaths).toContain(`command:\`${EVE_SANDBOX_HOME_PROBE.replace("\\", "\\\\")}\``);
  });

  /**
   * The suite typechecks against the eve devDependency, so that version must
   * be one `peerDependencies.eve` accepts; otherwise the package would claim a
   * range nothing here verifies. The drift job installs `eve@latest` and runs
   * this too, so an eve 2.0 fails here as well as anywhere it breaks a type.
   */
  test("the eve version typechecked against is inside the advertised peer range", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      peerDependencies: { eve: string };
    };
    const parse = (version: string | undefined) =>
      /^\^?(\d+)\.(\d+)\.(\d+)$/
        .exec(version ?? "")
        ?.slice(1)
        .map(Number);
    const compare = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

    const range = /^>=(\S+) <2\.0\.0-0$/.exec(packageJson.peerDependencies.eve);
    const floor = parse(range?.[1]);
    const tested = parse(packageJson.devDependencies.eve);

    expect(floor, "peerDependencies.eve must be >=<floor> <2.0.0-0").toBeDefined();
    expect(tested, "devDependencies.eve must name one eve release").toBeDefined();
    expect(compare(tested!, floor!)).toBeGreaterThanOrEqual(0);
    expect(tested![0]).toBe(1);
  });
});
