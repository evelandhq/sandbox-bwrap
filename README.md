# @evelandhq/sandbox-bwrap

A [bubblewrap](https://github.com/containers/bubblewrap) sandbox provider for
[eve](https://www.npmjs.com/package/eve) agents. It gives agent-executed code a real Linux
sandbox — actual binaries, an isolated writable workspace, background processes, network
control down to an allow-list of domains — with nothing but the `bwrap` binary, Python 3,
and unprivileged user namespaces: no Docker daemon, no KVM.

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
- `environment.open({ networkPolicy })` sets a session's initial network policy: `"allow-all"`,
  `"deny-all"`, or an allow-list such as `{ allow: ["api.github.com", "*.npmjs.org"] }`. It is
  recorded in the session state and applied again after a restart. The session also has
  `setNetworkPolicy(policy)`. See [Network policy](#network-policy).
- `idleTimeoutMs`, eve's standard environment option from eve 1.1 on, stops a session's
  sandbox once the session has been idle that long (5 minutes when omitted). The sandbox's
  processes end and its workspace stays; the next turn that uses it starts a new sandbox
  over the same files. This is what bounds a process left running in the background.
- eve resumes a session from its recorded state alone. The template is not needed, so with a
  shared `cacheDir` a session keeps its workspace when it moves to a newer deployment.
- The package root imports nothing from eve at run time. It exports the plain definition,
  `createBwrapSandboxProviderDefinition()`, for callers that pass it to eve's
  `defineSandboxProvider` themselves or drive it directly — a host self-check, for example,
  can `prepare`, `start`, and run a command over the returned connection with a context of
  `{ kind: "session", session: { id }, storagePath }`.

### Options

| Option                   | Default                   | Meaning                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                    | `{}`                      | Environment variables set for every sandboxed command, above `AI_AGENT=eve` and below each call's own `env`.                                                                                                                                                                                                                                                                          |
| `networkPolicy`          | `"allow-all"`             | `"allow-all"` shares the host network, `"deny-all"` gives the sandbox none, and an allow-list of domains and subnets admits only those; a domain can carry rules that set headers on its requests. A policy the provider cannot enforce is rejected, not weakened. See [Network policy](#network-policy).                                                                             |
| `hidePaths`              | `[]`                      | Extra host paths hidden from the sandbox (each covered by an empty tmpfs).                                                                                                                                                                                                                                                                                                            |
| `bwrapPath`              | `"bwrap"`                 | bwrap executable to invoke.                                                                                                                                                                                                                                                                                                                                                           |
| `pythonPath`             | `"python3"`               | Python 3 executable. Every command joins its sandbox through a short helper it runs.                                                                                                                                                                                                                                                                                                  |
| `opensslPath`            | `"openssl"`               | OpenSSL executable, used only by a network policy whose domains carry rules.                                                                                                                                                                                                                                                                                                          |
| `cacheDir`               | eve's sandbox storage dir | Absolute directory holding durable session workspaces. Templates always stay in eve's storage directory, where eve records them. Pin this outside the release directory: eve keys sandboxes per durable session, not per deployment, so a build-relative default loses every session's `/workspace` on the next redeploy.                                                             |
| `runTimeoutMs`           | `600000`                  | Hard wall-clock limit for every command a caller starts. At the limit the command's process group is killed and `wait()` rejects with `command timed out after <n> ms`. A long-running process started with `spawn()` (a dev server, a watcher) is bounded too. A process a command leaves behind in its own process group is not; see [Background processes](#background-processes). |
| `maxConcurrentProcesses` | `64`                      | Maximum commands running at once in one session's sandbox. A spawned process counts until it actually exits, even when its caller never waits. Processes left running in the background are not counted. Set `null` to disable.                                                                                                                                                       |
| `maxOutputBytes`         | `16777216`                | Maximum combined stdout and stderr bytes one command delivers to its caller, counted as the caller reads them. At the limit both streams fail with `command output exceeded <n> bytes` after the bytes that fit, the process group is killed, and `wait()` rejects with the same error. Set `null` to disable.                                                                        |
| `onEvent`                | `undefined`               | Best-effort structured lifecycle sink for generation, command, and cleanup events. Sink failures are ignored so telemetry cannot change command behavior.                                                                                                                                                                                                                             |

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
- **connection.spawn**: the first command of a compute generation starts the sandbox's
  **holder**, one long-lived bwrap — read-only host root, the session directory bound
  read-write at `/workspace`, a tmpfs `/tmp`, PID/IPC/UTS namespaces unshared,
  `--die-with-parent`, `--clearenv` — that then idles. Every command joins the holder's
  namespaces through a short Python helper and runs under `env -i`, so commands share `/tmp`
  and one process table. The helper joins every namespace with one `setns(2)` on a pidfd:
  bwrap nests the sandbox's user namespace inside the one that owns the others, and only a
  single call may join both. Each command is bounded by `runTimeoutMs` and `maxOutputBytes`
  and counts against `maxConcurrentProcesses`; its process group is killed when a limit or
  the caller's abort signal fires. A holder that has died — a sandboxed command can kill it,
  and so can the host under memory pressure — is replaced by the next command; the workspace
  is untouched and only the sandbox's processes and `/tmp` are lost.
- **connection.readFile / writeFiles / removePath**: host-side operations on the session
  directory; no subprocess. Writes and removals outside `/workspace` are refused.
- **connection.stop**: kills the session's commands and its holder, which ends every other
  process in the sandbox, and keeps the workspace. The next `start` or `resume` opens a
  fresh compute generation over the same files.
- **connection.close** (end of every step): releases nothing. The compute generation outlives
  the step; `stop`, the idle stop, server exit, and bwrap's `--die-with-parent` end it.
- **setNetworkPolicy**: `"allow-all"` runs in a holder that shares the host network, and
  every other policy in one with a network namespace of its own. A holder's network namespace is fixed when
  it starts, so moving between the two ends the holder and the next command starts another.
  Whatever was left running ends with it — a process started with the network cannot keep
  it after `"deny-all"` — and `/tmp` starts empty again; commands still running when the
  policy changes finish first. Moving among `"deny-all"` and allow-lists restarts nothing
  and takes effect at once, on processes already running too.
- **onSessionIdle** (the session has been idle for `idleTimeoutMs`, eve 1.1 and later): stops
  the live generation if this process holds one, as `connection.stop` does, and starts
  nothing otherwise.
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
- `/tmp` and the process table belong to the sandbox, not to one command: a later command
  sees the files an earlier one left in `/tmp` and can signal the processes it left running.
  Both last until the sandbox's compute stops; only `/workspace` survives that.
- `AI_AGENT=eve` (eve's `SANDBOX_AGENT_ENV`) is set in every command, beneath `env` and each
  call's own `env`, so agent-aware CLIs skip interactive prompts.
- Keyed `invokeTool` calls cannot keep a sandbox (`toolSessions` is not set): eve never ends
  such sandboxes, and this provider has no retention bound for them.

### Background processes

A process a command puts in the background (`server &`) keeps running after the command
returns. Redirect its output: a background process that still holds the command's stdout or
stderr keeps those streams open, and a caller reading them to the end waits with it. eve's
bash tool relies on background processes: a command still running after the tool's yield
window is handed off as a background job, and later commands check on it through the files
it writes under `/tmp/.eve/jobs` or stop it with `kill`.

Such a process is not a command the provider is waiting on, so `runTimeoutMs`,
`maxOutputBytes`, and `maxConcurrentProcesses` do not apply to it. It ends when the
sandbox's compute does:

- the session goes idle for `idleTimeoutMs` (eve 1.1 and later; on eve 1.0 nothing stops an
  idle sandbox, so a background process there runs until one of the following);
- `sandbox.stop()`, the session's end, or `sandbox.delete()`;
- `setNetworkPolicy()` moves between `"allow-all"` and a restricted policy;
- the agent process exits.

A command that runs past `runTimeoutMs` is killed together with its process group, which is
everything it started that did not move to a process group of its own, as `setsid` or a job
under `set -m` does. `/tmp` is a tmpfs, so what is written there counts against the memory
of the cgroup the agent runs in until the sandbox stops.

### Network policy

| Policy                                | What a command can reach                                 |
| ------------------------------------- | -------------------------------------------------------- |
| `"allow-all"` (default)               | Whatever the host can: the sandbox shares its network.   |
| `"deny-all"`                          | Nothing. Only loopback exists inside the sandbox.        |
| `{ allow, subnets: { allow, deny } }` | The listed domains and address ranges, and nothing else. |

An allow-list denies by default. `allow` lists domains: `example.com` matches that host
only, `*.example.com` every subdomain but not `example.com` itself, `www.*.com` one label in
that position, and `*` any domain. `subnets.allow` lists CIDRs reachable by address, with no
domain needed, and `subnets.deny` lists CIDRs that are never reachable, even through an
allowed domain or range. eve's record form, `{ allow: { "example.com": [] } }`, maps each
domain to the [rules](#rules-on-a-domain) applied to its requests; an empty list allows the
domain as it is.

A sandbox under an allow-list has a network namespace of its own, with no interface but
loopback. A helper on the host enters that namespace and loads nftables rules into it, so
the kernel hands every TCP connection a sandboxed program opens, and every DNS query it
sends, to the helper. The helper relays each one to a gateway in the agent process, along
with the destination the program asked for, and the gateway opens a connection only to a
destination the policy allows.

No program is asked to cooperate. Nothing is set in a command's environment, and `ssh`, a
database client, or a bare socket is captured exactly as `curl` is. The sandbox's processes
hold no capability over their network namespace, so they cannot remove the rules.

How a connection is matched:

- **By domain.** The name is read from the connection itself: the server name in a TLS
  handshake, or the `Host` header of a plain HTTP request, on any port. TLS is passed
  through undecrypted, unless the domain carries rules. The gateway resolves the name itself and connects to an address it
  resolved, not to the one the program chose, so naming an allowed domain while connecting
  somewhere else reaches only the allowed domain.
- **By address.** A destination in `subnets.allow` is reached whatever protocol is spoken to
  it. That is how to allow a protocol that names no domain when it connects: SSH, or one
  that starts TLS only after a plaintext exchange, as Postgres does by default and SMTP
  does with `STARTTLS`. A connection that has not named a domain within five seconds is
  treated as naming none.
- **`*`** admits every destination, traffic that names no domain included.
- **The host's own addresses** — loopback, link-local (where cloud metadata services live),
  and the unspecified address — are reached only through a `subnets.allow` range that names
  them, never through a domain or `*`. The gateway connects from the host's network, and a
  domain that resolved to one of them would otherwise reach a service the host never meant
  to publish.
- **DNS.** A query to any server is answered by the gateway. A name the policy allows is
  passed to the host's own resolvers; any other is answered as nonexistent and never leaves
  the host. A policy with a `subnets.allow` range leaves every name resolvable, so that
  names inside the range can be found.
- **Everything else** — other UDP, ICMP — reaches nothing. HTTP/3 clients fall back to TCP.
  IPv6 is captured like IPv4 where the kernel has nftables NAT for it; where it does not,
  IPv6 destinations are unreachable and programs fall back to IPv4.

A refused connection is answered in the protocol it spoke: a `403` for HTTP, a fatal
`access_denied` alert for TLS, and a closed connection for anything else. Each refusal emits
a `network.denied` event; a refused lookup reports the name with port 53.

An allow-list needs `nft` and `ip` on the host; see [Requirements](#requirements). On a
host that cannot enforce one, a command under an allow-list fails with the reason instead
of running without a route, and a sandbox already running keeps the policy it had.

#### Rules on a domain

A rule sets headers on the requests a domain receives. It is how a credential reaches a
service without entering the sandbox: the sandboxed program sends a placeholder, or
nothing, and the gateway puts the real value on the request as it leaves the host.

```ts
await sandbox.setNetworkPolicy({
  allow: {
    "api.github.com": [
      {
        match: {
          headers: [{ key: { exact: "authorization" }, value: { exact: "Bearer placeholder" } }],
        },
        transform: [{ headers: { authorization: `Bearer ${token}` } }],
      },
    ],
    "*": [],
  },
});
```

- **Which rule applies.** A domain's rules are those of the most specific pattern that
  matches it: `github.com` decides over `*.github.com`, and that over `*`. The first rule
  whose `match` a request satisfies handles it, and no other; a rule without `match` handles
  every request. A request no rule matches goes out as the program sent it.
- **`match`.** Every part given must hold. `method` lists methods, any one of which matches.
  `path` is the request path without its query string. `headers` and `queryString` list
  matchers, each of which some header or parameter must satisfy by its `key`, its `value`,
  or both. A matcher is one of `exact`, `startsWith`, or `regex`; comparison is
  case-sensitive except against a header name. `regex` is a JavaScript regular expression,
  which is not the RE2 syntax Vercel Sandbox documents: a pattern can run in more than
  linear time, and it runs in the agent process against input the sandbox chose.
- **`transform`.** Each step's `headers` are set on the request, replacing any header of
  the same name. Headers that frame a request (`content-length`, `transfer-encoding`,
  `connection`, and the like) cannot be set.
- **`forwardURL`** is not supported, and a policy that uses it is rejected.

To apply a rule the gateway has to read the request, so it answers the program's TLS
handshake itself, with a certificate issued for the name the program asked for by a
certificate authority made for that one sandbox. It then sends the request on over a TLS
connection of its own, verifying the service's certificate against the host's roots as any
client would. What follows from that:

- **Trust.** A command started while the policy has rules is told to trust the sandbox's
  authority through the variables common clients read: `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `NPM_CONFIG_CAFILE`, `AWS_CA_BUNDLE`,
  `CARGO_HTTP_CAINFO`, `GRPC_DEFAULT_SSL_ROOTS_FILE_PATH`, and `NODE_EXTRA_CA_CERTS`. They
  name files under `/tmp/.bwrap-sandbox`, which hold the host's roots and the authority's
  certificate. The call's own `env` and the environment's `env` still decide over them. A
  process started before the policy had rules, or a client that reads none of these
  variables (a JVM, for one), does not trust the authority and fails its handshake with a
  domain that has rules.
- **HTTP/1.1 over TLS only.** The gateway offers HTTP/1.1 in the handshake, so a client that
  would use HTTP/2 falls back and one that speaks only HTTP/2, as gRPC does, cannot connect.
  A domain with rules is not reachable over plain HTTP at all: a rule sets credentials, and
  those do not go out over a connection anyone can read. Protocol switches such as
  WebSocket are passed through, with the rules applied to the opening request.
- **One host per connection.** A request whose `Host` names anything but the domain the
  connection was made to is refused with a `421`. Otherwise a program could have a
  credential, set for one domain, delivered to another site served from the same address.
- **Addresses bypass rules.** A destination reached through a `subnets.allow` range is
  passed on unread, as that range promises, so no rule applies to it. Beside a `*`, a
  connection that names no domain is passed on unread too, after a wait of at most one
  second to see whether it names one.
- **Changing rules.** Each request gets the rules in force when it arrives. A connection
  open when a domain gains or loses its rules is closed, so none carries on being handled
  the old way.
- **What is recorded.** Rules hold credentials, so the state eve persists for a session
  names the domains that had rules and nothing of what the rules held. A sandbox started
  again for the session, after an idle stop or a restart of the agent, gets the
  environment's own `networkPolicy` with its rules when that is the policy it was opened
  under. Rules passed to `environment.open()` or set with `setNetworkPolicy` last only for
  the running sandbox: after a restart their domains are allowed without rules until the
  session sets them again.

Rules need OpenSSL 3 on the host; see [Requirements](#requirements). On a host without it a
policy with rules is refused with the reason, and a sandbox already running keeps the
policy it had.

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
`command.finished`, `network.denied`, `cleanup.started`, `cleanup.completed`, and
`cleanup.failed` events. `network.denied` carries the host and port the network policy
turned away, never a path, a header, or a body.
They include session/generation/command identities, tags, PID/process-group identity when
available, duration, output byte counts, live-process counts, finish reason (`exit`,
`abort`, `timeout`, `output-limit`, `killed`, `cleanup`), and cleanup errors. Events omit
command text and output. Do not put secrets in `tags`; the sink is operator-controlled
telemetry, not part of the sandbox boundary.

## Security boundary

- The host process environment is **never** forwarded: the holder runs under `--clearenv`,
  and every command under `env -i` with `PATH`, `HOME=/workspace`, `LANG`, `AI_AGENT=eve`,
  your configured `env`, and the call's own `env`. Secrets in the agent's `process.env` stay
  out of sandboxed code. A call's own `env` is set for that command only; it is not in the
  holder's environment.
- Commands of one session share a sandbox: they can read each other's `/tmp`, signal each
  other's processes, and kill the holder, which ends the sandbox's processes and nothing
  else. That is one trust domain, the session's.
- A command joins the sandbox through the helper, not through a bwrap of its own. Like a
  bwrap child it runs as the agent's own uid, with no capabilities and with `no_new_privs`
  set, and the user namespace maps that one uid, so a setuid or file-capability binary owned
  by anyone else, root included, gains nothing. Before joining, the helper checks that the
  process it is about to join is in the mount namespace bwrap reported for the holder, so a
  reused pid is refused instead of joined.
- The cache roots — every session workspace and template of the app — are hidden from
  sandboxed commands behind a tmpfs, as are `hidePaths`. Which paths exist is decided when
  the holder starts: a path created on the host afterwards is hidden from the next holder
  on. The rest of the host filesystem is
  _visible read-only_. To keep other applications' files out of view, run the agent itself
  in a boundary that hides them (a systemd unit with `TemporaryFileSystem=`/`BindPaths=`,
  or a container); bwrap only re-exposes what the agent process can already see.
- The network is shared with the host under `"allow-all"`, the default. `"deny-all"` leaves
  only loopback. Under an allow-list the kernel hands everything that leaves the sandbox to
  a gateway in the agent process, which connects from the host's network: a name or range
  the policy allows is reached with whatever the host can reach at that address. The
  host's own loopback and link-local addresses are excluded unless a `subnets.allow` range
  names them; use `subnets.deny` to rule other ranges out. Three things an allow-list does
  not do. It does not decrypt TLS for a domain without rules, so a server that hosts several
  domains at one address decides which of them a request inside the handshake reaches:
  allowing one domain on a shared CDN can reach others on it. A `subnets.allow` range leaves DNS unrestricted, and a
  lookup can carry data to whoever serves the name. And a sandboxed program that can see
  the gateway's socket, which lives in the agent's temporary directory, can connect to it
  directly; it is held to the same policy there.
- A rule's header values stay in the agent process: they are set on a request after it has
  left the sandbox, and are never written to the sandbox's environment, its files, session
  state, or an event. The sandbox does trust a certificate authority of its own while a
  policy has rules, and its programs' requests to those domains are read in the agent
  process. The authority's key is kept in a directory hidden from the sandbox, and nothing
  outside that sandbox trusts the authority. A rule constrains nothing by itself: a program
  that sends a request no rule matches reaches the domain all the same, without the header.
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
  sandbox children too, background processes and `/tmp` included. `maxConcurrentProcesses`
  is an admission bound, not a kernel PID or thread quota; `runTimeoutMs` and
  `maxOutputBytes` bound each command's wall-clock time and delivered output. No per-command
  cgroup or CPU/memory quota is created.
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
- Linux 5.8 or newer, and Python 3 with `ctypes` on the agent's `PATH` (or at
  `pythonPath`), plus `/usr/bin/env`. Every command joins its sandbox through them: the
  join is one `setns(2)` on a pidfd, which is what the kernel version is for. It needs no
  privilege beyond what bwrap already needs, because the agent's user owns the holder's
  user namespace. A missing Python fails with an actionable message before anything runs;
  an older kernel fails each command with exit code 125 and the reason on its stderr.
- For an allow-list network policy only: `nft` (nftables) and `ip` (iproute2) in a standard
  system directory such as `/usr/sbin`, and nftables NAT in the kernel. The helper that
  loads the rules needs no privilege beyond what bwrap already needs: it enters the user
  namespace bwrap created, which the agent's user owns. `"allow-all"` and `"deny-all"` need
  neither.
- For rules on a domain only: `openssl`, version 3 or newer, on the agent's `PATH` (or at
  `opensslPath`). It issues the certificates the sandbox's requests are read under.
- `bash`, plus whatever tools the agent needs (`node`, `git`, …), on the host `PATH`.
- Works under systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`): the
  packaged `bwrap` is not setuid, so it needs no privilege escalation, only the AppArmor
  grant above. A unit that sets `RestrictNamespaces=` or filters `setns` or `pidfd_open`
  breaks bwrap, the join, or both. systemd's PID 1 reaps orphaned bwrap descendants.
- Inside a container, run with an init process (`docker run --init`) so orphaned bwrap
  descendants are reaped instead of accumulating as zombies, and grant what nested bwrap
  needs to create namespaces (for example `--cap-add SYS_ADMIN --cap-add NET_ADMIN
--security-opt seccomp=unconfined`). The container's filesystem is then the "host"
  filesystem sandboxed commands see read-only.

## Testing

- `pnpm test` — unit tests, run anywhere, including macOS: process execution is injected,
  so no bwrap is needed. The tests that answer a TLS handshake under a domain's rules use
  the host's `openssl` and are skipped where it is older than version 3. `pnpm typecheck` runs the type-level contract checks against the
  installed eve in `src/eve-compatibility.test.ts`.
- `bash infra/smoke.sh` — the contract test against **real** bwrap, on macOS or Linux. It
  provisions a Lima VM (`brew install lima`), streams this worktree in, and runs the test as
  an unprivileged user under the systemd hardening a deployed agent gets
  (`NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`). Prints
  `BWRAP SMOKE OK`. Run it before pushing anything that touches `src/args.ts`, `src/holder.ts`, or
  `src/process.ts`: CI's smoke job covers the unprivileged-user case but not the systemd
  constraints, and argv that looks right is not the same as a kernel that accepts it.
- `pnpm tsx src/integration/bwrap-smoke.ts` — the same test, run directly. Needs a Linux
  host with the AppArmor profile loaded and `/workspace` created (see
  [Requirements](#requirements)), run as an unprivileged user.

## License

Apache-2.0. See [LICENSE](./LICENSE).
