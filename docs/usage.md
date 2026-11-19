# Usage

Everything a parent agent can say to this extension, and the shapes worth copying.

## Three layers, three questions

A binding answers three separate questions, and they are deliberately not merged:

| Question | Field | What enforces it |
| --- | --- | --- |
| What may the subagent read? | `scope` | the extension, per tool call |
| What may it write by hand? | `writeScope` (or `readOnly`) | the extension, per `edit`/`write` call |
| What may its shell write? | `bash.writable` and friends | the kernel, via Landlock |

They stay apart because the answers differ in practice. A coder in a linked worktree needs the
repository's `objects/` and `refs/` writable for `git commit`, and must never have them in
`writeScope` — `.git` in a hand-write scope is how a subagent plants a hook the parent later runs.

## Bindings reference

The parent passes them per dispatch:

```text
subagent(
  agent: "worker",
  task: "Fix the null pointer in login.ts",
  extensionBindings: { "pi-subagents-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
)
```

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `string[]` | Globs describing what the subagent may read. Required; an empty array refuses all file access. |
| `writeScope` | `string[]` | Globs describing what a write tool may touch (`edit`/`write`, or the host's anchored-editing family: `replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change`). Defaults to `scope`; an empty array makes writing impossible while reads keep working. Relatives are bound to the task tree; an **absolute** entry is an absolute grant and may point outside it (a review writing one report file). A refused write is charged to `maxWriteDenies`, not `maxDenies`, and the refusal points at a report. |
| `readOnly` | `boolean` | Refuse `edit` and `write`. On its own it is the same as `writeScope: []`; an explicit `writeScope` alongside it wins, so "read-only except this one file" is expressible. Charged to `maxWriteDenies`, answered with a report rather than an escalation. A **dispatch** that sets this without its own `writeScope` is read-only even when the profile carries one (`review`'s report directory is the shape): the dispatch's intent wins. Name a `writeScope` in the same layer to keep "read-only except this one file". |
| `maxReads` | `number` | Cap on successful reads. |
| `allowTools` | `string[]` | Extra non-executor tool names to allow. It cannot widen a path tool: names this layer already judges are judged first, so adding `replace` here does not let it write outside the write scope. Unioned with the profile's list; `reset: true` (below) drops that list so a dispatch can be narrower than its role. |
| `reset` | `boolean` | On a layer that has one below it (the role over `default`, the dispatch over the role): "only these entries this time". Clears the lower layer's `bash.read` / `bash.write` / `bash.allow` **and** its `allowTools` before this layer's own lists are applied, so both a command allowlist and a tool allowlist can be made tighter than the layer below. `bash.deny` is not cleared. `bash.reset` is the same thing for the bash columns alone. See [Profiles](#profiles). |
| `tools` | `object` | Per-tool overrides for tools the defaults do not cover: `{ "my_edit": { "access": "write", "path": "file" } }`. `access` is `read` or `write`; `path` names the argument holding the target path, or is `false` for a tool with no path argument (a write tool declared that way is always refused); `transferSource` (`read`/`write`) says how a two-file tool's **source** is judged — `copy` reads its source while `move` deletes from it, and the built-in defaults already say so. The path argument name is taken from the tool's own schema when omitted, so anchors-based tools usually need only `access`. A malformed entry refuses everything. |
| `maxDenies` | `number` | Consecutive grant refusals before the run stops; an allowed working call resets the count. `0` disables. Defaults to 5. |
| `maxWriteDenies` | `number` | The same budget for write refusals, which are counted separately; defaults to 2. |
| `probe` | `object \| boolean` | Circles-and-collisions detection; see [probes](architecture.md#probes). |

### bash

| Field | Type | Meaning |
| --- | --- | --- |
| `bash.read` / `bash.write` | `string[]` | Commands allowed to only read or to write, matched per token as a prefix, or `re:` regexes (which see the command exactly as written). A leading `NAME=value` assignment is stripped before matching — `HOME=/tmp/x node a.ts` matches an entry `node` — so an entry must start with the program name: `HOME=/tmp node` is a rule that can never fire. Names that change which program runs or load code into it (`LD_*`, `NODE_*`, `GIT_*`, `PYTHON*`, `PATH`, `IFS`, `PAGER`, `BASH_ENV`, …) are refused instead, because they would turn an allowlisted command into arbitrary code. |
| `bash.reset` | `boolean` | Only meaningful on a layer that has one below it: drop that layer's `bash.read`, `bash.write` and `bash.allow` before this layer's lists are applied — "only these entries this time", so a task can be tighter than its role. `bash.deny` is not dropped. The top-level `reset` does the same and also clears `allowTools`; see [Profiles](#profiles). |
| `bash.writable` | `boolean` | Grant write access to the write scope, for tests and builds; git's own directories and `node_modules` are added, so `git add`/`commit` and an install work. Only scope entries that cover a whole subtree open a directory; file-level entries open just the files they match. In a linked worktree git's grant excludes `.git/hooks` and `.git/config`; in a plain checkout it cannot. |
| `bash.network` | `boolean` | Restore networking inside the sandbox. |
| `bash.writablePaths` | `string[]` | Further writable paths, such as the pnpm store. |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are derived from the toolchain manifests the project has; `false` disables detection, an array appends explicit directories. |
| `bash.env` | `object` | Environment variables injected into the sandbox. |
| `bash.deny` | `string[]` | Commands no caller can re-allow. A project profile's entries are unioned in from the caller's own, so a dispatch can add deny entries but never remove one, and neither `reset` nor `bash.reset` lifts them. |
| `bash.dependencyGate` | `boolean \| string[]` | Defaults to `true`. Before a write-classified command or a package-manager invocation runs, every directory in the working tree (two levels down) that has a package-manager lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`/`bun.lock`) must also show an install — `node_modules/.bin`, or `.pnp.cjs` for a Yarn PnP project; if one does not, the command is refused and the directory is named. Read-only commands and `git` are exempt: `git` needs no dependencies, and committing work is what keeps a worktree alive. A wrapper does not hide the payload — `sh -c "pnpm test"`, `env pnpm test` and `exec pnpm test` are gated too. What a script file contains (`node build.mjs`) is not visible from the command line, so that form passes; the gate is a guard against a confusing install attempt, not a boundary. It catches a missing install, not an install that is stale against the lockfile — the latter is pnpm's own `verify-deps-before-run` territory. An array lists directory prefixes to skip, for a lockfile nobody installs — a `fixtures/` sample, a vendored example: a plain path covers that directory and everything below it (the same reading as a `scope` entry), resolved against the working directory, but the match stops at a path boundary, so `fixtures` does not cover `fixtures-old`. Entries are literal paths, not globs; a glob is named in the refusal rather than silently matching nothing. `[]` skips nothing, the same as `true`. `false` turns the check off. |
| `bash.cpuStallSeconds` | `number \| false` | Off by default. When set, the helper samples the CPU time of the whole command tree — it is PID 1 of a private PID namespace, so the tree is what `/proc` shows — and kills it once the tree has used **no** CPU for that many seconds, printing why and exiting `79`. The point is to separate a deadlock from a slow build, which a wall-clock limit cannot: a compiling tree gains CPU in every sample, a tree waiting on a lock, a socket, or an orphaned child gains none. Two limits to know before turning it on: a command that deliberately waits (`sleep 300`, a backoff loop) also uses no CPU and will be killed, and the helper cannot see output because stdio is inherited rather than piped, so "no output" cannot corroborate the reading. That is why nothing is armed by default — pick a number well above your slowest quiet gap between CPU bursts. The kill is annotated with `[sandbox]` in the result, saying a retry will stall the same way. |

### What bash may read

The sandbox's read face stays open: `node`, `rg`, `cargo` and the rest live in `/nix/store`, so narrowing
the read root would kill every command at once. Reads are the file tools' job — `read`, `grep`, `find`
and `ls` are judged against `scope` before they run.

One nudge applies on top, for **read-class** commands only (the `bash.read` column), and it is judged
against the **working tree**: the directory the command runs in, which is the session's cwd. A token
qualifies as a path when it contains a slash and consists only of path characters — `src/index.ts`,
`./a.ts`, `../outside/x` and `~/x` all do, while `foo`, `--flag` and `@scope/pkg` do not. It is resolved
(symlinks by their real target) and, when that real path lands outside the working tree, the command is
refused with the path named:

```text
pi-subagents-extend: "/home/someone/notes" is outside the working tree (source: …). This is a path nudge,
not a wall: the command runs in /home/shay/extensions/pi-subagents-extend, and a file outside it is not
yours to read — say what you need from it instead.
Working tree: /home/shay/extensions/pi-subagents-extend
```

The point is the shape of a wasted run, measured: a child hunting for an API inside a 258 MB package with
`rg -a -o '<pattern>' /nix/store/…` produced empty output for every pattern that did not exist, read that
as "no match", and burned half an hour on 140 more guesses. Naming the path ends that in one turn — and
that command is refused now, because a toolchain directory is where a child goes looking, not what the
task is about.

It is a nudge, so it is deliberately loose, and the looseness is the design, not an oversight: a token
that could be something else — quoted, containing `$VAR` or a backtick, a glob, a URL, a colon — is
skipped rather than guessed at, and nothing is checked past the first 32 candidates or in tokens over 200
characters. These count as allowed:

| Command | Why it passes |
| --- | --- |
| `/nix/store/…/bin/rg -n pattern` | the program token is exempt: it is the tool being run, not a file of the task's |
| `cat /etc/passwd` | `/etc`, `/proc`, `/dev` and `/sys` are the system's, not the task's |
| `node -e 'require("/nix/store/x")'` | the token is quoted, so it is skipped |
| `rg "$DIR"` | dynamic, so the token is skipped |
| `rg foo https://example.com/a` | a URL, so skipped |
| `rg foo /tmp/out.md` | the command's private scratch directory, unless the session's cwd is itself under it — then the helper does not privatise that directory and it is an ordinary host path |
| `rg -n ./src/auth/login.ts` | inside the working tree, so the check passes — the same holds for the bare spelling `src/auth/login.ts`, which is a candidate too since it contains a slash |
| `rg foo escape-link/x` | **refused** when `escape-link` is a symlink to `/home/other`: the relative spelling is not an escape route, the real path is what counts |

A quoted token is skipped whole, so `rg foo "/home/other/x"` runs: the quoting is the reason, not what
the argument means. One gap is worth knowing: `~user/x` is not expanded — only `~/` is — so the token
lands under the working tree and passes, while `~/x` does expand and points at the home directory, which
is outside the tree.

Refusals here are charged to `maxDenies`, like the other refusals a wider grant would answer, and the
message says which way out applies: use `read` when the read scope covers the file, or say what is
needed from a file outside the tree.

**`scope` and the working tree are two different contracts.** `scope` is the authorisation for the
**file tools** — `read`, `grep`, `find`, `ls`, `edit`, `write` — and it can be much narrower than the
tree: `scope: ["src/auth/**"]` is the normal shape. The **working tree** is where a command runs, and it
is what this nudge judges, because a build or a test run has to read the whole tree: `cargo build` reads
`Cargo.toml`, `pnpm` reads the root `package.json`. Judging a bash argument by `scope` would refuse
those ordinary commands. So the two answer different questions: `scope` answers *may this file tool read
this file*, the working tree answers *may this command point at this path*.

### Allowlist entries that cannot work from the working directory

Some allowlist entries can never fire from the session's working directory. The extension says so
once at session start, instead of letting the child discover it by running the command:

- A package-manager entry (`pnpm`, `npm`, `yarn`, `bun`) needs a `package.json`, and `cargo` needs a
  `Cargo.toml`. Both are looked up **from the working directory upwards** (eight levels at most),
  the way the tools themselves do it: a child running in `packages/pi-plugin/` still finds the
  repository's manifest, so such an entry is not reported. Entries that need no manifest at all
  (`pnpm --version`, `pnpm store path`, `npm --help`, `pnpm dlx`, `bun test`) are not reported either, and
  neither are entries whose scope the working directory does not decide (`--manifest-path`, `-r`,
  `--filter`, cargo's `-C`). An entry that names its own package directory (`--dir`, `--prefix`)
  is judged against that directory, not against the working tree.
  The walk starts at the **resolved** path: a command runs in the process's physical working directory,
  so a `package.json` that exists only on the literal path (an ancestor reached through a symlink) is one
  the tool will never see. Walking both chains would judge such a dead grant reachable and stop reporting
  it — the opposite of what this check is for. If the path cannot be resolved (it no longer exists), the
  literal path is used so the judgement does not throw.
- An absolute-path entry is checked against the file system. A path inside a build-artefact
  directory (`target`, `dist`, `build`, `out`, `node_modules`, `.git`, `.venv`, `__pycache__`) is
  not reported while the file is missing: it only needs one `cargo build`.

A reported entry comes with the reason, and with the form that would work when the working tree
holds exactly one package that has the script (`pnpm --dir packages/pi-plugin run typecheck`).
With several candidate packages it lists up to eight of them instead of picking one — which package an
entry meant is the parent's to say — and summarises the rest as `… and N more`, because a monorepo can
hold hundreds and one message has to stay readable. When the only candidate does not have the script
the entry names, it says ``no candidate has a `typecheck` script`` rather than asking which package was
meant: that is a missing script, not a wrong directory, and moving to another package cannot fix it.

The same fact reaches the child: when such a command runs and fails, the result is annotated with
`[sandbox] this command ran, but "pnpm run typecheck" cannot work from <cwd>: …`, followed by the
form to use or the candidate list (capped the same way). The entry it names is **the one the allowlist
actually used to authorise the command**, not merely another entry that matches it: the allowlist can hold
a reachable `pnpm --dir packages/a run build` next to an unreachable `pnpm run typecheck`, or next to a
wider `pnpm` that would also match — a failure of the first must not be explained with either of the
others. Once the list is truncated, the text says so (`only the first 8 are listed`): asking someone to
pick from a list whose tail was cut is asking for a guess. The annotation is only added to a failed result.

## Recommended scenarios

### A reviewer that may write exactly one report

The report is longer than a reply can carry, and a reviewer that cannot write has to compress it.
`readOnly` alone forbids every write; naming one absolute path allows that file and nothing else.

```json
{
  "scope": ["."],
  "readOnly": true,
  "writeScope": ["/tmp/pi-review-reports"],
  "allowTools": ["read", "grep", "find", "ls", "bash", "write", "contact_supervisor"],
  "maxDenies": 12,
  "maxWriteDenies": 2,
  "bash": { "writable": false, "dependencyGate": false, "read": ["git diff", "git show", "rg", "cat", "ls"] }
}
```

The grant is the path, not the name: `read` / `write` / the host's edit family are judged by the scopes
*before* `allowTools` is consulted, so listing `write` there neither authorises nor restricts it — the
example lists it only because a reader otherwise wonders. Bash redirection (`>`, `>>`) is refused by the
metacharacter rule regardless, which is deliberate: the report goes through the `write` tool, where the
path can be judged.

That ordering has one consequence worth knowing: a tool this layer does not recognise is *not* judged by
the scopes, so allowlisting a **new** write tool (a plugin's own edit tool) allows it unjudged. Declare
it under `tools` — `{ "access": "write", "path": "<its path argument>" }` — and the scopes apply.

### A coder in a worktree

The whole tree readable and writable, with publishing reserved to the parent.

```json
{
  "scope": ["."],
  "writeScope": ["."],
  "bash": {
    "read": ["git status", "git diff", "git log", "ls", "rg", "cat", "node", "sh"],
    "write": ["pnpm", "cargo", "mkdir", "cp", "mv", "rm", "touch", "git add", "git switch", "git stash"],
    "deny": ["git commit", "git push", "git rebase", "git merge", "git reset", "git clean", "rm -rf"]
  }
}
```

`git commit` is in `deny` rather than simply left out of `write`, so no dispatch can re-allow it —
that is what a deny list is for, and it is the one part of a profile a caller cannot override.

### A read-only researcher

```json
{ "scope": ["."], "readOnly": true, "maxReads": 60, "bash": { "read": ["rg", "git log", "git show", "ls"] } }
```

`maxReads` is a task-shape signal, not a security control: a researcher that needs 200 reads is
usually reading the wrong things. Hitting the cap is a refusal, so it is charged to `maxDenies`.

### A build or test runner

```json
{ "scope": ["."], "writeScope": ["."], "bash": { "writable": true, "read": ["pnpm test", "cargo test", "cargo check"] } }
```

`bash.writable` opens the write scope plus the machinery a build needs: `node_modules`, the
artefact directories of whichever toolchains the project declares (detected from manifests, never
from git), and in a linked worktree the parts of `.git` that `git add`/`commit`/`stash` write.

## Writing a report instead of escalating

A refusal is meant to end in a report, not a widened grant. The extension says which way out
applies, and the two differ:

- **A write refusal** (outside `writeScope`, `readOnly`, `writeScope: []`) cannot be fixed by
  asking for a wider read scope, so it is charged to `maxWriteDenies` and the answer is *deliver
  this as a report*.
- **A grant refusal** (path outside `scope`, a command not in the list, `allowTools`) is charged to
  `maxDenies`, and `contact_supervisor` is the way to ask for it.

Neither counts usage errors — a missing path, a shell metacharacter, an empty command — so a
malformed call never spends the budget.

## Profiles

Bindings written per dispatch are easy to forget, and forgetting them means no restriction at all.
A project can declare per-role defaults once, in `.pi/subagent-bindings.json`:

```json
{
  "coder": { "scope": ["."], "writeScope": ["."], "bash": { "deny": ["git push"] } },
  "review": { "scope": ["."], "readOnly": true, "writeScope": ["/tmp/pi-review-reports"] }
}
```

and load one from a two-line module the agent declares:

```ts
// .pi/agent-profiles/review.ts
import { profile } from "/path/to/pi-subagents-extend/packages/pi-plugin/src/profile.ts"
export default profile("review")
```

Three layers, one direction — `default` → role → dispatch:

| Layer | Where it is written | What it does |
| --- | --- | --- |
| `default` | the `"default"` key of `.pi/subagent-bindings.json` | the **floor** for every role in the project; it applies to all of them |
| role | that role's own key in the same file | **adds to** `default`; it does not replace it |
| dispatch | the `extensionBindings` of one call | **adds to** the role's result |

So a role inherits what `default` supplies instead of restating it, and a dispatch inherits the role's.
Narrowing is the separate, explicit act described below (`reset: true`) — a role or a dispatch cannot
be made tighter just by writing a shorter list.

Merging is **per field** — never one layer replacing another — and the field list is the whole rule:

| Category | Fields | Why |
| --- | --- | --- |
| **union** | `bash.read`, `bash.write`, `bash.allow`, `allowTools`, `bash.writablePaths` | the profile's entries stay and the call's are appended (base first, duplicates dropped), so a dispatch can authorise one more command without restating the list it already has. An **empty array written in the upper layer** is not "add nothing" — it empties that column (see below), and because `bash.write` and `bash.allow` are one column with two spellings, emptying either empties both; `allowTools` has no empty-list form, `reset: true` is how that list is cleared |
| **union, hard floor** | `bash.deny` | a deny entry is a restriction, not a grant, and no layer can lift one: "structurally forbidden" has to survive a dispatch that rewrites the allowlist |
| **replaced** | `scope`, `writeScope` | a task's range has to be able to be **narrower** than the role default. A union would grow file access on every dispatch — the wrong direction for the one field that decides what may be read, and it would make "narrower than the role" inexpressible |
| **the call wins** | `readOnly`, `maxReads`, `maxDenies`, `maxWriteDenies`, `probe`, `tools`, `bash.writable`, `bash.network`, `bash.dependencyGate`, `bash.cpuStallSeconds`, `bash.scratchPaths` | these describe *this* task, so the dispatch's value is the value. `probe` and `tools` are replaced whole, not deep-merged. `bash.env` merges per variable name, the call winning on a collision |

Why `deny` can never be anything but a union: a profile's deny list is where a project writes what must
not happen at all (`git push`, `git reset`). If a call could replace it, every dispatch would have to
restate the whole list, and the one that forgets silently opens the command.

`reset: true` is how a layer says "only these entries this time" — the one way to be **narrower** than
the layer below. It clears the lower layer's `bash.read` / `bash.write` / `bash.allow` **and** its
`allowTools` before the layer's own lists are applied:

```json
{
  "pi-subagents-extend/1": {
    "scope": ["src/auth/**"],
    "reset": true,
    "allowTools": ["read"],
    "bash": { "read": ["pnpm run typecheck"] }
  }
}
```

That dispatch may run `pnpm run typecheck` and nothing else, and its `allowTools` is exactly `["read"]`
rather than a union with the role's list, however many commands and tools that profile carries. A role
uses the same key against `default`:

```json
{
  "default": { "bash": { "read": ["git push"] } },
  "review": { "reset": true, "bash": { "read": ["git diff"] } }
}
```

`review` may run `git diff` and not `git push`. Without `reset` it would inherit both, because
`default` is a floor rather than a peer.

`bash.reset: true` is the same thing for the bash columns alone — it does not touch `allowTools`. It
predates the top-level key and still reads well beside `bash.read`.

`bash.deny` is **not** reset by either key: the project's prohibitions still apply, which is the point
of it being a floor rather than a default.

An explicit empty list is a third instruction, distinct from both "omitted" and "one more entry":
`"read": []` says *this column is empty* and drops the column it inherited, while omitting `read`
inherits it and `"read": ["x"]` appends to it. So `"bash": { "read": [], "write": [] }` turns bash off
for a dispatch even when its role carries a long allowlist — writing the empty lists is how you say
"none of it", and it is the same refusal as having no `bash` field at all.

`bash.allow` is the legacy single-list spelling of the same column as `bash.write` — a command in either
one is authorised as a write — so they are merged **as one column, not as two keys**: emptying either of
them empties the column, even when the other spelling is written in the same object. `"allow": []` with
`"write": ["git status"]` therefore drops a `write` the profile supplied and keeps only `git status`, and
the mirror image behaves identically. Key-wise merging got this wrong: the same intent ("keep only this
one") produced two different columns depending on which spelling the *profile* had used, which is the same
silent retention the empty list exists to prevent, only harder to see.

A dispatch that sets `readOnly: true` without a `writeScope` is read-only even when the profile carries
one (`review`'s report directory is that shape): the read-only intent would otherwise be cancelled by
a grant the dispatch never asked for. Add `"writeScope": ["/tmp/pi-review-reports"]` in the same
dispatch to keep "read-only except this one directory".

When both layers are in play the refusal's `source:` names both —
`profile impl (.pi/subagent-bindings.json) + extensionBindings` — because the entry that answered may
have come from either file.

A dispatch to a role that has a profile passes only `agent`, `model` and `task` —
the three pieces a new role needs are in the usage skill
[`pi-subagents-extend`](../packages/pi-plugin/skills/pi-subagents-extend/SKILL.md#call-template).

### Do not pin the edit tool in an agent definition

An agent definition's `tools` field is a strict allowlist over *registered* names, not a request to
load anything. That makes it host-dependent: the builtin `edit` disappears on a host running
`pi-hashline-edit-pro` (which deletes it and registers `replace`, `replace_match`, `insert`, `copy`,
`move`, `undo_last_change`), so a definition listing `edit` stops at the child's first request with
"declares tools: …, but an extension loaded in this child replaced the tools sent to the model".
Listing the anchored family instead breaks the child on every host that still has the builtin, and
listing both is fatal too, since a declared tool that never registered is itself a run error.

Leave `tools` out and let this layer bound the child: it judges path tools by the scope and refuses
everything that is not a known path tool, a safe tool, or allowlisted. Read-only roles can keep a
narrow `tools` list as long as every name exists on every host (`read`, `grep`, `find`, `ls`,
`bash`, `write` all do).

## Without a parent agent

Hand bindings reach the extension through `PI_SUBAGENT_EXTENSION_BINDINGS`:

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-subagents-extend/1":{"scope":["src/**"],"readOnly":true}}' \
pi -e ~/extensions/pi-subagents-extend/packages/pi-plugin/src/index.ts -p "<task>"
```

`/permission` reports what the session actually resolved: source, read scope, write scope when it
differs, the bash allowlist, both denial counters and the probe state.
