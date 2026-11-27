# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; user-facing behavior belongs in `README.md`.

## What this repository is

One published package, `@evelandhq/sandbox-bwrap`: a bubblewrap-backed sandbox
provider for eve 1.x. It implements eve's connection provider contract
(`eve/sandbox/provider`): `src/provider-definition.ts` is the lifecycle
(`prepare`, `start`, `resume`, `onSessionEnd`, `onSessionIdle`),
`src/connection.ts` the connection eve derives the sandbox session from, and
`src/session.ts` / `src/runtime.ts` the per-workspace compute generations
underneath. A generation's sandbox is a holder (`src/holder.ts`): one
long-lived bwrap that every command joins through a Python helper, with the
holder's argv, the join's argv, and the helper's source in `src/args.ts`. The ready
`BwrapSandbox` is exported from `/provider`; the root exports the plain
definition and imports nothing from eve at run time. It was extracted from the
eveland monorepo (`packages/sandbox-bwrap`) with its full history; commits
before the extraction still carry eveland-wide subjects.

Eveland is the primary consumer, but it consumes this as a published npm
package like anyone else — it vendors the built `dist/` into every Release it
builds. Nothing here may depend on eveland, and eveland-specific behavior does
not belong in this repository.

Recorded data must keep working across releases: the provider name `bwrap`,
`stateProtocolVersion` 1, the `BwrapSessionState` and `BwrapPreparedArtifact`
shapes, and the session workspace path `sessions/<sha256("session:<id>")[:32]>`
(pinned in `src/paths.test.ts`). Durable session workspaces outlive every
deployment, so changing any of these loses them; raise
`stateProtocolVersion` only for a deliberate, incompatible state change.

## Start here

Before changing code, read `README.md` — particularly **Security boundary**,
which states what this sandbox does and does not protect against. Several
non-obvious behaviors are deliberate and documented there:

- The host-side `readFile` is intentionally not containment-checked; only
  `writeFiles` and `removePath` are. That asymmetry follows eve's contract and
  is not a bug to fix.
- `connection.stop()` kills the session's processes but deliberately leaves the
  workspace directory on disk. It is durable state.
- The cache is never pruned on its own. See **Disk usage**.
- `runTimeoutMs` and `maxOutputBytes` apply to every spawned command, because
  eve builds `run()` from `spawn()`. They deliberately do not reach a process a
  command left running in its own process group: eve's bash tool depends on
  such a process surviving, and the holder's lifetime is its bound. See
  **Background processes**.
- Commands share one holder per network policy. Do not go back to a bwrap per
  command, and do not let a policy change keep the old holder: `/tmp`, the
  process table, and the guarantee that `deny-all` ends what ran with the
  network all depend on it.
- A joined command gets its environment from `env -i` and its working
  directory from a `cd` in the join script, because bwrap's `--clearenv` and
  `--chdir` belong to the holder. Nothing may reach a command through the
  host process's environment.
- The join is one `setns(pidfd, flags)`, never one `setns` per namespace.
  bwrap's `--dev` puts the sandbox's processes in a nested user namespace
  while the mount, PID, and IPC namespaces belong to the outer one; only the
  single call, checked against the caller's original credentials, may join
  both. The `nsenter` of util-linux 2.39, which Ubuntu 24.04 ships, joins
  namespace by namespace, so it is not a substitute, and a join that passes
  on a newer host can still fail there: run `infra/smoke.sh`.

## The eve peer range

`peerDependencies.eve` is `>=1.0.0 <2.0.0-0`. eve 1.0 puts
`eve/sandbox/provider` under semver, so the ceiling is the next major. Two
mechanisms keep the range honest — do not remove one without replacing it:

1. `src/eve-compatibility.test.ts` checks, against the installed `eve`
   devDependency, that the definition satisfies eve's
   `SandboxProviderDefinition`, that every option eve passes is declared on
   this side (assignability alone cannot catch a dropped optional option), that
   the template connection answers eve's `$HOME` probe, that the copied
   `SANDBOX_AGENT_ENV` matches eve's, and that the devDependency lies inside
   the peer range. These are largely **type-level** tests; their annotations
   are the assertion, so `pnpm typecheck` must run in CI, not just `pnpm test`.
   The contract types in `src/provider-contract.ts` are declared narrowly on
   purpose, so a host can drive the definition directly; this test is what
   ties them to eve's.
