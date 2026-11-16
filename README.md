# @evelandhq/sandbox-bwrap

A [bubblewrap](https://github.com/containers/bubblewrap) sandbox provider for
[eve](https://www.npmjs.com/package/eve) agents. It gives agent-executed code a real Linux
sandbox — actual binaries, an isolated writable workspace, coarse network control — with
nothing but the `bwrap` binary and unprivileged user namespaces: no Docker daemon, no KVM.

## Why

eve's built-in providers need a hosted service (Vercel Sandbox), a Docker daemon, or settle
for just-bash, a pure-JS interpreter over a virtual filesystem that cannot run real binaries.
On a self-hosted Linux host without Docker or KVM, such as a systemd deployment, this
provider runs real commands with bubblewrap instead.

## Usage

Requires `eve` `>=1.0.0 <2.0.0-0`. eve 1.0 puts `eve/sandbox/provider` under semantic
versioning, so every eve 1.x release is accepted. A scheduled CI job re-runs the suite
against the newest eve to catch a release that breaks the contract anyway.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { BwrapSandbox } from "@evelandhq/sandbox-bwrap/provider";

export const environment = BwrapSandbox.environment({
  // Optional: setup every new sandbox inherits. Runs once, during `eve build`.
  prepare: async (sandbox) => {
    const result = await sandbox.run({ command: "pip install --user requests" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});

export default defineSandbox(() => environment.open());
```

- `eve build` prepares the template: eve writes the workspace and skill files into it and
  runs `prepare` inside bwrap, so a build that runs `prepare` needs bwrap on the build host;
  a build without one does not. The template lives under eve's sandbox storage directory in
  the built app (`.eve/sandbox-cache/bwrap/templates`), and eve records its absolute path.
  Serve the build from where it was built, or rebuild on the deploy host; a missing template
  fails the first sandbox access with a rebuild message.
- eve records which provider prepared each sandbox and refuses to open it with a different
  one. Choose the provider from something that is the same at build and run time, not from
  `isBwrapAvailable()` on hosts that differ.
- `environment.open({ networkPolicy: "deny-all" })` sets a session's initial network policy.
  It is recorded in the session state and applied again after a restart. The session also
  has `setNetworkPolicy("allow-all" | "deny-all")`.
- eve resumes a session from its recorded state alone. The template is not needed, so with a
  shared `cacheDir` a session keeps its workspace when it moves to a newer deployment.
- The package root imports nothing from eve at run time. It exports the plain definition,
  `createBwrapSandboxProviderDefinition()`, for callers that pass it to eve's
  `defineSandboxProvider` themselves or drive it directly — a host self-check, for example,
  can `prepare`, `start`, and run a command over the returned connection with a context of
  `{ kind: "session", session: { id }, storagePath }`.

### Options

| Option                   | Default                   | Meaning                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                    | `{}`                      | Environment variables set for every sandboxed command, above `AI_AGENT=eve` and below each call's own `env`.                                                                                                                                                                                                              |
| `networkPolicy`          | `"allow-all"`             | `"allow-all"` shares the host network; `"deny-all"` runs each command with no network (`--unshare-net`). Domain-level and header-rewriting policies are rejected, not weakened.                                                                                                                                           |
| `hidePaths`              | `[]`                      | Extra host paths hidden from the sandbox (each covered by an empty tmpfs).                                                                                                                                                                                                                                                |
| `bwrapPath`              | `"bwrap"`                 | bwrap executable to invoke.                                                                                                                                                                                                                                                                                               |
| `cacheDir`               | eve's sandbox storage dir | Absolute directory holding durable session workspaces. Templates always stay in eve's storage directory, where eve records them. Pin this outside the release directory: eve keys sandboxes per durable session, not per deployment, so a build-relative default loses every session's `/workspace` on the next redeploy. |
| `runTimeoutMs`           | `600000`                  | Hard wall-clock limit for every sandboxed command. At the limit the command's whole bwrap process group is killed and `wait()` rejects with `command timed out after <n> ms`. A long-running process started with `spawn()` (a dev server, a watcher) is bounded too; raise the limit or set `null` to disable it.        |
| `maxConcurrentProcesses` | `64`                      | Maximum live commands in one session's compute generation. A spawned process counts until it actually exits, even when its caller never waits. Set `null` to disable.                                                                                                                                                     |
| `maxOutputBytes`         | `16777216`                | Maximum combined stdout and stderr bytes one command delivers to its caller, counted as the caller reads them. At the limit both streams fail with `command output exceeded <n> bytes` after the bytes that fit, the process group is killed, and `wait()` rejects with the same error. Set `null` to disable.            |
| `onEvent`                | `undefined`               | Best-effort structured lifecycle sink for generation, command, and cleanup events. Sink failures are ignored so telemetry cannot change command behavior.                                                                                                                                                                 |

`prepare` is eve's standard environment option; eve runs it itself while it prepares the
template.

## How it works

eve calls the provider through its connection contract and builds the sandbox session —
`run()`, the file helpers, the bash tool — on top of the connection.

- **prepare** (`eve build`): creates a staging directory and hands eve a connection over it.
  eve asks it for `$HOME` (answered without launching bwrap), writes the workspace and skill
  files, and runs the authored `prepare`. Anything `prepare` left running is stopped, and the
  directory is atomically renamed to `<storage>/bwrap/templates/<key>-<options hash>`. eve
  derives the key from the workspace and skill files, the sandbox module's source, and this
  provider's identity.
- **start** (first sandbox access of a session): clones the template into
  `<cacheDir>/sessions/<hash>`, keyed by eve's session id alone. The clone requests a
  filesystem reflink (copy-on-write) and falls back to a recursive copy; the strategy is
  recorded in cache metadata. It returns the state eve persists: the session key and the
  network policy. It is an upsert: a session whose workspace already exists, such as one a
  subagent sharing the sandbox started, keeps it and the policy its live generation has.
- **resume** (later steps, and after restarts): reopens the recorded workspace and applies the
  recorded network policy to a new compute generation. A workspace that is gone throws
  `SandboxSessionGoneError`, on which eve starts a fresh sandbox.
- **connection.spawn**: every command is one transient bwrap invocation — read-only host
  root, the session directory bound read-write at `/workspace`, a fresh tmpfs `/tmp`,
  PID/IPC/UTS namespaces unshared, `--die-with-parent`, `--clearenv`. Each command is bounded
  by `runTimeoutMs` and `maxOutputBytes` and counts against `maxConcurrentProcesses`; its
  whole process group is killed when a limit or the caller's abort signal fires. eve builds
  `run()` from `spawn()`, so the provider cannot tell a short command from a long-running
  one, and it does not need to: bwrap's PID namespace ends every process a command started
  when that command exits, so bounding each command bounds all work in the sandbox.
- **connection.readFile / writeFiles / removePath**: host-side operations on the session
  directory; no subprocess. Writes and removals outside `/workspace` are refused.
- **connection.stop**: kills the session's processes and keeps the workspace. The next
  `start` or `resume` opens a fresh compute generation over the same files.
- **connection.close** (end of every step): releases nothing. The compute generation outlives
  the step; `stop`, server exit, and bwrap's `--die-with-parent` end it.
- **onSessionEnd** (a durable session completed, expired or failed, or `sandbox.delete()`):
  stops the live generation if this process holds one and removes the workspace and its
  metadata, from the recorded state alone or, when eve has none, from the session id. The
  template survives. It is idempotent, so eve may retry it, and it honors an already-aborted
  `signal` before touching anything.

What this means for commands in the sandbox:

- Host tools are visible read-only, so whatever the host has installed — `git`, `node`,
  `python3`, and so on — runs inside. Nothing can be installed into system paths: the host
  root is read-only and commands run as the agent's unprivileged user, so `apt-get`, `sudo`,
  and eve's `installCodeTooling` fail. Install user-level tools into the workspace (for
  example with `pip install --user` or `npm install --prefix`), or onto the host.
- Each command gets its own empty `/tmp`, and no process outlives the command that started
  it. Keep files that must persist between commands under `/workspace`. For eve's bash tool
  this means a command still running after the tool's yield window is not handed off as a
  background job: the tool waits for it to finish, within `runTimeoutMs`.
- `AI_AGENT=eve` (eve's `SANDBOX_AGENT_ENV`) is set in every command, beneath `env` and each
  call's own `env`, so agent-aware CLIs skip interactive prompts.
- Keyed `invokeTool` calls cannot keep a sandbox (`toolSessions` is not set): eve never ends
  such sandboxes, and this provider has no retention bound for them.

## Disk usage and cache management

Session workspaces persist under `<cacheDir>/sessions` across process restarts and
reconnects; templates live under eve's storage directory
(`<appRoot>/.eve/sandbox-cache/bwrap/templates`) and go away with the build that prepared
them. Stopping a sandbox never deletes durable state, ending a session deletes only its own
workspace, and this package never schedules deletion on its own.

Operator metadata lives separately under `<cacheDir>/metadata`; sandboxed code cannot
rewrite its own retention timestamps, tags, clone strategy, or active-generation leases.
Use the explicit APIs to inspect and reclaim storage. Pass the app root alone to inspect
templates, and `cacheDir` too to inspect session workspaces:

```ts
import { listBwrapCache, pruneBwrapCache } from "@evelandhq/sandbox-bwrap";

const location = { appRoot: "/srv/my-agent", cacheDir: "/var/lib/my-agent/sandbox" };
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
provider uses both process-local reference counts and lease files outside the writable
workspace, so a separate pruning process can see active sessions. A process crash can
leave a conservative stale lease; inspect `listBwrapCacheLeases(location)` and confirm the
owning deployment is stopped before removing such a lease. Leases are not expired
automatically, because deleting a live durable workspace is worse than retaining a false
positive.

## Lifecycle observability

`onEvent` receives discriminated `generation.started`, `command.started`,
`command.finished`, `cleanup.started`, `cleanup.completed`, and `cleanup.failed` events.
They include session/generation/command identities, tags, PID/process-group identity when
available, duration, output byte counts, live-process counts, finish reason (`exit`,
`abort`, `timeout`, `output-limit`, `killed`, `cleanup`), and cleanup errors. Events omit
command text and output. Do not put secrets in `tags`; the sink is operator-controlled
telemetry, not part of the sandbox boundary.

## Security boundary

- The host process environment is **never** forwarded: every command runs under
  `--clearenv` with `PATH`, `HOME=/workspace`, `LANG`, `AI_AGENT=eve`, your configured
  `env`, and the call's own `env`. Secrets in the agent's `process.env` stay out of
  sandboxed code.
- The cache roots — every session workspace and template of the app — are hidden from
  sandboxed commands behind a tmpfs, as are `hidePaths`. The rest of the host filesystem is
  _visible read-only_. To keep other applications' files out of view, run the agent itself
  in a boundary that hides them (a systemd unit with `TemporaryFileSystem=`/`BindPaths=`,
  or a container); bwrap only re-exposes what the agent process can already see.
- The network is shared with the host under `"allow-all"`, the default. `"deny-all"` leaves
  only loopback. There is nothing in between.
- The host-side `readFile` is deliberately **not** containment-checked: eve passes absolute
  paths through to the host filesystem, so a read can reach anything the agent process can
  read, including a sibling session's files. Only `writeFiles` and `removePath` are confined
  to the workspace. The tmpfs above is a boundary against a _sandboxed process_, not between
  sessions of the same agent — all of an app's sessions and templates share one trust domain
  on the host.
- The sandbox shares the host kernel. This is protection against mistakes and prompt
  injection, not multi-tenant isolation. If untrusted tenants, or code that routinely
  handles customer credentials, must run here, use VM-level isolation instead.
- CPU, memory, and PID limits are inherited from the cgroup the agent runs in, which covers
  sandbox children too. `maxConcurrentProcesses` is an admission bound, not a kernel PID or
  thread quota; `runTimeoutMs` and `maxOutputBytes` bound each command's wall-clock time and
  delivered output. No per-command cgroup or CPU/memory quota is created.
- `writeFiles` and `removePath` verify containment with a realpath-aware check
  (`isWithinWorkspaceReal`): they resolve symlinks along the path and re-check that the real
  target lands inside the real session directory, closing the escape where sandboxed code
  plants a symlink in `/workspace` that points outside it and a later host-side write follows
  it. A race between that check and the filesystem call it guards remains possible — Node
  exposes no `RESOLVE_BENEATH`-style primitive — so treat it as a check against planted
  symlinks, not an atomic guarantee.
- Symlink resolution cannot see inode aliasing. On the kernels this has been tested against
  (Ubuntu 24.04), a hard link from inside the sandbox to a file outside `/workspace` was
  **refused** across the two bind mounts. The contract test prints this as a non-assertive
  probe (`HARDLINK PROBE: refused …` or `succeeded …`), because the outcome depends on
  kernel and filesystem behavior this package does not control. Verify it on your own kernel
  if it matters to your threat model.

## Requirements

- Linux with unprivileged user namespaces available to the agent's user. Ubuntu's packaged
  bubblewrap ships **no** AppArmor profile, and Ubuntu sets
  `kernel.apparmor_restrict_unprivileged_userns=1` by default, so an unconfined non-root
  process calling `bwrap` fails with `bwrap: setting up uid map: Permission denied` until
  the host loads a profile that grants `bwrap` the `userns` permission. Root is exempt from
  the sysctl, which is why a root-only test proves nothing about a deployment. Save this as
  `/etc/apparmor.d/bwrap`:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,

    # Site-specific additions and overrides. See local/README for details.
    include if exists <local/bwrap>
  }
  ```

  then load it with `apparmor_parser -r -W /etc/apparmor.d/bwrap` (safe to re-run). A distro
  whose bubblewrap package ships its own profile, or a host with the sysctl disabled, needs
  none of this.

- `/workspace` must exist on the host as an empty directory. bwrap binds each session
  directory onto it but cannot create the mount point itself, because the host root is
  bound read-only first. If it is missing, the provider fails with an actionable message
  before invoking bwrap.
- `bash`, plus whatever tools the agent needs (`node`, `git`, …), on the host `PATH`.
- Works under systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`): the
  packaged `bwrap` is not setuid, so it needs no privilege escalation, only the AppArmor
  grant above. systemd's PID 1 reaps orphaned bwrap descendants.
- Inside a container, run with an init process (`docker run --init`) so orphaned bwrap
  descendants are reaped instead of accumulating as zombies, and grant what nested bwrap
  needs to create namespaces (for example `--cap-add SYS_ADMIN --cap-add NET_ADMIN
--security-opt seccomp=unconfined`). The container's filesystem is then the "host"
  filesystem sandboxed commands see read-only.

## Testing

- `pnpm test` — unit tests, run anywhere, including macOS: process execution is injected,
  so no bwrap is needed. `pnpm typecheck` runs the type-level contract checks against the
  installed eve in `src/eve-compatibility.test.ts`.
- `bash infra/smoke.sh` — the contract test against **real** bwrap, on macOS or Linux. It
  provisions a Lima VM (`brew install lima`), streams this worktree in, and runs the test as
  an unprivileged user under the systemd hardening a deployed agent gets
  (`NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`). Prints
  `BWRAP SMOKE OK`. Run it before pushing anything that touches `src/args.ts` or
  `src/process.ts`: CI's smoke job covers the unprivileged-user case but not the systemd
  constraints, and argv that looks right is not the same as a kernel that accepts it.
- `pnpm tsx src/integration/bwrap-smoke.ts` — the same test, run directly. Needs a Linux
  host with the AppArmor profile loaded and `/workspace` created (see
  [Requirements](#requirements)), run as an unprivileged user.

## License

Apache-2.0. See [LICENSE](./LICENSE).
