# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; user-facing behavior belongs in `README.md`.

## What this repository is

One published package, `@evelandhq/sandbox-bwrap`: a bubblewrap-backed
implementation of eve's `SandboxBackend` interface. It was extracted from the
eveland monorepo (`packages/sandbox-bwrap`) with its full history; commits
before the extraction still carry eveland-wide subjects such as
"feat: track eve 0.29.4".

Eveland is the primary consumer, but it consumes this as a published npm
package like anyone else — it vendors the built `dist/` into every Release it
builds. Nothing here may depend on eveland, and eveland-specific behavior does
not belong in this repository.

## Start here

Before changing code, read `README.md` — particularly **Security boundary**,
which states what this sandbox does and does not protect against. Several
non-obvious behaviors are deliberate and documented there:

- Host-side _read_ methods are intentionally not containment-checked; only
  write and remove calls are. That asymmetry follows eve's contract and is not
  a bug to fix.
- `shutdown()` kills the session's processes but deliberately leaves the
  workspace directory on disk. It is durable state.
- The cache is intentionally never pruned. See **Disk usage**.

## The eve peer range is the central invariant

`peerDependencies.eve` is `>=0.27.0 <1.0.0`. That range is wide on purpose: a
narrow window forced a republish for every eve minor, which is churn for
consumers rather than safety, when the consumed surface is one small interface.
Three mechanisms keep the wide range honest — do not remove one without
replacing it:

1. `src/eve-compatibility.test.ts` typechecks the backend against the range's
   exact floor (`eve-floor`, pinned to the newest patch of the floor's minor
   line) and against the newest verified eve. These are **type-level** tests;
   their annotations are the assertion, so `pnpm typecheck` must run in CI, not
   just `pnpm test`.
2. The CI `pack` job installs the real tarball against both ends of the range
   and imports it. This is a separate claim from typechecking: `dist/backend.js`
   imports a _value_ from `eve/sandbox`, so a version that typechecks could
   still fail to load.
3. `.github/workflows/eve-drift.yml` re-runs the suite against `eve@latest` on a
   schedule. It is the only thing covering the `<1.0.0` ceiling, since no pinned
   dependency can verify eve releases that do not exist yet.

Raising the floor means changing `peerDependencies.eve` **and** the `eve-floor`
devDependency together; a test asserts they name the same minor line.

## How to work here

- Add or update tests first, observe the failure, then implement the smallest
  coherent change.
- Unit tests inject the process runner (`ProcessRunner` in `src/process.ts`), so
  they never execute bwrap and run anywhere, including macOS. Keep it that way:
  a unit test that requires a real `bwrap` binary belongs in
  `src/integration/bwrap-backend-smoke.ts` instead.
- Anything touching the generated argv (`src/args.ts`) or prerequisite detection
  (`src/process.ts`) should be exercised by the real-binary smoke test, not only
  by unit tests. Argv that looks right and a kernel that accepts it are
  different things.
- Ground changes in the real files and real runtime behavior. Do not guess at
  eve's contract when the installed `eve/sandbox` types can be inspected.

## Verification

```bash
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
```

That is exactly what CI runs, minus the two jobs that need Linux or a registry:

- `pnpm tsx src/integration/bwrap-backend-smoke.ts` — real bwrap. Linux only,
  unprivileged user, needs the AppArmor profile loaded and `/workspace` created
  (see **Requirements** in `README.md`). Prints `BWRAP SMOKE OK`.
- The `pack` job — packs the tarball and imports it from a clean project.

## Releases

Conventional commits drive release-please, which opens a release PR. Merging it
tags the release, and the `publish` job publishes to npm with provenance. Do not
hand-edit `version` in `package.json` or `.release-please-manifest.json`.

`prepack` builds `dist/`, which is the only code the tarball ships — `src/` is
not published.
