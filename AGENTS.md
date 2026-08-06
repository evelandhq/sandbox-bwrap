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

- `bash infra/smoke.sh` — real bwrap in a Lima VM, run as an unprivileged user
  under `NoNewPrivileges` / `ProtectSystem=strict` / `PrivateTmp`. Prints
  `BWRAP SMOKE OK`. **Run this before pushing changes to `src/args.ts` or
  `src/process.ts`.** CI's smoke job covers the unprivileged-user case, which is
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
