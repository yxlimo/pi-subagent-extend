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

This script serves pi-subagents' `worktreeSetupHook`: once a worktree exists and before the
subagent starts, it runs a command the project declares. It exists because pi-subagents
links the main checkout's `node_modules` into a new worktree through
`linkNodeModulesIfPresent`, and pnpm installs through that link, which leaves the virtual
store at the wrong depth.

Only a symlink is installed globally; the script itself is versioned here, since it may
become an extension:

```text
~/.pi/agent/extensions/subagent/worktree-setup.mjs -> packages/worktree-setup/worktree-setup.mjs
```

```json
// ~/.pi/agent/extensions/subagent/config.json
{
  "worktreeSetupHook": "~/.pi/agent/extensions/subagent/worktree-setup.mjs",
  "worktreeSetupHookTimeoutMs": 300000,
  "worktreeBaseDir": "~/.pi/worktrees"
}
```

**The gate is the project's own file.** The hook runs only when `<repoRoot>/.pi/worktree-setup.json`
exists; otherwise it exits immediately without doing anything. One global script therefore
serves every project, and no forwarding layer is needed.

```json
// single-package repository (package.json at the root): cwd is unnecessary
{ "command": ["pnpm", "install", "--prefer-offline"] }

// multiple packages without a root manifest (this repository): cwd names the directory to install in
{ "command": ["pnpm", "install", "--prefer-offline"], "cwd": "packages/pi-plugin" }
```

`cwd` is not a redundant switch: pnpm fails with `ERR_PNPM_NO_PKG_MANIFEST` when the
directory has no `package.json`.

The verdict is whether **the tree is usable**, not the command's exit code: `node_modules`
must be a real directory and the declared dependencies must resolve. pnpm 12 installs every
package and can still exit with one because of `ERR_PNPM_IGNORED_BUILDS`, and judging by the
exit code would refuse every launch; this was reproduced.

Two environment facts:

- The shebang names a concrete node binary rather than `#!/usr/bin/env node`. The `node` on
  PATH is a mise shim, and when a new worktree's `mise.toml` is not trusted the shim exits
  at once, so the script never executes a single line and leaves no log. This line must be
  adjusted on another machine.
- mise trust is the project's responsibility (`trusted_config_paths`). The script only
  surfaces the `not trusted` output verbatim; it does not compensate for it.

Runs are logged to `~/.cache/pi-worktree-setup/<runId>.log`.

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
`"probe": {}` enables every default, a partial object enables only the fields it names, and
`"probe": false` disables all of them.

| Criterion | Default | Behaviour |
| --- | --- | --- |
| Read-only idling | Explicit: `idleWriteMs: 360000`, `abortGraceMs: 120000` | No write activity within `idleWriteMs` produces a warning at the next tool boundary; after a further `abortGraceMs` the turn stops. |
| Repeating a command | On by default, `repeatBash: 3` | The third identical bash command warns and the fourth stops. |
| Finished early | Explicit: `successIdleMs: 300000`, `successPatterns` | Once bash output matches a success marker, no new change within `successIdleMs` stops the turn. |
| Writing litter | Explicit: `forbidWritePatterns: []` | A `write` or `edit` target matching the pattern is refused outright. |

Write activity means `edit` and `write` calls and commands matching `bash.write`. Commands
matching `bash.read`, together with `read`, `grep` and `ls`, do not count; otherwise a
subagent could circle using read-only bash and escape the criterion. A task with
`readOnly: true` skips the first two criteria, which are meaningless for it.

`maxDenies` defaults to three and an explicit `0` disables it. After that many consecutive
refusals by the scope rules, the subagent is warned that the parent most likely authorised
the wrong paths and should be told what is missing; one more refusal stops the turn.

Stopping does not call `ctx.abort()`. A hard abort also kills the summary the model is
writing, so the parent receives nothing but a tool error. The extension instead latches a
stopped state and refuses every later call, so the model, having lost its tools, finishes its
conclusions and the parent receives a complete report. Both variants were measured: with
`terminate` the report was truncated to a single line, and without it the report was
complete.

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

- **Files**: a Landlock ruleset. `/` stays readable and executable, and only the directories
  named in the spec are writable: the scope, the working directory, `node_modules` and the
  `bash.writablePaths` entries. A write outside them fails with `EPERM`.
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
- **Devices**: the baseline device nodes `/dev/null`, `/dev/zero` and `/dev/tty` are
  writable by default; without them a redirect such as `2>/dev/null` fails outright.

