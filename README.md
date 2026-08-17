# @evelandhq/sandbox-bwrap

A [bubblewrap](https://github.com/containers/bubblewrap)-based `SandboxBackend` for
[eve](https://www.npmjs.com/package/eve) agents. It gives agent-executed code a real
Linux sandbox — actual binaries, isolated filesystem, coarse network control — without
requiring a Docker daemon or KVM.

## Why

eve's built-in backend chain is Vercel → Docker → microsandbox → just-bash. On a
self-hosted Linux box without a Docker daemon or KVM (for example an eveland systemd
deployment host), that chain bottoms out at `just-bash`: a pure-JS interpreter with a
virtual filesystem that cannot run real binaries. This backend fills that gap with
bubblewrap, which needs nothing but the `bwrap` binary and unprivileged user
namespaces.

## Usage

**Deployed on eveland:** you do nothing. eveland's Docker and systemd runtimes generate
the sandbox module into the release directory at build time — `agent/sandbox.js` for a flat
agent, or `agent/sandbox/sandbox.js` when a sandbox folder exists, recursively for every
subagent — and vendors this package's built output beside it, so agent projects never declare
a deployment backend themselves. If a project shipped its own sandbox module, the build
wraps that definition and reports it in the build log: Eveland overrides only `backend`, while
authored `bootstrap()`, `onSession()`, `description`, and `revalidationKey` remain active. The
sibling `agent/sandbox/workspace/**` tree is preserved, so Eve still seeds those files into each
Session's `/workspace`. Each Eveland Release supplies a distinct template revision, so Sessions
created against a new Deployment see its updated seeds while existing durable Session workspaces
remain untouched. The systemd runtime invokes
bwrap as its unprivileged deployment user. The local Docker runtime installs bwrap inside the Agent
image and grants the outer container only the capabilities nested bwrap requires; the
Agent container still receives no Docker socket. Local `eve dev` is untouched — it never runs
the eveland build pipeline, so it falls back to eve's default backend chain (usually
`just-bash`, or Docker where available). See eveland's `docs/deploy/linux.md` for what the
build log looks like and what happens when the sandbox does not work on the host.

**Standalone use of this package** (outside eveland, or in any project that manages its
own `agent/sandbox.ts`) still works the manual way:

```ts
// agent/sandbox.ts
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "@evelandhq/sandbox-bwrap";

export default defineSandbox({
  // bwrap on the Linux deploy host; eve's default chain everywhere else (dev laptops).
  backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
});
```

### eve version requirement

This package requires `eve` `>=0.27.0 <1.0.0`.

The range is deliberately wide. eve's 0.x releases use caret-incompatible minor bumps,
so a package that pins a narrow window has to republish for every eve minor — which is
churn for consumers, not safety, when the surface actually consumed is one small
interface (`SandboxBackend` from `eve/sandbox`) that changes rarely. Rather than
re-declaring the window, CI keeps the claim honest from both ends:
`src/eve-compatibility.test.ts` typechecks the backend against the range's exact floor
(0.27.13) and the newest verified release on every run, and a scheduled workflow re-runs
the suite against `eve@latest` so a breaking eve minor shows up as a red build here
instead of a bug report from your deployment. That is not theoretical: eve 0.32.0 added a
required `stop()` to the backend handle. This package implements it; 0.1.0 does not, and
pairing that release with eve `>=0.32.0` resolves cleanly and then fails at runtime the
first time authored code calls `ctx.getSandbox().stop()`.

The backend implements both handle lifecycle methods by killing every process the session
has spawned that has not yet exited: `shutdown()`, which eve calls at server teardown and
which requires that nothing be left running afterwards, and `stop()`, which authored code
triggers mid-run through `ctx.getSandbox().stop()`. Backends with provider-side compute
distinguish the two — a container to pause, a VM to snapshot; bwrap has no such resource,
because the processes are the compute. Neither method touches the session's workspace
directory — it is durable state. Cleanup closes that compute generation to new commands;
the next backend `create()` opens a fresh generation over the same workspace. Repeated
`create()` calls through one backend instance share the live generation, so one handle
cannot race a new spawn past another handle's cleanup barrier.

### Options

| Option                   | Default                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                    | `{}`                                 | Environment variables set for every sandboxed command.                                                                                                                                                                                                                                                                                                                                                                                            |
| `networkPolicy`          | `"allow-all"`                        | `"allow-all"` shares the host network; `"deny-all"` runs each command with no network (`--unshare-net`). `setNetworkPolicy` can switch between the two at run time; granular domain policies are rejected (use the Vercel backend for those).                                                                                                                                                                                                     |
| `hidePaths`              | `[]`                                 | Extra host paths hidden from the sandbox (each covered by an empty tmpfs).                                                                                                                                                                                                                                                                                                                                                                        |
| `bwrapPath`              | `"bwrap"`                            | bwrap executable to invoke.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cacheDir`               | `<appRoot>/.eve/sandbox-cache/bwrap` | Absolute directory holding templates and durable session workspaces. Pin this outside the release directory so a redeploy does not discard durable session state: since eve 0.22.0, eve keys session sandboxes per durable session, not per deployment, so an `appRoot`-derived default would silently destroy every session's `/workspace` on the next redeploy. The generated eveland module always sets this from `EVELAND_SANDBOX_CACHE_DIR`. |
| `templateRevision`       | `null`                               | Optional immutable release identity included in the template cache key but not the session path. Change it when seed files change so new Sessions use a fresh template without overwriting durable workspaces. Eveland sets it from its internal `EVELAND_SANDBOX_TEMPLATE_REVISION`.                                                                                                                                                             |
| `runTimeoutMs`           | `600000`                             | Hard wall-clock limit for one `run()` command. Timeout aborts the command and kills its complete bwrap process group. Set `null` to disable it. The limit deliberately does not apply to `spawn()`, which is the API for long-running processes.                                                                                                                                                                                                  |
| `maxConcurrentProcesses` | `64`                                 | Maximum live `run()`/`spawn()` commands admitted in one compute generation. A live `spawn()` counts until it actually exits, even when its caller never waits. Set `null` to disable.                                                                                                                                                                                                                                                             |
| `maxOutputBytes`         | `16777216`                           | Maximum combined stdout and stderr retained by one `run()` call. Exceeding it aborts and reaps the complete process group. Set `null` to disable. Streaming `spawn()` output is not retained by this backend.                                                                                                                                                                                                                                     |
| `onEvent`                | `undefined`                          | Best-effort structured lifecycle sink for generation, command, and cleanup events. Sink failures are ignored so telemetry cannot change command behavior.                                                                                                                                                                                                                                                                                         |

Both lifecycle callbacks may call `use({ networkPolicy: "allow-all" | "deny-all" })`. The
policy is applied before `use()` returns the template or live Session, so subsequent commands in
that callback use the requested network boundary. Calling `use()` without options keeps the
backend's configured policy.

## How it works

- **prewarm** (build time): resolves Eve's `$HOME/.agents/skills/**` seed paths to
  `/workspace/.agents/skills/**`, writes every seed into a staging directory, then runs the
  authored `bootstrap` inside bwrap so it can consume those canonical inputs, before atomically
  renaming the result into
  `<cacheDir>/templates/<hash>` (`<cacheDir>` defaults to
  `<appRoot>/.eve/sandbox-cache/bwrap` when the `cacheDir` option is not set). Idempotent
  per template key + options hash; `templateRevision` participates in that hash.
- **create** (runtime): atomically clones the template into
  `<cacheDir>/sessions/<hash>` on first use. It first requests a filesystem reflink
  (copy-on-write); filesystems without reflink support fall back to a normal recursive
  copy. The selected strategy is recorded in cache metadata. The directory IS the durable
  session state: it persists across reconnects and process restarts.
- **run/spawn**: every command is one transient bwrap invocation —
  read-only host rootfs, the session directory bound read-write at `/workspace`,
  tmpfs `/tmp`, PID/IPC/UTS namespaces unshared, `--die-with-parent`.
  `run()` also applies `runTimeoutMs` and `maxOutputBytes`, and kills the entire
  detached process group when a boundary or caller AbortSignal fires. Both APIs count
  against `maxConcurrentProcesses`; `spawn()` remains long-running until its holder
  calls `kill()`, the compute generation is stopped, or the backend shuts down.
- **File I/O** (`readTextFile`, `writeFile`, …): host-side operations on the session
  directory; no subprocess. Writes outside `/workspace` are refused.

## Disk usage and cache management

Session and template directories persist under `<cacheDir>/{sessions,templates}` across
process restarts and reconnects, enabling fast reattach. `stop()` and `shutdown()` never
delete durable state, and this package never schedules automatic deletion. On Eveland,
the cache lives at `EVELAND_SANDBOX_CACHE_DIR` outside every release directory, so a
redeploy does not touch it.

Operator metadata lives separately under `<cacheDir>/metadata`; sandboxed code cannot
rewrite its own retention timestamps, tags, clone strategy, or active-generation leases.
Use the explicit APIs to inspect and reclaim storage:

```ts
import { listBwrapCache, pruneBwrapCache } from "@evelandhq/sandbox-bwrap";

const location = { appRoot: "/srv/my-agent", cacheDir: "/var/lib/eveland/sandbox/project" };
const entries = await listBwrapCache(location);

// Dry-run is the default. Age and LRU policies may be combined independently
// for durable sessions and templates.
const preview = await pruneBwrapCache({
  ...location,
  sessions: { maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  templates: { maxEntries: 10 },
});

// Apply only after inspecting preview.candidates and preview.skippedActive.
const applied = await pruneBwrapCache({
  ...location,
  sessions: { maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  templates: { maxEntries: 10 },
  dryRun: false,
});
```

Active compute generations are skipped and rechecked immediately before deletion. The
backend uses both process-local reference counts and lease files outside the writable
workspace, so a separate pruning process can see active sessions. A process crash can
leave a conservative stale lease; inspect `listBwrapCacheLeases(location)` and confirm
the owning deployment is stopped before removing such a lease. Leases are not expired
automatically because deleting a live durable workspace is worse than retaining a false
positive.

## Lifecycle observability

`onEvent` receives discriminated `generation.started`, `command.started`,
`command.finished`, `cleanup.started`, `cleanup.completed`, and `cleanup.failed` events.
They include session/generation/command identities, tags, PID/process-group identity when
available, duration, output byte counts, live-process counts, finish reason, and cleanup
errors. Events deliberately omit command text and output. Do not put secrets in `tags`;
the sink is operator-controlled telemetry, not part of the sandbox boundary.

## Security boundary

- The host process environment is **never** forwarded: every invocation uses
  `--clearenv` and rebuilds the environment from `PATH`, `HOME=/workspace`, `LANG`,
  plus your configured `env`. Deployment secrets in the agent's `process.env` stay
  out of sandboxed code.
- For code executed inside the sandbox (`run`/`spawn`), the cache root (all
  other sessions and templates of the app) is hidden behind a tmpfs, so
  sandboxed code cannot read sibling session state.
- The host-side read methods (`readFile`, `readBinaryFile`, `readTextFile`)
  are deliberately **not** containment-checked: eve's contract requires
  absolute paths to pass through to the host filesystem unchanged, so these
  calls can read anything the agent process itself can read — including a
  sibling session's files or a template directory — not just paths inside
  `/workspace`. Only the write and remove calls (`writeFile`, `writeTextFile`,
  `writeBinaryFile`, `removePath`) are confined to the workspace, via the
  realpath-aware check described below. In other words, the tmpfs above is a
  boundary against a _sandboxed process_, not a boundary between sessions of
  the same agent — all of an app's sessions and templates share one trust
  domain on the host.
- The rest of the host filesystem is _visible read-only_ to sandboxed code, and the
  sandbox shares the host kernel. This is protection against mistakes and prompt
  injection — not multi-tenant isolation. If untrusted tenants or code that routinely
  handles customer credentials must run here, move to VM-level isolation
  (Firecracker/microsandbox) instead of hardening this backend further.
  Under Eveland's local Docker runtime, "host filesystem" here means the outer Agent
  container's filesystem, not the Docker host; no host root or Docker socket is mounted.
- CPU, memory, and PID limits are inherited from whatever cgroup the agent runs in
  (on eveland, the deployment's Docker container or systemd unit covers sandbox
  children too). `maxConcurrentProcesses` is an admission bound, not a kernel PID or
  thread quota; `runTimeoutMs` and `maxOutputBytes` bound one `run()`. The backend does
  not create a per-command cgroup or impose CPU/memory quotas on `spawn()`.
- Host-side write/remove calls (`writeFile`, `writeTextFile`, `writeBinaryFile`,
  `removePath`) verify containment with a realpath-aware check
  (`isWithinWorkspaceReal`): they resolve symlinks along the path and re-check that
  the real target still lands inside the real session directory, closing the escape
  where sandboxed code plants a symlink inside `/workspace` pointing outside it and a
  later host-side write follows it out. A race between that check and the filesystem
  call it guards remains theoretically possible — Node exposes no
  `RESOLVE_BENEATH`/`O_NOFOLLOW`-atomic primitive to close it — so treat this as a
  containment check against planted symlinks, not an atomic guarantee.
- Symlink resolution cannot see inode aliasing. On the kernel this backend has been
  tested against (Ubuntu 24.04, aarch64), creating a hard link from inside the
  sandbox to a file outside `/workspace` (`ln <host file> /workspace/x`) was
  **refused** — the kernel rejected the hard link across the two bind mounts. The
  integration contract test prints this as a non-assertive probe
  (`HARDLINK PROBE: refused …` or `succeeded …`) rather than an assertion, because
  the outcome depends on kernel/filesystem behavior this package does not control.
  Do not treat hard-link rejection as a guarantee the backend enforces — verify it on
  your own kernel if it matters to your threat model.

## Requirements

Eveland's generated local Docker image installs `bubblewrap` and `bash`, creates
`/workspace`, and starts the outer Agent container with its default capability set
dropped, `SYS_ADMIN` and `NET_ADMIN` added for bwrap namespaces, `no-new-privileges`,
`seccomp=unconfined`, and Docker `--init`. The init process is required to reap orphaned
bwrap descendants; without it they can accumulate as zombies until the container PID
limit is exhausted. Containers created before enabling it must be recreated. This is a
local-development boundary; the supported Linux production topology uses the
unprivileged systemd path below, where host PID 1 already reaps orphans.

- Linux with unprivileged user namespaces available to the calling process. Ubuntu's
  packaged bubblewrap (0.9.0-1ubuntu0.1 on 24.04) ships **no** AppArmor profile. Since
  Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, an
  _unconfined non-root_ process calling `bwrap` fails with
  `bwrap: setting up uid map: Permission denied` unless the host loads an AppArmor
  profile that grants `bwrap` the `userns` permission. Root is unaffected by this
  sysctl, but nothing here runs as root: eveland's systemd runtime runs both this
  backend (as the deployment user) and its own build sandbox (as a separate,
  unprivileged build user) as unconfined non-root userns creators, so both need the
  same AppArmor grant. Save this as `/etc/apparmor.d/bwrap`:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,

    # Site-specific additions and overrides. See local/README for details.
    include if exists <local/bwrap>
  }
  ```

  then load it with `apparmor_parser -r -W /etc/apparmor.d/bwrap` (safe to re-run; it
  replaces an already-loaded profile). A distro whose bubblewrap package ships its own
  profile, or a host with the sysctl disabled, needs none of this.

- `/workspace` must pre-exist on the host as an empty directory. `bwrap` binds each
  session directory onto `/workspace` inside the sandbox but cannot create that mount
  destination itself, because the host root is bind-mounted read-only first
  (`bwrap: Can't mkdir /workspace: Read-only file system`). If it is missing, the
  backend fails fast with an actionable error message before invoking `bwrap` (see
  `describeMissingPrereqs` in `src/process.ts`).
- `bash` and (for agents that need it) `node` on the host PATH — the sandbox reuses
  the host rootfs read-only.
- Works under systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`):
  apt's `bwrap` is not setuid, so it needs no privilege escalation to run — but it
  still needs the AppArmor profile above to create a user namespace as an
  unprivileged user. There is no Docker-style `--init` setting to add to a systemd
  Deployment; systemd already provides the host init/subreaper and `TasksMax` cgroup
  boundary.

## Testing

- `pnpm test` — unit tests, run anywhere, including macOS (process execution is
  injectable; no bwrap and no Linux needed). This is what CI runs on every push, and it
  includes the eve floor/latest compatibility typechecks.
- `bash infra/smoke.sh` — the contract test against **real** bwrap, on macOS or Linux.
  It provisions a Lima VM (`brew install lima`), streams this worktree in, and runs the
  test as an unprivileged user under the systemd hardening a deployed eve agent actually
  gets — `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`. Prints
  `BWRAP SMOKE OK`. The test also churns 500 short bwrap commands and checks that the
  zombie count returns to baseline. Run this before pushing anything that touches `src/args.ts` or
  `src/process.ts`: CI's smoke job covers the unprivileged-user case but not the systemd
  constraints, and argv that looks right is not the same as a kernel that accepts it.
- `pnpm tsx src/integration/bwrap-backend-smoke.ts` — the same test, run directly. Needs
  a Linux host that already has the AppArmor profile loaded and `/workspace` created
  (see [Requirements](#requirements)), and should be run as an unprivileged user: root
  is exempt from the userns sysctl, so a root-only pass proves nothing about a real
  deployment.

## License

Apache-2.0. See [LICENSE](./LICENSE).
