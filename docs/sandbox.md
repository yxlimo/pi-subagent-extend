# The sandbox

`packages/helper` is one Rust binary with no runtime dependency. It confines **itself** and then
`exec`s the command, so an allowlisted `bash` command becomes a process whose files, network and
processes are already fixed.

An allowed command is rewritten to:

```text
<helper> --spec ~/.cache/pi-subagent-extend/spec-<pid>.json -- bash -lc '<command>'
```

The spec carries the resolved paths, the offline flag, the environment and the target directory.
Two subcommands matter: `--spec` runs a command, `--describe` prints the capabilities as JSON and
exits 0, or 76 when the kernel is not good enough. `PI_SUBAGENT_EXTEND_HELPER` overrides the
binary path; the build is `pnpm run build:helper`, and the artifact lands in
`packages/pi-plugin/bin/`, which is gitignored.

Order inside the helper: enter the namespaces → `chdir` → Landlock → drop capabilities → `exec`.
The command runs under a supervising PID 1 (see below), never as PID 1 itself.

## Files

A Landlock ruleset. `/` stays readable and executable, so `cat` can read outside the scope as
noted in [architecture](architecture.md#boundaries), and only these are writable:

- the scope, when `bash.writable` is set
- the working directory, without which git cannot even write its index
- `<cwd>/node_modules`, resolved through symlinks, because pnpm writes the shims in `.bin`
- the worktree root, since a scope usually names paths relative to it while root-level
  `package.json` and `node_modules` lie outside
- the repository's common git directory in a linked worktree (`git rev-parse --git-common-dir`),
  which holds the index and refs — without it `git add`, `git commit`, `git stash` and
  `git switch -c` fail on `<common>/worktrees/<id>/index.lock` or `<common>/refs`
- `bash.writablePaths` entries, and the device nodes below
- the temporary directories: the one the command itself uses (the host's `TMPDIR`, or a `TMPDIR`
  pinned through `bash.env`, `/tmp` when neither is set) and the conventional `/tmp`, which the
  extension's own runtime and state directories point into. Both are shadowed by the private tmpfs
  described under [Namespaces](#namespaces) — granting a directory that is *not* mounted over would
  be a host write, not a sandbox one, which is why the former is now named in the spec's `tmp`

A write outside them fails with `EACCES`. Landlock rules attach to the resolved inode, so a
symlink inside a granted directory that points outside stays read-only: the rule follows the
target. `node_modules` is the one deliberate exception, realpath'd before being granted.

A read-only sandbox gets none of the worktree or git-directory grants — silently widening the main
repository's `.git` is worse than a failing git command.

The kernel requirement is **Landlock ABI 7 (Linux 6.15 or later)**. Below that the extension does
not support the sandbox at all rather than falling back to weaker rules, and `--describe` reports
the measured ABI with `supported: false` — the number is the diagnosis, so it is never replaced by
a placeholder.

## Namespaces

Unshared in the helper, before Landlock:

- **User**, needed for the rest, plus a uid/gid map. The ids are captured **before** the unshare:
  after `unshare(CLONE_NEWUSER)` `getuid()` returns the overflow id 65534, and a map written from
  that fails with `EPERM`.
- **Mount**, always, which is what gives the command a private scratch space — an unmixed tmpfs over
  the conventional `/tmp` and, when the command's own temporary directory is somewhere else (the
  host's `TMPDIR` is not always `/tmp`), over that directory too. The extension names it in the
  spec's `tmp`; the helper defaults to `/tmp` alone when the field is absent, so a spec written by an
  older extension still reads. A directory that contains the working directory is skipped, since the
  tmpfs would hide it.
- **Network**, only for an offline command. See below.
- **PID**, always, with a freshly mounted `/proc`, so only the sandbox's own processes are visible:
  host processes cannot be seen, another process's `/proc/<pid>/environ` cannot be read, and no
  signal crosses the boundary. Mounting procfs only happens when a PID namespace was entered —
  from outside one it would fail and hide nothing anyway.

PID 1 of a namespace does not get default signal dispositions, so `kill <helper>` would leave a
shell that ignores `SIGTERM`. The tree is:

```text
caller ── helper ──┬─ init   (PID 1, forwards signals, sets PDEATHSIG)
                   │   └─ the command
                   └─ waits, mirrors the exit status
```

The supervisor forwards `SIGTERM`, `SIGINT`, `SIGHUP` and `SIGQUIT`, and `PDEATHSIG` makes the
whole namespace die with the caller. Exit status is mirrored, a signal death becoming `128 + N`.

Before `exec` the bounding set and the effective set are cleared, so `CapEff` and `CapBnd` are both
zero, matching the bubblewrap defaults.

## Offline means "no route out"

The network namespace starts empty; its loopback interface is brought up with
`SIOCSIFFLAGS` and nothing else exists in it. There is no route, so a connection fails with
`ENETUNREACH` and a name lookup with `EAI_AGAIN`. The `nscd` and `systemd-resolved` socket
directories are shadowed with an empty tmpfs, because a unix socket crosses a network namespace —
without that, host names would still resolve.

Loopback being **up** is the point. Landlock's network rules are per port and cannot express "only
loopback", so an earlier version that handled `ConnectTcp` refused the local connections a test
suite needs. Measured, with the rules in place: `bind 127.0.0.1` succeeded and the loopback client
in the same sandbox got `EACCES` — a server nothing can connect to. Handling `BindTcp` instead and
leaving `ConnectTcp` open has the mirror problem. The namespace is the mechanism that actually
expresses the requirement, so an offline command gets **no Landlock network rules at all**.

Measured on ABI 11:

| Scenario | Result |
| --- | --- |
| local round trip (server and client in one sandbox) | `CONNECTED` / `pong` |
| `bind 127.0.0.1`, `bind 0.0.0.0` | ok |
| `connect 1.1.1.1:80` | `ENETUNREACH` |
| `dns.lookup("github.com")` | `EAI_AGAIN` |
| control, `offline: false` | `CONNECTED` |

The guarantee is structural: there is no interface to leave by, capabilities were dropped after
the namespaces were set up, and the resolver directories are shadowed. It would break if a veth
pair were ever added to that namespace, which is a design convention rather than something the
code can enforce.

## When the host refuses namespaces

Some hosts create the user namespace and then refuse `setgroups`, mount, network and PID. Measured
on GitHub's runner (Ubuntu 26.04, `apparmor_restrict_unprivileged_userns=1`): `unshare(NEWUSER)`
succeeds, `setgroups` fails with `EPERM`, and `unshare` of mount, network and PID all fail with
`EPERM`. With the restriction lifted, all four succeed.

The helper degrades rather than fails, and says so on stderr:

- Landlock takes over the network cut, since the namespace that gave it structurally is missing.
  The port rules are coarse — loopback is refused along with everything else, so a local server
  cannot be reached — and a refused connect reads as `EACCES` instead of `ENETUNREACH`.
- There is no private scratch directory and no process hiding, because those came from the mount
  and PID namespaces.
- Procfs is not remounted.

Scope enforcement, the file rules and the capability drop are unaffected: they are Landlock and
`prctl`, not namespaces.

## Devices

`/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty` and `/dev/pts` are
writable by default, those that exist. Without them a redirect such as `2>/dev/null` fails
outright.

## What the helper does not do

No seccomp. The contract is preventing out-of-scope writes and network access for delegated,
allowlisted commands, not defending the kernel against hostile code; seccomp would shrink the
syscall surface and break ordinary commands in exchange. No read confinement, for the same reason
it is not in the extension: a test suite has to read the tree.
