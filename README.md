# pi-subagent-extend

> Formerly `pi-allow-reads`, then `pi-subagent-permission`. The current name reflects a
> wider scope: everything subagent-related in one package, covering both permissions and
> context isolation. The binding namespace, the environment variable, the helper binary and
> the skill directories changed with each rename, and the former identifiers are no longer
> accepted.

A pi extension that confines the files a session, subagents in particular, may touch to the
scope of its task. The parent agent names the files and directories the task covers when it
delegates; any tool call outside that scope in the subagent's session is refused, which
keeps a subagent from wandering through the repository.

The same package handles a second, independent concern: **context isolation**. A section of
`AGENTS.md` fenced by `<!-- main-agent-only:start -->` and `<!-- main-agent-only:end -->`
never reaches a subagent's prompt, and content that belongs entirely to the main agent lives
in `.pi/main-only.md`, which is injected into the main session only. Either concern can be
used without the other; see [Context isolation](#context-isolation).

| npm package | directory | host | what it does |
| --- | --- | --- | --- |
| `pi-subagent-extend` | `packages/pi-plugin` | pi extension | reads the task scope when a session activates and refuses, at the `tool_call` stage, every call outside it |

## Layout

```text
packages/pi-plugin         pi extension (src/, test/{extension,context}.test.mjs, install.sh, skills/pi-subagent-extend{,-probes,-context}/SKILL.md)
packages/helper            sandbox helper (Rust: Landlock plus network, mount and PID namespaces; the build artifact lands in packages/pi-plugin/bin/)
packages/worktree-setup    the pi-subagents worktreeSetupHook (a standalone script, see below; not an extension yet)
```

`src/` holds three entry points: `index.ts` for scope and bash, `main-context.ts` for the
main-agent side of context isolation (loaded ambiently), and `child-context.ts` for stripping
the markers in subagents (declared by the agent definition).

## worktree initialisation hook (packages/worktree-setup)

pi-subagents can run a setup hook once a worktree exists and before the subagent starts. This
repository ships one: a POSIX shell script that runs whatever the project declares. It exists
because pi-subagents links the main checkout's `node_modules` into a new worktree through
`linkNodeModulesIfPresent` — which makes a worktree that installs nothing usable, but the link
points at whatever the main checkout happens to have installed, and both directions are wrong:

- **No install.** The worktree declares a dependency that the main checkout's tree does not have
  (someone added it to the manifest earlier and nobody reinstalled), so the subagent gets
  `Cannot find module` for a package that is right there in its own `package.json`. Measured: the
  worktree resolves `is-number` from `<main>/node_modules/.pnpm/...` and fails on `left-pad`.
- **Install runs.** It follows the link into the main checkout: same inode, but the main checkout
  gains the packages the worktree asked for — measured 4 → 5 top-level entries with nothing added
  to the main checkout's own manifest.

So the hook removes that link before running the declaration (a real directory is left alone) and
the project decides what to install.

Only a symlink is installed globally; the script itself is versioned here:

```text
~/.pi/agent/extensions/subagent/worktree-setup.sh -> packages/worktree-setup/worktree-setup.sh
```

```json
// ~/.pi/agent/extensions/subagent/config.json
{
  "worktreeSetupHook": "~/.pi/agent/extensions/subagent/worktree-setup.sh",
  "worktreeSetupHookTimeoutMs": 300000,
  "worktreeBaseDir": "~/.pi/worktrees"
}
```

**A project opts in by committing `.pi/worktree-setup.sh`.** Without that file the hook exits
immediately and changes nothing, which is why a single global script serves every project. The
hook runs with the worktree root as its working directory, so the declaration is simply
sourced there as a script:

```sh
#!/bin/sh
# .pi/worktree-setup.sh — single-package repository
set -eu
pnpm install --prefer-offline
```

```sh
#!/bin/sh
# .pi/worktree-setup.sh — this repository: the manifest lives in packages/pi-plugin, and
# pnpm fails with ERR_PNPM_NO_PKG_MANIFEST in a directory that has no package.json
set -eu
cd packages/pi-plugin
pnpm install --prefer-offline
```

Because it is an ordinary shell script, `cd`, conditionals and environment variables need no
support from the hook.

**The exit code is the whole contract.** The hook does not second-guess what a usable worktree
is: the declared script decides, and exits non-zero when it did not get one. That matters in
practice, because pnpm 12 installs every package and then exits non-zero for dependency build
scripts it was not allowed to run (`ERR_PNPM_IGNORED_BUILDS`); a project that hits this says so
in its own script rather than relying on the hook to guess.

On failure the hook prints the last 20 lines of the script's output and the log path. Output is
kept in `~/.cache/pi-worktree-setup/<worktree directory name>.log`.

Two boundary notes:

- The hook is POSIX shell, so it runs where a shebang is honoured: Linux, macOS, the BSDs. A
  Windows hook would have to be a native executable, because pi-subagents starts it with
  `spawn(hookPath, [], { shell: false })` and Node refuses to run `.cmd`/`.bat` that way.
- mise trust is the project's responsibility (`trusted_config_paths`). When a worktree's
  configuration is not trusted, every shimmed command there fails, including `pnpm` in the
declared script; the hook only names that cause when it sees `not trusted` in the output.


## Behaviour

The extension fails closed: while a scope is active, any tool not listed below is refused as
well.

| Tool | Behaviour |
| --- | --- |
| `read` | Resolves the path, treating a missing one as the working directory, and allows it when it falls inside the scope. Subject to the `maxReads` budget. |
| `edit` / `write` | As above; refused even inside the scope when `readOnly` is set. |
| `grep` / `find` / `ls` | As above, with a missing path defaulting to the working directory. |
| `bash` | Refused entirely without an allowlist. With one, only commands matching `bash.read` or `bash.write` are allowed, and they are rewritten to run under the sandbox helper, which enforces the file scope through Landlock, cuts the network by default and grants write access to the scope only when `writable` is set. A command containing shell metacharacters is refused. |
| `bash.writablePaths` | Additional writable paths, for globally writable areas such as the pnpm store or the mise state directory. |
| `bash.writable` in a linked worktree | The worktree root plus the repository's common git directory (`git rev-parse --git-common-dir`). The index and refs live there, so without it `git add`, `git commit`, `git stash` and `git switch -c` fail on `<common>/worktrees/<id>/index.lock` or `<common>/refs`. A read-only sandbox gets neither. |
| `bash.env` | Environment variables injected into the sandbox. |
| `powershell` / `codemode` | Always refused: there is no path to judge, so they can escape the scope. |
| `structured_output` | Allowed; a session-level runtime tool that does not touch the filesystem. |
| `contact_supervisor` / `intercom` | Always allowed; a subagent asking the supervisor for a decision is a legitimate channel. |
| Any other unknown tool | Refused, except tools named in `allowTools`; executor-type tools stay refused. |

When a scope is active the session announces it at the start. `/permission` shows the active
scope, mode, bash allowlist, read count, denial count and probe state.

### Probes

Four criteria detect a subagent that is going in circles or colliding with its permissions.
The two error-signal criteria are on by default, since they misfire rarely. The two
time-based criteria misfire on slow tasks, so they apply only when configured explicitly:
`time-based criteria misfire on slow tasks, so they apply only when configured explicitly:
`"probe": {}` enables every default, `"probe": true` does the same, a partial object enables
only the fields it names, and `"probe": false` disables all of them.

| Criterion | Default | Behaviour |
| --- | --- | --- |
| Read-only idling | Explicit: `idleWriteMs: 360000`, `abortGraceMs: 120000` | No write activity within `idleWriteMs` produces a warning at the next tool boundary; after a further `abortGraceMs` the turn stops. |
| Repeating a command | On by default, `repeatBash: 3` | The third identical bash command warns and the fourth stops. |
| Finished early | Explicit: `successIdleMs: 300000`, `successPatterns` | Once bash output matches a success marker, no new change within `successIdleMs` stops the turn. |
| Writing litter | Explicit: `forbidWritePatterns: []` | A `write` or `edit` target matching the pattern is refused outright. |

Write activity means `edit` and `write` calls and commands matching `bash.write`. Commands
matching `bash.read`, together with `read`, `grep`, `find` and `ls`, do not count; otherwise a
subagent could circle using read-only bash and escape the criterion. A task with
`readOnly: true` skips the two time-based criteria, read-only idling and finished early,
which are meaningless for it; repeating a command still applies.

`maxDenies` defaults to five and an explicit `0` disables it. After that many consecutive
grant refusals the subagent is warned that the parent most likely authorised the wrong paths,
and is told to escalate; one more refusal ends the run.

The stop is a hard one: every blocked result carries `terminate`, so pi ends the turn as soon
as the whole batch is terminating. There is no closing report after a stop — the parent reads
what the subagent produced before it, plus the refusal text. That is why the escalation path
matters: `contact_supervisor` and `intercom` are checked before every stop mechanism, so a
subagent being refused can still report what it is missing. Measured in a real session: after
the second counted refusal the run went straight to `agent_end` with no further assistant
message.

### The bash allowlist and the sandbox

When a subagent needs to run tests or a type check, the parent names the commands in the
bindings:

```json
{ "pi-subagent-extend/1": { "scope": ["lib/router/**"], "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] } } }
```

An allowed command is rewritten to:

```text
<helper> --spec ~/.cache/pi-subagent-extend/spec-<pid>.json -- bash -lc '<command>'
```

The helper is the Rust binary in `packages/helper`, built by `pnpm run build:helper`. It
confines **itself** before calling `exec`, so an allowlisted command is a process whose file
scope and network are already fixed:

- **Files**: a Landlock ruleset. `/` stays readable and executable, and only the paths named
  in the spec are writable: the scope, the working directory, `node_modules`, the
  `bash.writablePaths` entries, the device nodes below and the host temporary directory. A
  write outside them fails with `EPERM`.
- **Network**: a private network namespace, so TCP, UDP and DNS are all unreachable and only
  the loopback interface remains. A private mount namespace additionally shadows the
  `nscd` and `systemd-resolved` unix socket directories with an empty tmpfs, because a unix
  socket crosses a network namespace and host names would otherwise still resolve.
- **Processes**: a private PID namespace with a freshly mounted `/proc`, so only the
  sandbox's own processes are visible. Host processes cannot be seen, another process's
  `/proc/<pid>/environ` cannot be read, and no signal reaches across the boundary. PID 1 is
  a supervisor that forwards signals and the command runs beneath it, so `kill` terminates
  the command instead of being ignored by PID 1.
- **Capabilities**: the bounding set and the effective set are cleared before the command
  starts, matching the bubblewrap defaults, so `CapEff` and `CapBnd` are both zero.
- **`/tmp`**: a private tmpfs, unmixed with the host's temporary files. It is skipped when
  the working directory itself lies under `/tmp`, which would otherwise hide it.
- **Devices**: the device nodes `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`,
  `/dev/urandom`, `/dev/tty` and `/dev/pts` are writable by default, those that exist; without
  them a redirect such as `2>/dev/null` fails outright.

The kernel requirement is **Landlock ABI 7 (Linux 6.15 or later)**. Below that the extension
does not support the sandbox at all rather than falling back to weaker rules. Network
isolation does not depend on Landlock: it comes from the network namespace, and the resolver
socket directories are shadowed because a unix socket crosses that namespace. When the helper
is missing or the ABI is too low, bash stays disabled and the refusal names what is absent;
a host that forbids unprivileged user namespaces fails the command inside the helper instead,
after it has been rewritten. `PI_SUBAGENT_EXTEND_HELPER` overrides the binary path.

- An entry takes one of two forms. A literal is split on whitespace and matched token by
  token as a prefix, so `pnpm test` matches `pnpm test -t foo` but not `pnpm publish`. An
  entry prefixed with `re:` is matched as a regular expression against the whole command,
  for example `"re: ^pnpm -r (test|build)"`. Regular expressions are never inferred, because
  command arguments routinely contain `*` and `.`, and guessing the direction to parse them
  in is how permissions are granted by accident.
- The `read` column allows commands that only read, such as a type check or grep, and the
  `write` column allows commands that write, such as tests and builds. Both columns are
  grants; the classification only feeds the write-activity criterion. A command matching
  both counts as a write.
- A command containing metacharacters such as `; & | < > ( )`, a backtick, `$`, a backslash
  or a newline is refused outright, so an allowlist prefix cannot be extended into another
  command.
- The network is cut and the scope is read-only by default, so writes outside the repository
  and any network access are refused. `"writable": true` grants write access to the
  directories matched by the scope, which is where test artefacts land, and `"network": true`
  restores networking.
- `bash.writablePaths` grants write access to further paths, given as absolute paths, `~`
  paths or paths relative to the working directory, for globally writable areas such as the
  pnpm store.
- `bash.env` holds the environment variables injected into the sandbox, written into the
  spec's `env` field. `XDG_RUNTIME_DIR`, pointing at the sandbox's private `/tmp`, and
  `MISE_STATE_DIR` in a worktree are injected by default.
- A refused bash command reports the detected pnpm store path in the refusal, since the
  model sees that text and can pass it on with what the parent needs to authorise. The
  extension only detects it and never grants it on its own; granting remains the parent's
  explicit decision.
- When `bash.writable` is true, write access additionally covers **the working directory**,
  without which git cannot even write its index; **`<cwd>/node_modules`**, as resolved
  through any symlinks, because pnpm install writes the shims in `.bin`; and **the worktree
  root**, because a scope usually names paths relative to the worktree while the root-level
  `package.json` and `node_modules` lie outside it.
- `bash.gitExcludes`, on by default, injects global git exclusion rules for `node_modules/`
  and `.pnpm-store/`. Inside the sandbox pnpm always uses a project-local `.pnpm-store` (see
  below), and without the exclusion a single `git add -A` would pull tens of thousands of
  dependency files into the index and make patch generation fail.
- A missing helper fails closed: allowlisted commands do not run either, and the refusal
  states the reason and the build command. `PI_SUBAGENT_EXTEND_HELPER` overrides the binary
  path.
- The limit is deliberate: the sandbox prevents **out-of-scope writes and network access**,
  not reads. Running a test suite requires reading the whole tree, `node_modules` and
  configuration files included, so inside the sandbox `cat` can still read files outside the
  scope. Read confinement remains the responsibility of `read`, `grep` and their peers.

## Worktrees, pnpm and mise

A managed worktree is a fresh checkout, so tooling that resolves dependencies per directory
fails there in ways that stay invisible until a subagent runs something. The symptoms and
their handling:

| Symptom | Cause | Handling |
| --- | --- | --- |
| `tsc` cannot find its packages after installing in a worktree | pi-subagents links the main checkout's `node_modules` into the worktree, and pnpm installs through that link instead of replacing it | The hook removes the link before installing. A project that sets `virtualStoreType: global` then installs in well under a second. |
| `pnpm run` refuses to start under a read-only root | pnpm 12 keeps its lock directory under `XDG_RUNTIME_DIR` | The extension points `XDG_RUNTIME_DIR` at the sandbox's private `/tmp`. |
| mise fails while parsing configuration inside the sandbox | it records a new worktree's `mise.toml` in `~/.local/state/mise/trusted-configs`, which is not writable | The extension points `MISE_STATE_DIR` at the sandbox's private `/tmp`. |
| Every mise-shimmed tool exits with `Config files ... are not trusted` on the host | a new worktree's `mise.toml` is untrusted, outside the sandbox as well | Declare `trusted_config_paths = ["<worktree root>"]` in `~/.config/mise/config.toml`. Nothing in this package can compensate for it, and the hook's own interpreter therefore bypasses shims. |
| `pnpm install` fails inside the sandbox | the network is cut and the store is empty | Grant `"network": true` on the command that installs. |
| A `.pnpm-store` of tens of megabytes appears in the project | the global store is not writable under a read-only root, so pnpm falls back to a project-local one | List the store in `bash.writablePaths` to keep the global store; the extension already keeps `.pnpm-store` out of the git index. |

Verifying with dependencies already present needs `verifyDepsBeforeRun: false` in
`pnpm-workspace.yaml`, the only file pnpm 12 reads that setting from.


## Context isolation

`AGENTS.md` enters the prompt in full, so a subagent also reads the passages that matter only
to the main agent, such as how to delegate, how to wait for results and what a report must
contain, which wastes context. This package addresses that as well, choosing between two
mechanisms according to whom the content belongs to:

| Content | Where it goes | Visible to a subagent |
| --- | --- | --- |
| Rules a subagent must follow too (terminology, acceptance commands, code style) | An ordinary section of `AGENTS.md` | Yes |
| Content that reads better alongside the repository rules but concerns the main agent only | A section fenced by `<!-- main-agent-only:start -->` and `<!-- main-agent-only:end -->` in `AGENTS.md` | No |
| Content that concerns the main agent only in its entirety | `.pi/main-only.md` | No |

```markdown
## Terminology

**Upstream** refers to the upstream API.

<!-- main-agent-only:start -->
## Delegation

Delegate with the `subagent` tool and wait for the result before deciding the next step.
A report states which files changed, what was run and how it turned out.
<!-- main-agent-only:end -->
```

The whole span between a pair of markers, including both comments and the trailing blank
line, is removed from a subagent's prompt, while the main agent reads it unchanged. When a
marker is left unterminated, **the section is kept rather than stripped** and the session
records a warning: letting a subagent read one extra passage is preferable to deleting half a
file on a guess about where the boundary lies.

`.pi/main-only.md`, resolved against the project root with a fixed name, is injected into the
main session only, through pi's `sections` rather than by rewriting the whole system prompt,
because pi diffs sections and appends a single system message, so the earlier prompt cache
still hits.

The three entry points separate audiences by **how they are loaded**, never by guessing at
run time:

| Entry point | Loaded by | Behaviour |
| --- | --- | --- |
| `src/index.ts` | The agent's `subagentOnlyExtensions`, plus ambient loading | Scope and bash (the first half of this document) |
| `src/main-context.ts` | Ambient loading only (a symlink in `.pi/extensions/` or a global install) | Injects `.pi/main-only.md` into the main session; in a background subagent it strips the markers instead |
| `src/child-context.ts` | Declared by an agent's `subagentOnlyExtensions` only | Strips the markers and never injects |

Two entry points are needed because a foreground subagent and the main session **cannot be
distinguished from inside the process**: a foreground subagent runs in the same process and
has no `PI_SUBAGENT_CHILD`, so its environment is identical to the main session's, whereas a
background subagent is a separate process carrying that variable. Logic meant for the main
agent alone therefore has to be selected by the loading path. The `PI_SUBAGENT_CHILD === "1"`
check in `main-context.ts` exists to stop background subagents, which load it ambiently as
well.

This does not conflict with pi-subagents' own `inheritProjectContext: false`, which is
all-or-nothing and does not even read the file, suiting a repository whose rules are
irrelevant to subagents. The marker approach keeps a single file under single maintenance,
which suits a repository whose rules contain parts a subagent must follow.

A subagent started with `context: "fork"` receives the parent's entire prompt, project
context included; isolation therefore requires avoiding fork context.

## Configuration sources

There are two: pi-subagents' `extensionBindings`, passed on each dispatch, and an agent
profile, a per-role default declared once alongside the agent definition. Without either, the
extension does nothing and neither the parent session nor an unscoped subagent is affected. A
session that is already scoped does not register the usage skills below either.

Wildcards: `**` matches any number of directory levels, `*` any characters within one level
and `?` a single character. A pure path glob additionally matches the directory itself and
everything beneath it, so `src` and `src/**` both cover the whole `src` directory.

## Agent profiles

`extensionBindings` has a practical gap: it can only be written by the parent agent **on each
dispatch**, and an agent definition has no place to declare a default. The pi-subagents
frontmatter field table has no bindings field and neither do the settings files. Omitting them
does not remove three prohibitions but returns at the top of `tool_call`, so **every
restriction disappears**.

A profile attaches defaults to whichever entry point an agent declares, because the audience
can only be distinguished by the loading path; see the previous section on why the process
cannot tell a foreground subagent from the main session.

**1. Write the per-role defaults in the project**, in `.pi/subagent-bindings.json` relative to
the project root:

```json
{
  "default": { "maxDenies": 5 },
  "writer": {
    "bash": {
      "read": ["git status", "git diff", "git log", "mise run typecheck"],
      "write": ["mise run test", "mise run check:routing"],
      "writable": true,
      "deny": ["git stash", "git checkout", "git reset", "git clean"]
    }
  },
  "review": { "readOnly": true, "bash": { "read": ["git diff", "rg"], "deny": ["git stash"] } }
}
```

**2. Add a two-line loader per role**, naming the role:

```ts
// .pi/agent-profiles/writer.ts
// The path must be absolute: Node does not expand `~` in an import specifier.
import { profile } from "/path/to/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
export default profile("writer");
```

**3. Declare it in the agent definition** alongside the main entry point:

```markdown
subagentOnlyExtensions: …/src/index.ts, .pi/agent-profiles/writer.ts
```

Merging rules:

- The `extensionBindings` of the current call override the profile per key, and `bash`
  overrides **as a whole object**; arrays are never merged, which avoids widening the grant
  silently.
- `bash.deny` is a union that **the caller cannot relax**. A project's structural commands,
  such as `git stash` or `git reset`, cannot be allowed even when they are listed in
  `bash.read` or `bash.write`. This is what distinguishes a structural prohibition from an
  ordinary allowlist.
- A profile may legitimately omit `scope`, since a role does not know the paths of a
  particular task. File access is then refused entirely while the bash allowlist still
  applies, so a forgotten binding is a **loud** failure: the subagent is stopped on its first
  read and reports what is missing.
- A declared profile that cannot be read, whether because the file is missing, the JSON is
  malformed or neither `default` nor the role name is present, results in **deny-all** rather
  than no restriction.

The main session never loads these loaders, so project defaults cannot lock it down by
accident.

## Using it with pi-subagents

Prerequisite: declare the extension for the agents that need scoping. Foreground subagents do
not load ambient extensions, so declaring it in the agent definition's frontmatter is
preferred, as that covers both foreground and background subagents:

```markdown
---
name: worker
description: Implements a task within the given scope
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts
---
```

`subagentOnlyExtensions` loads this extension only in that agent's subagent session, never in
the parent session.

The parent passes the scope of the current task through `extensionBindings` on each dispatch:

```text
subagent(
  agent: "worker",
  task: "Fix the null pointer in login.ts",
  extensionBindings: { "pi-subagent-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
)
```

The bindings fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `string[]` | Globs describing the task scope. Required; an empty array refuses all file access. |
| `readOnly` | `boolean` | Defaults to `false`. When true, `edit` and `write` are refused even inside the scope. |
| `maxReads` | `number` | Optional cap on successful reads. |
| `allowTools` | `string[]` | Optional additional non-executor tool names to allow. |

The namespace is `pi-subagent-extend/1`. pi-subagents encodes the bindings into
`PI_SUBAGENT_EXTENSION_BINDINGS` and passes that to the subagent, and the extension reads it
once when it activates; the variable exists only until a foreground subagent's session starts
and is then restored, so it cannot be read lazily. Malformed bindings or an invalid `scope`
fail closed: the session keeps running, all file access is refused, and the refusal states the
reason.

What the parent model needs to know ships as three skills published with the extension:

| Skill | Contents |
| --- | --- |
| `skills/pi-subagent-extend` | File scope, the two bash columns and `re:` patterns, the sandbox, worktree dependency setup through `worktreeSetupHook`, agent profiles, and a call template |
| `skills/pi-subagent-extend-probes` | The five probe criteria, the denial count, warn and stop semantics, and how to read a report after a stop |
| `skills/pi-subagent-extend-context` | The `<!-- main-agent-only:start -->` markers, `.pi/main-only.md`, and the division of labour between the three entry points |

Each skill opens with a table of the situations it covers, and its frontmatter description names
them too: Pi advertises only the name and description, and loads the rest when the task calls for
it, so the summary has to carry the routing decision on its own.

The extension registers all three directories with the session through `resources_discover`:
when the extension is loaded, its skills enter the list available to the system prompt, and
the model reads the relevant one when it delegates a scoped subagent. Nothing has to be
written into `AGENTS.md` or the system prompt. `/skill:pi-subagent-extend`,
`/skill:pi-subagent-extend-probes` and `/skill:pi-subagent-extend-context` load them manually.

One prerequisite: the parent session must load the extension too, or the skills never reach
the parent agent. `./install.sh` creates the global symlink for that purpose; the parent
session has no bindings, so the extension is a no-op there and has no side effects. The
subagent side is covered by `subagentOnlyExtensions`, which works for foreground subagents, or
by ambient discovery, which reaches background subagents only.

## Using it without pi-subagents

Bindings are the only configuration channel. Without a parent agent, export the same
environment variable by hand; its content is the bindings JSON:

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-subagent-extend/1":{"scope":["src/**"],"readOnly":true}}' \
pi -e ~/extensions/pi-subagent-extend/packages/pi-plugin/src/index.ts --tools read --no-session -p "<task>"
```

## Installation

```bash
cd packages/pi-plugin
./install.sh
```

This symlinks `~/.pi/agent/extensions/pi-subagent-extend`, which pi discovers automatically.
Whether a scope applies is decided entirely by configuration: with no bindings, environment
variable or scope file the extension is a no-op, so the global link is harmless in a parent
session. `./install.sh --uninstall` removes it.

To skip the global link and load it only inside one agent's subagents, use the frontmatter's
`subagentOnlyExtensions`, pointing at this package's `src/index.ts` and adding
`src/child-context.ts` when context markers must be stripped as well; no installation step is
needed. For project-level use, symlink the package directory into `<project>/.pi/extensions/`,
which loads `index.ts` and `main-context.ts`, that is the `pi.extensions` entry in
`package.json`, and provides context isolation for the main session.

## Development

```bash
cd packages/pi-plugin && pnpm install && pnpm run typecheck && pnpm test
```

`pnpm test` runs three layers, all offline: no model, no network beyond localhost.

1. **Scope suite** (36 cases) and **context suite** (10 cases) check the extension's own
   judgement against a fake pi API. Kernel requirements are met by the helper's own tests
   (`cargo test` in `packages/helper`), and where the kernel's Landlock ABI is below the
   required 7 the scope suite runs against a stub helper that reports ABI 7, saying so in its
   output.
2. **Mock session suite** (4 cases) runs a real pi process driven by `test/mock-llm.mjs`, a
   dependency-free OpenAI-compatible server. The "model" is a script of tool calls, so the
   boundaries are exact rather than left to chance: whether a run continued is simply whether
   the next script step was requested. It covers the hard stop, the rescue-channel exemption
   inside a mixed batch, an in-scope control, and the regression where a call after a stop must
   report the stop reason instead of a fresh verdict on its own path.

Continuous integration runs the type check, the helper tests and all three offline suites on
every push to `main` and every pull request.

Real-model runs are for final debugging only, never part of `pnpm test`, and are driven by
hand:

```bash
pnpm run test:llm                     # uses pi's default model
PI_E2E_MODEL=<provider>/<model> pnpm run test:llm
PI_E2E_KEEP=1 pnpm run test:llm       # keep the temporary project to inspect the transcripts
```

A boundary a real-model run reveals comes back as a scripted case in
`test/mock-session.test.mjs`, so the suite stays deterministic. The mock exposes its request
log, which is what makes "the run ended" assertable: `mock.requests.length` counts the turns
pi actually asked for.

It creates a disposable project holding an `AGENTS.md` with markers, a `.pi/main-only.md`, a
`.pi/extensions/` symlink and two agent definitions, then runs four sessions: the main session,
a foreground subagent (`async:false`), a background subagent (`async:true`) and a control
without the extension. The verdict rests on the codes existing only inside the isolated
content: the main session and the control must produce them, while both subagents must answer
`NONE`.

`pi -p` is unsuitable because it exits as soon as the parent agent becomes idle, which loses
the process while a background subagent is still running. Both session-level suites therefore
drive RPC mode through the officially exported `RpcClient`, a long-lived child process whose
lifetime the test controls, so the parent turn cannot end early. The background subagent
writes its answer to a file itself, so collecting that evidence does not depend on the parent
turn being woken.

Offline tests never call a model and only verify scope decisions and context isolation:
`node test/extension.test.mjs` and `node test/context.test.mjs`, both run by `pnpm test`. The
real-session verification is `node test/e2e.test.mjs`.

## Boundaries and caveats

- The scope is a file-level boundary, not a content-level one: including `docs/**` permits
  reading the whole directory.
- Refusing `bash` outright is a design decision rather than a gap. The paths inside a shell
  command cannot be parsed reliably, and a shell can carry environment variables away.
- The extension intercepts at the `tool_call` stage and is not a sandbox replacement. A
  subagent inherits the parent process's environment and credentials, so this guards against
  misuse rather than malice; genuinely untrusted input needs container-level isolation.
- Failing closed on unknown tools means tools registered by other extensions are refused as
  well. List the tools that are genuinely needed in `allowTools`.
- Nested subagents do not inherit bindings. An unscoped subagent does not carry this
  extension's bindings, so the extension has no effect in its session. To constrain nesting,
  either do not enable `allowNestedSubagents` for a scoped session or pass bindings explicitly
  on the nested call.