The kernel requirement is **Landlock ABI 7 (Linux 6.15 or later)**, the lowest level that
also blocks the `open(O_TRUNC)` bypass. Below that the extension does not support the sandbox
at all rather than offering a weaker one. When the helper is missing, the ABI is too low or
the host forbids user namespaces, bash stays disabled and the refusal names what is absent.
`PI_SUBAGENT_EXTEND_HELPER` overrides the binary path.

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
- A command containing metacharacters such as `; & | < > \` $ \` is refused outright, so an
  allowlist prefix cannot be extended into another command.
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

## Known boundaries between worktrees and pnpm

pi-subagents links the main checkout's `node_modules` **as a symlink** into a managed
worktree (`src/runs/shared/worktree.js`, `linkNodeModulesIfPresent`). Consequently:

- The symlink must be **removed before installing**. pnpm installs through the link into the
  main checkout and never replaces the link, so the depth stays wrong and `tsc` cannot find
  its packages. Once the link is gone, installing works: measured in a repository that sets
  `virtualStoreType: global`, a cold install takes **124 ms** and the symlink case **118 ms**,
  because a worktree only needs links into the global store.
- In a project that sets `virtualStoreType: global`, a worktree's `node_modules` holds only
  symlinks and `node_modules/.pnpm` keeps little more than `lock.yaml`. A project without
  that setting installs as well, but hardlinks the packages into its own `.pnpm` and is
  slower.
- Verifying with dependencies already present works if `pnpm run` skips its pre-install
  check, which pnpm 12 reads only from `pnpm-workspace.yaml`: set `verifyDepsBeforeRun:
  false` there.
- pnpm 12 keeps its lock directory under `XDG_RUNTIME_DIR` (`/run/user/<uid>`) rather than in
  the store, so under a read-only root even `pnpm run` fails to start. The extension points
  `XDG_RUNTIME_DIR` at the sandbox's private `/tmp`, which resolves it.
- mise records a new worktree's `mise.toml` in `~/.local/state/mise/trusted-configs`, and
  under a read-only root that fails while the configuration is still being parsed. In a
  worktree the extension points `MISE_STATE_DIR` at the sandbox's private `/tmp`, which
  avoids the registration.
- **The host side is blocked by mise as well**, outside any sandbox. When a new worktree's
  `mise.toml` is not trusted, the shimmed tools such as `node` and `pnpm` all print
  `Config files in ... are not trusted` and exit. Anything that runs a command in a worktree
  therefore fails, including the pi-subagents `worktreeSetupHook`, whose own shebang
  (`#!/usr/bin/env node`) does not survive it: the process dies before executing a line and
  all that remains is an unverified process tree. The declarative remedy is
  `trusted_config_paths = ["<worktree root>"]` in `~/.config/mise/config.toml`; the official
  documentation states that it covers the configuration files at or below each path,
  including projects created there later.
- **Inside the sandbox pnpm uses a project-local store by default.** The global store under
  `~/.local/share/pnpm/store` is not writable under a read-only root, so pnpm detects that
  and falls back to `<project>/node_modules/.pnpm-store`. Adding the store directory to
  `bash.writablePaths` makes `pnpm store path` report the global store again; measured, the
  allowed case returns `~/.local/share/pnpm/store/v11`. Tests pass in either mode, since the
  project-local store lands in `node_modules`, which is already writable.
- The side effect is a `.pnpm-store` of tens of megabytes in the project. The extension
  guarantees through `core.excludesFile` that it cannot enter the git index, and a project
  should still ignore `node_modules/` in its own `.gitignore`.
- **Installing dependencies requires network access.** Inside the sandbox pnpm uses the empty
  project-local store and can only download from the registry, while `bash.network` is off by
  default, so `pnpm install` cannot succeed in the sandbox unless networking is granted.

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
  "default": { "maxDenies": 3 },
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
| `skills/pi-subagent-extend` | File scope, the two bash columns and `re:` patterns, the sandbox, and a call template |
| `skills/pi-subagent-extend-probes` | The four probe criteria, the denial count, warn and stop semantics, and how to read a report after a stop |
| `skills/pi-subagent-extend-context` | The `<!-- main-agent-only:start -->` markers, `.pi/main-only.md`, and the division of labour between the three entry points |

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

`pnpm test` runs offline against a fake pi and needs no network: 32 scope cases and 10 context
cases. End-to-end verification is a separate script that runs real sessions with a real model:

```bash
pnpm run test:e2e                     # uses pi's default model
PI_E2E_MODEL=<provider>/<model> pnpm run test:e2e
PI_E2E_KEEP=1 pnpm run test:e2e       # keep the temporary project to inspect the transcripts
```

It creates a disposable project holding an `AGENTS.md` with markers, a `.pi/main-only.md`, a
`.pi/extensions/` symlink and two agent definitions, then runs four sessions: the main session,
a foreground subagent (`async:false`), a background subagent (`async:true`) and a control
without the extension. The verdict rests on the codes existing only inside the isolated
content: the main session and the control must produce them, while both subagents must answer
`NONE`.

`pi -p` is unsuitable because it exits as soon as the parent agent becomes idle, which loses
the process while a background subagent is still running. The script therefore drives RPC mode
through the officially exported `RpcClient`, a long-lived child process whose lifetime the
test controls, so the parent turn cannot end early. The background subagent writes its answer
to a file itself, so collecting that evidence does not depend on the parent turn being woken.

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