2. `.github/workflows/eve-drift.yml` re-runs the suite against `eve@latest` on
   a schedule. It is the only thing covering releases newer than the
   devDependency. eve's stability policy lets a minor add values eve passes
   into a provider — the session context's `kind`, `onSessionEnd`'s `reason`,
   and network policy variants. Never branch exhaustively on those: the local
   contract types keep `kind` and `reason` open, and `setNetworkPolicy`
   accepts `"allow-all"`/`"deny-all"` and rejects everything else.

The CI `pack` job installs the real tarball with npm against `eve@1.0.0` and
`eve@latest` and imports both entry points, which is a separate claim from
typechecking.

## How to work here

- Add or update tests first, observe the failure, then implement the smallest
  coherent change.
- Unit tests inject the process runner (`ProcessRunner` in `src/process.ts`), so
  they never execute bwrap and run anywhere, including macOS. Keep it that way:
  a unit test that requires a real `bwrap` binary belongs in
  `src/integration/bwrap-smoke.ts` instead. A fake runner answers a holder
  spawn through `withFakeHolder` in `src/provider.test-support.ts`, which
  keeps holder spawns out of the fake's own call records.
- Anything touching the generated argv (`src/args.ts`), the holder
  (`src/holder.ts`), or prerequisite detection (`src/process.ts`) should be
  exercised by the real-binary smoke test, not only by unit tests. What
  commands share across a holder is a property of kernel namespaces that no
  runner test double can show. Argv that looks right and a kernel that accepts it are
  different things.
- Ground changes in the real files and real runtime behavior. Do not guess at
  eve's contract when the installed `eve/sandbox/provider` types and
  `node_modules/eve/docs/sandbox/custom-providers.mdx` can be inspected.

## Verification

```bash
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
```

That is exactly what CI runs, minus the two jobs that need Linux or a registry:

- `bash infra/smoke.sh` — real bwrap in a Lima VM, run as an unprivileged user
  under `NoNewPrivileges` / `ProtectSystem=strict` / `PrivateTmp`. Prints
  `BWRAP SMOKE OK`. **Run this before pushing changes to `src/args.ts`,
  `src/holder.ts`, or `src/process.ts`.** CI's smoke job covers the unprivileged-user case, which is
  the AppArmor/userns failure mode, but deliberately does not reproduce the
  systemd hardening — this script is the only thing that does.
- The `pack` job — packs the tarball and imports it from a clean project.

Two things that make a real-bwrap pass meaningless if you get them wrong: run it
as an unprivileged user (root is exempt from
`kernel.apparmor_restrict_unprivileged_userns`, so root passes on a host where a
deployment would fail), and do not skip the AppArmor profile (Ubuntu's
bubblewrap package ships none).

## Releases

Conventional commits drive release-please, which keeps one open release PR.
Nothing publishes while that PR sits there; merging it is the decision to
release. The merge tags the commit and cuts a GitHub release, and only then does
the `publish` job run. Do not hand-edit `version` in `package.json` or
`.release-please-manifest.json`.

`prepack` builds `dist/`, the only code the tarball ships — `src/` is not
published. It is deliberately written as `npm run build`, not `pnpm build`,
because `npm publish` is what triggers it.

Publishing uses **npm trusted publishing (OIDC)**. There is no `NPM_TOKEN`
anywhere, and there should never be one: the `id-token: write` permission lets
npm verify the workflow's identity directly, and npm attaches a provenance
attestation on its own. Do not add `--provenance` to the publish command — that
flag is for token-based publishing.

The one thing this does not cover is the _first_ publish of a package name: npm
will not let you configure a trusted publisher for a package that does not exist
yet. So 0.1.0 was published by hand, trusted publishing was configured against
this repo and `release.yml` afterwards, and every release since is automatic.
If the package is ever unpublished and recreated, that bootstrap has to be
repeated.
