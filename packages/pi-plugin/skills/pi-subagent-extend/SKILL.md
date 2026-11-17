---
name: pi-subagent-extend
description: When delegating a pi-subagents subagent, use extensionBindings to confine its file reads and writes and the commands it may run to this task's scope — every out-of-scope tool_call is refused, and commands on the bash allowlist run in a Landlock sandbox (no network by default, writes confined to the allowed directories). Use it to keep a subagent from sweeping the whole repository, to allow typecheck/test, to install dependencies or run verification in a worktree, and to set per-role default scopes (profiles). Probe criteria and stopping are covered by pi-subagent-extend-probes, and stripping the main-agent-only sections of AGENTS.md by pi-subagent-extend-context.
---

# pi-subagent-extend: confine a subagent to the task scope

When delegating a subagent, pass the scope of this task through `extensionBindings`. In the subagent's session, every tool_call outside that scope is refused (fail closed): this keeps the subagent from wandering through the repository aimlessly.

## When to use it

| Situation | Which field | See |
| --- | --- | --- |
| The subagent should only read/write the few files of this task | `scope`, plus `readOnly` for a read-only task | [The scope field](#the-scope-field) |
| The subagent should read the whole task scope but write into one directory (a review allowed to write only its report) | `writeScope` | [The scope field](#the-scope-field) |
| The subagent has to run typecheck, tests or a build itself | `bash.read` / `bash.write`, plus `writable` when the artefacts land on disk | [The bash field](#the-bash-field) |
| The subagent runs in `worktree: true` and has to install dependencies | The project commits `.pi/worktree-setup.sh`, together with `writablePaths` / `network` | [bash in a worktree](#bash-in-a-worktree) |
| You do not want to hand-write the scope on every dispatch (it gets forgotten when you are busy) | agent profile | "Profiles (per-role defaults)" below |
| The subagent starts idling or going in circles | The other half of this package: probes | skill `pi-subagent-extend-probes` |
| AGENTS.md mixes in rules only the main agent should see | The other half of this package: context isolation | skill `pi-subagent-extend-context` |

The criteria and the stop (read-only idling, going in circles, finishing early, writing litter, colliding with permissions) are in the other skill, `pi-subagent-extend-probes`.

Context isolation (the sections fenced by `<!-- main-agent-only:start -->` in `AGENTS.md`, and `.pi/main-only.md`) is the other half of the same package: see skill `pi-subagent-extend-context`. It is decided by the entry point declared in the agent definition and has nothing to do with bindings — no field needs to be passed for it when delegating.

The delegation rules themselves (how to write the brief, how to wait, one cwd, one writer) follow the **skill shipped with pi-subagents**; this skill only adds the layer of "how to bind the scope and the command grants to a single delegation".

## Prerequisites

The delegated agent must be able to load this extension. Choose one:

- declare `subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts` in the agent definition's frontmatter (works for foreground and background subagents; recommended);
- the extension is installed globally (`~/.pi/agent/extensions/pi-subagent-extend`) and this delegation sets `async: true` (only background subagents use ambient discovery).

Without the extension loaded, passing bindings does nothing: no interception happens.

If the project uses the `<!-- main-agent-only:start -->` marker, add `, …/src/child-context.ts` to the same line, otherwise the subagent reads the main-agent-only sections (see skill `pi-subagent-extend-context`).

The commands in `bash.read` / `bash.write` run under the sandbox helper (the Rust binary in `packages/helper`): the file scope is enforced by Landlock, the network is off by default (all outbound TCP/UDP is cut and DNS resolution fails, but loopback works inside the sandbox, so a local server can be started and reached), and processes and capabilities are isolated as well (the host processes are invisible, the command has no capability at all). The host needs Landlock ABI 7 (Linux 6.15+); when the helper is missing or the kernel is too old, bash stays disabled (the remaining features are unaffected).

## Call template

Reading or writing files, no commands needed:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>",
  extensionBindings: { "pi-subagent-extend/1": { "scope": ["<file/directory glob>", "..."] } }
)
```

The subagent has to run tests or typecheck itself:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>; run typecheck afterwards and report the result",
  extensionBindings: {
    "pi-subagent-extend/1": {
      "scope": ["<file/directory glob>"],
      "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] }
    }
  }
)
```

The namespace is fixed at `pi-subagent-extend/1`. Pass it on every delegation, and narrow the scope to the files and directories this task actually touches; do not default to the whole repository.

The subagent runs in a worktree (`worktree: true`) and has to install dependencies or run verification:

```text
subagent(
  agent: "<agent-name>",
  task: "<task description>",
  options: { worktree: true },
  extensionBindings: {
    "pi-subagent-extend/1": {
      "scope": ["src/auth/**"],
      "bash": {
        "read": ["pnpm run typecheck"],
        "write": ["pnpm test"],
        "writable": true,
        "writablePaths": ["~/.local/share/pnpm/store"]
      }
    }
  }
)
```

## The `scope` field

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `string[]` | Required. Globs describing what the subagent may read; an empty array refuses all file access |
| `writeScope` | `string[]` | Optional. Globs describing what `edit`/`write` may touch. Omitted means the same as `scope`; `[]` means no writes at all while reads keep working |
| `readOnly` | `boolean` | Defaults to `false`; when `true`, `edit`/`write` are refused even inside the scope — the same as `writeScope: []` — which suits read-only research and review agents |
| `maxReads` | `number` | Optional. Upper bound on successful `read` calls; once it is exceeded, every read is refused |
| `maxWriteDenies` | `number` | Optional. Write refusals have their own budget: defaults to 2, `0` disables. Kept apart from `maxDenies` because repeatedly trying to write is a usage mistake, answered by delivering a report |
| `allowTools` | `string[]` | Optional. Extra tool names to allow; executor-type tools such as `bash` cannot be allowed this way |

Glob rules: `**` matches any number of levels (including zero), `*` matches characters within a single level, `?` matches a single character.

For a directory, `dir`, `dir/` and `dir/**` are equivalent: all three cover the directory itself and its contents at any depth; `dir/*` covers only the direct children. So write the scope as directories, not as a list of files — listing files is easy to get wrong, and files added to the directory later are refused too. A path directly under `dir/**`, such as `dir/a.ts`, is inside it.

Reads and writes are authorised by three separate lists, and this is deliberate:

| Layer | Field | Governs |
| --- | --- | --- |
| read | `scope` | `read`, `grep`, `find`, `ls` |
| write, tools | `writeScope` | `edit`, `write` |
| write, processes | `bash.writablePaths` (with `bash.writable`) | the Landlock rules of bash subprocesses |

So "read the whole repository, write only `.pi/reviews`" is `scope: ["."]`, `writeScope: [".pi/reviews"]`.

`"."` and `"./x"` are normalised, so they mean the whole tree and `x`; they are not matched literally.

Targets are judged by their **real** path, not the text of the call. A symlink inside the scope that points outside it is refused, and so is any target whose real path leaves the working tree — including under `scope: ["."]`. A scope is written relative to the project, and the project is that tree, so `src/link` pointing elsewhere is not "inside `src/`" just because the string says so. This matters for `edit`/`write`, which run in the parent process where no sandbox backs them up.

Keep `.git` out of `writeScope` — the sandbox is given the parts of it git has to write on its own, and putting `.git` in the write scope lets a subagent hand-edit repository metadata (`hooks`, `config`) that the parent later executes.

## The `bash` field

| Field | Type | Meaning |
| --- | --- | --- |
| `bash` | `object` | Optional. Without it bash is forbidden entirely; both columns empty also means forbidden |
| `bash.read` | `string[]` | Read-only commands (typecheck, grep and the like). A literal is matched token by token as a prefix after splitting on whitespace; an entry starting with `re:` is matched as a regex against the whole string |
| `bash.write` | `string[]` | Commands that write files (tests, builds and the like). The matching rules are the same; they count as "write activity" |
| `bash.network` | `boolean` | Defaults to `false`, the sandbox has no network; turn it on only for commands that genuinely need the network |
| `bash.writable` | `boolean` | Defaults to `false`, the sandbox root is read-only; when `true`, the paths the **write scope** covers, git's own directories and `node_modules` are writable inside the sandbox (test artefacts, snapshots). Only a scope entry that covers a whole subtree (`dir`, `dir/**`) opens that directory; a file-level entry (`src/auth/*.ts`) opens just the files it matches today, so a brand-new file under it is not writable through bash — write those with the `write` tool. In a linked worktree, git's own grant is the worktree's gitdir plus the common directory's `objects`, `refs` and `logs`; `hooks/` and `config` are deliberately outside it, because planting a hook there would later run it as the parent agent. In a plain checkout the index and `HEAD` lock files sit in `.git` itself, so there `.git` is granted whole and `hooks`/`config` stay writable — a Landlock limit, not a choice. The working directory is not granted wholesale, so a subagent allowed to read `lib/` but not write it cannot route around that with a shell redirect; anything else it needs goes in `writablePaths` |
| `bash.writablePaths` | `string[]` | Additional paths granted write access (absolute paths, starting with `~`, or relative to the cwd). Put the global directories the toolchain has to write here, such as the pnpm store |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are otherwise derived from the manifests the project has. `false` disables detection, an array appends explicit directories (created if missing) |
| `bash.env` | `object` | Environment variables injected into the sandbox (written into the spec's `env`). `XDG_RUNTIME_DIR` (the sandbox's private /tmp, which pnpm's lock directory relies on) and, in the worktree case, `MISE_STATE_DIR` are injected by default. A `TMPDIR` set here is the directory the helper shadows with its private tmpfs |
| `bash.gitExcludes` | `boolean` | Defaults to `true`. Injects global exclude rules into git inside the sandbox (`node_modules/`, `.pnpm-store/`), so that `git add -A` does not pull the dependency directories into the index |
| `bash.deny` | `string[]` | Blacklist: a matched command is **always refused, and the caller's allowlist cannot widen it**. Usually written in an agent profile to enforce the project skeleton (`git stash`, `git reset`) |
| `bash.dependencyGate` | `boolean` | Defaults to `true`. Every directory in the tree (two levels down) that has a package-manager lockfile (pnpm, npm, yarn, bun) must also have `node_modules/.bin`. When one does not, build and package-manager commands are refused with the directory named; read-only commands and `git` run anyway, because `git` needs no dependencies and committing is what keeps a worktree from being discarded. It reports a missing install, not an install that has drifted from the lockfile. Not a permission the parent can widen: the install has to finish (`worktreeSetupHook`) or the store has to be writable. `false` turns it off for a task that never builds |

For a bash command outside the allowlist, the refusal text carries the detected pnpm store path — the model can see it and report it together with "what the parent agent wants to write". The extension only detects it; it does not allow it automatically.

**Build and test artefacts are writable where the project says they belong.** `bash.writable` grants the write scope plus the artefact directories of the toolchains the project actually uses. The extension decides that from manifest files in the repository root and up to two levels down (so `packages/web/package.json` counts): `package.json` means Node, `Cargo.toml` Rust, `go.mod` Go, `pyproject.toml` Python, `pom.xml` or `build.gradle` Java, `mix.exs` Elixir, `Gemfile` Ruby, `Package.swift` Swift, `build.zig` Zig, `*.csproj` .NET, and so on. Each toolchain carries its own conventional output directories, resolved next to its manifest.

A directory that already exists is granted. A toolchain's main output (`target` for Rust, `__pycache__` for Python, `_build` for Elixir) is also created when missing, because the first `cargo test` in a fresh checkout would otherwise fail. The rest — `dist`, `.next`, `coverage` — are granted only if the project already has them; the extension does not invent directories. Build caches that live outside the repository (`go`'s, `mypy`'s) go to a persistent `~/.cache` directory through `XDG_CACHE_HOME`; the sandbox's private `/tmp` would make every run recompile.

`bash.scratchPaths` adjusts the list: `false` turns detection off entirely, an array appends explicit directories (created if missing). Put it in the project profile when a role always runs the same build, so no dispatch has to repeat it.

Everything else is still refused. A plain `echo x > tmp.txt` in the working directory, or a tool writing into a directory the project does not have, fails with `Permission denied` — deliberately, because otherwise `lib/a > lib/b` would walk straight around a directory the subagent may read but not write. Fix it by naming the location:

- the directory goes in `writeScope` if the subagent may also write it by hand (a review writing its report);
- it goes in `bash.writablePaths` if only the toolchain needs it;
- or point the tool at a temporary directory: the sandbox already makes it writable **and** mounts an empty tmpfs over it, so what lands there is scratch, not state. That is `/tmp` and also the command's own temp directory — the host's `TMPDIR`, or the one pinned through `bash.env`: `"env": { "COVERAGE_DIR": "/tmp/coverage" }`.

Entries come in two forms:

- Literal: split on whitespace and match token by token as a prefix. `"pnpm test"` allows `pnpm test -t foo`, but not `pnpm publish`.
- `re:` prefix: a regex, anchored against the whole string. `"re: ^pnpm -r (test|build)$"`. Regexes are not guessed automatically — command arguments often contain `*` and `.`, and guessing wrong in that direction grants more than was intended.

## Profiles (per-role defaults, no need to pass them each time)

`extensionBindings` can only be hand-written on each dispatch; an agent definition has nowhere to declare defaults, and forgetting to pass them means **no restriction at all**. A profile keeps the defaults with the agent definition:

```ts
// .pi/agent-profiles/writer.ts (two lines)
// the path must be absolute: Node does not expand `~` in an import
import { profile } from "/path/to/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
export default profile("writer");
```

```markdown
---
name: be-core
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts, <project root>/.pi/agent-profiles/writer.ts
---
```

```json
// .pi/subagent-bindings.json (project root)
{
  "default": { "maxDenies": 5 },
  "writer": { "bash": { "read": ["mise run typecheck"], "write": ["mise run test"], "writable": true } },
  "review": { "readOnly": true, "bash": { "read": ["git diff", "rg"], "deny": ["git stash"] } }
}
```

Rules:

- The bindings of this call override the profile per key; `bash` overrides as a whole object (arrays are not merged).
- `bash.deny` is a union and **cannot be relaxed by the caller** — "structurally forbidden" relies on it, not on the defaults.
- A profile may omit `scope`: file access is then refused entirely while the command allowlist still applies (a forgotten binding is a loud failure).
- When the profile cannot be read, everything is refused; it does not fall back to no restriction.
- The main session does not load these loaders, so the main agent is not locked down by accident.

## bash in a worktree

Two things need extra handling when the subagent runs in a pi-subagents managed worktree (`worktree: true`):

- **Installing dependencies is not the extension's job**: the worktree's `node_modules` is a symlink to the main checkout, so `pnpm install` follows the link and installs into the main checkout, and the link itself is not replaced, which leaves the hierarchy wrong. Leave this to pi-subagents' `worktreeSetupHook` (this repository's `packages/worktree-setup`), which handles it before the subagent starts; see the next section. The extension only manages write access inside the sandbox.
- **Both pnpm and mise write outside the sandbox**: pnpm's lock directory lives in `XDG_RUNTIME_DIR` (`/run/user/<uid>`), and mise has to register the worktree's `mise.toml` in `~/.local/state/mise/trusted-configs`. The extension points both at the sandbox's private /tmp by default, so those two failures no longer need handling; places that genuinely have to be writable and persistent, such as the pnpm store, are given explicitly with `bash.writablePaths`. A host whose `TMPDIR` is somewhere other than `/tmp` gets a private tmpfs over that directory as well, so temp files stay inside the sandbox either way.
- **Which store pnpm uses inside the sandbox depends on write access**: when the global store (`~/.local/share/pnpm/store`) is not writable under the read-only root, pnpm detects that and falls back to `<project>/node_modules/.pnpm-store`; list the store directory in `bash.writablePaths` and `pnpm store path` still points at the global store (measured). Both of them run tests — the in-project store lands under `node_modules/`, which is writable anyway. The extension's git global exclude rules keep it out of the index, but the project's own `.gitignore` should ignore `node_modules/` as well.
- **Installing dependencies inside the sandbox needs the network** (`"network": true`): whichever store is used, installing a new package has to reach the registry. With the network off by default, `pnpm install` is bound to fail.

## Worktree dependency installation (worktree hook)

pi-subagents runs the `worktreeSetupHook` once after each worktree is created and before the subagent starts, with the cwd set to the new worktree root. The hook provided by this repository is `packages/worktree-setup/worktree-setup.sh`; only one symlink is installed globally:

```text
~/.pi/agent/extensions/subagent/worktree-setup.sh -> <this repository>/packages/worktree-setup/worktree-setup.sh
```

A project only has to commit a shell script at `<repo>/.pi/worktree-setup.sh`; without that file nothing happens (which is why one global hook serves every project):

```sh
#!/bin/sh
set -eu
cd packages/pi-plugin      # cd yourself when the manifest is not in the root directory
pnpm install --prefer-offline
```

- **The exit code is the contract**: the hook does not judge a second time whether the install worked; the project decides in its own script. pnpm 12 still exits 1 after installing because of `ERR_PNPM_IGNORED_BUILDS`, so write `|| true` yourself or add a self-check. A self-check means writing "what counts as usable" as the project's own criterion:

```sh
#!/bin/sh
set -u
cd packages/pi-plugin                  # cd yourself when the manifest is not in the root directory
pnpm install --prefer-offline || true  # ignore pnpm 12's ignored-builds exit code

# the criterion belongs to the project: make sure the shim really resolves **in this worktree**, not in the inherited copy
if ! node -e 'require.resolve("typescript")' >/dev/null 2>&1; then
	printf 'worktree setup: dependencies are unusable in %s\n' "$PWD" >&2
	exit 1
fi
```

Skipping silently is the most expensive failure mode here: the declaration exits 0, the hook believes it succeeded, and the subagent only discovers `Cannot find module` once it starts.
- **The hook deletes the `node_modules` symlink first**. When upstream creates a worktree it symlinks the **main checkout's root** `node_modules` into the worktree (`linkNodeModulesIfPresent`), so that a worktree which installs nothing can still run; the symlink points at **whatever the main checkout happens to have installed**, and both sides go wrong:
- **Nothing installed**: a package the worktree's manifest declares but the main checkout's tree does not have (someone added the manifest earlier and never reinstalled) makes the subagent get `Cannot find module` — even though the package is right there in the worktree's own `package.json` (measured: `is-number` resolves to `<main checkout>/node_modules/.pnpm/...`, `left-pad` fails outright). This has nothing to do with whether `package.json` changed during the work.
- **Installed**: pnpm writes through the symlink into the main checkout's copy — the main checkout's directory inode is unchanged, but it gains the package the worktree needed (measured: 4 top-level entries → 5, and the main checkout's own `package.json` never declared it).
- **The bookkeeping is written into someone else's directory**: with `virtualStoreType: global` (the worktree usage pnpm officially recommends), each project records the virtual store as a **relative path** in `node_modules/.modules.yaml`. Opened through the symlink, that file is the main checkout's, while pnpm computes the depth from the worktree, so the install rewrites the main checkout's copy: measured `../../../../.local/share/pnpm/store/v11/links` → `../../../../../../.local/share/pnpm/store/v11/links`, with the manifest untouched throughout. That value only holds for the project that wrote it last; resolved from the worktree it points at a directory that does not exist. So the hook deletes this symlink before running the declaration, leaves a real directory alone, and the declaration gets a clean starting point. A project that wants the symlink back can recreate it in its own script. Projects without a `node_modules` in the root do not get a symlink, so there is no impact.
- Output goes to `~/.cache/pi-worktree-setup/<worktree directory name>.log`; on failure the hook prints the last 20 lines and the log path to stderr, and when the output contains `not trusted` it additionally points at mise's `trusted_config_paths`.
- **The hook does not go through the sandbox**: it runs before the subagent, with host permissions. If the subagent runs `pnpm install` itself, it still needs write access inside the sandbox and `network`.
- The hook is POSIX sh, so the kernel has to honour the shebang; on Windows it has to be a native executable (upstream uses `spawn(hookPath, [], { shell: false })`, and Node will not run `.cmd` for you).

## Rules in effect

- Inside the scope: `read`/`edit`/`write`/`grep`/`find`/`ls` are allowed (with `readOnly`, `edit`/`write` are refused).
- Always refused: `powershell`/`codemode`; unknown tools outside `scope`/`allowTools`.
- `contact_supervisor` / `intercom` / `structured_output` are always allowed, **allowed after the stop as well**: reporting to the supervisor mid-run is a legitimate channel and must not be shut off by a criterion or a probe.
- The stop is hard (`terminate`): when the whole batch of results is terminating, the turn ends right there, with no closing round. So ask for help before the stop; do not expect to be able to report anything after being stopped.
- **bash**: without an allowlist it is refused outright; with one, only commands matching the `read`/`write` columns run, and each is rewritten to run in the helper sandbox — the file scope is enforced by Landlock, the network is off by default, and the writable paths are the ones the write scope covers (whole-subtree entries as directories, file-level entries as the files they match), git's own directories, `node_modules` (when `writable`), plus `writablePaths`. The cwd is not granted wholesale. Shell control characters are judged **outside quotes only**, because the command runs as `bash -lc <command>`: `; & | < > ( )` inside single or double quotes are ordinary characters, while `$` and a backtick still expand inside double quotes and are refused there too. So `python3 -c "print(1)"` and `echo 'a; b'` pass, but `pnpm test && cat other-file` and `echo "$(cat other-file)"` do not. An unterminated quote is refused. Note the consequence: listing an interpreter (`node`, `python3`, `sh`) in the allowlist lets it run arbitrary code — the sandbox and the scope are the boundary, not the command text, and an interpreter belongs in the allowlist only when the task needs it.
- Both notes below require that the command **actually failed** (the tool result's `isError`); a successful command whose printed output merely contains those strings is not annotated.
- **Network failures inside the sandbox are annotated**: when an offline bash hits `ENETUNREACH` / `EAI_AGAIN` / `ENOTFOUND` / `getaddrinfo failed`, a `[sandbox]` note is appended at the end of the result: the network was turned off by the parent agent, the machine is not broken, changing the registry / flag / timeout fails the same way, and if the network is needed, ask `contact_supervisor` (`"network": true`). `ECONNREFUSED` is not annotated — loopback works, that is a normal test result.
- **Out-of-scope writes are annotated as well**: when bash writes outside the granted scope, the kernel returns `EACCES` / `Permission denied` — the same wording as an ordinary file permission problem. The decision is not made by guessing at the wording: the extension takes the path out of the failure line and compares it with this command's `spec.write`; if the path is outside the grant and the host can read it, a `[sandbox]` note is appended at the end of the result, saying that this is an authorisation rather than a filesystem fault, and that writing requires `contact_supervisor`. Failures inside the grant, and failures caused by insufficient host permissions themselves (such as reading `/etc/shadow`), are not annotated. Paths ending in `.lock` are not annotated either: git probes for lock files it does not need (`packed-refs.lock` in a worktree), prints that refusal with exit status 0, and the commit lands anyway — reporting it would send the parent off to widen a correct grant.
- The text of an out-of-scope refusal is in English, and it spells out "which path is out of scope, do not retry, report it if you need it", and lists the current scope. A refusal for a missing path does not count as a permission problem: `grep`/`find` without a path are handled as the cwd (the text says `no path was given`), and `write`/`edit` must be given a path (the text says `needs a path`). Such refusals do not count towards the collision count.
- **Refusal counts are consecutive**: any allowed working call resets both budgets, so a mistake that has been corrected is not carried to the end of the run. `contact_supervisor` and `structured_output` are exempt from that reset — they are a report, not progress, so alternating a probe with an escalation does not keep the run alive at the warning level.
- Inside the scope a session can use `/permission` to see the current scope, the two bash columns, the sandbox's writable paths, the pnpm store, the read count, the collision count and the probe state (the key names are in English: `Source`, `Mode`, `bash read`, `bash write`, `bash deny`, `Sandbox`, `Sandbox writable paths`, `Reads`, `Denials`).

## Notes for the parent agent

- When the subagent reports `no path was given` or `needs a path`: the tool argument was missing, it did not go to the wrong directory. Put the file paths into the task you give the subagent.
- When the subagent reports `is outside this task's scope`, decide whether that path really belongs to this task: if it does, widen `scope` and dispatch again; if it does not, the task description is ambiguous, so fix the task description first. Check the scope syntax itself first (a directory has to be written as `dir` / `dir/` / `dir/**`), and only then suspect that the subagent went to the wrong directory.
- When a batch contains an allowed result (the batch is not all terminating), the turn continues, and every later call gets the text of the "stop reason" (it holds historical paths). When judging, trust only the criterion on the last line; do not treat the paths inside it as this task's paths.
- Do not retry out-of-scope paths over and over to get around a refusal.
- When the subagent has to run tests/typecheck itself, put the read-only commands into `bash.read` and the file-writing ones into `bash.write` (use a `re:` regex when you need to be precise, but never `re: .*`). If the test artefacts have to land on disk, add `"writable": true`; the sandbox has no network by default, so installing dependencies and the like is refused.
- The sandbox blocks out-of-scope writes and networking, but not reads: running tests has to read the whole tree, so an allowlisted command can still `cat` files outside the scope inside the sandbox. Do not treat the bash allowlist as a means of locking reads down as well.
- When the subagent reports `command not in the allowlist`, first decide whether that command is really needed for this task: if it is, add it to the matching column and dispatch again; if it is not, change the task description instead of letting it keep trying. The refusal text carries the pnpm store path and the `bash.writablePaths` hint — copy it in when the subagent has to install dependencies, instead of letting it install them itself.
- Nested subagents do not inherit bindings: when you lock down an agent that may delegate in turn, do not also enable `allowNestedSubagents`.
- The bindings are capped at 16 KiB in total, so keep the scope globs terse; all fields of this extension share the namespace `pi-subagent-extend/1`, and the cap applies to the whole bindings object.
