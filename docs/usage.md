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
| `readOnly` | `boolean` | Refuse `edit` and `write`. On its own it is the same as `writeScope: []`; an explicit `writeScope` alongside it wins, so "read-only except this one file" is expressible. Charged to `maxWriteDenies`, answered with a report rather than an escalation. |
| `maxReads` | `number` | Cap on successful reads. |
| `allowTools` | `string[]` | Extra non-executor tool names to allow. It cannot widen a path tool: names this layer already judges are judged first, so adding `replace` here does not let it write outside the write scope. |
| `tools` | `object` | Per-tool overrides for tools the defaults do not cover: `{ "my_edit": { "access": "write", "path": "file" } }`. `access` is `read` or `write`; `path` names the argument holding the target path, or is `false` for a tool with no path argument (a write tool declared that way is always refused); `transferSource` (`read`/`write`) says how a two-file tool's **source** is judged — `copy` reads its source while `move` deletes from it, and the built-in defaults already say so. The path argument name is taken from the tool's own schema when omitted, so anchors-based tools usually need only `access`. A malformed entry refuses everything. |
| `maxDenies` | `number` | Consecutive grant refusals before the run stops; an allowed working call resets the count. `0` disables. Defaults to 5. |
| `maxWriteDenies` | `number` | The same budget for write refusals, which are counted separately; defaults to 2. |
| `probe` | `object \| boolean` | Circles-and-collisions detection; see [probes](architecture.md#probes). |

### bash

| Field | Type | Meaning |
| --- | --- | --- |
| `bash.read` / `bash.write` | `string[]` | Commands allowed to only read or to write, matched per token as a prefix, or `re:` regexes (which see the command exactly as written). A leading `NAME=value` assignment is stripped before matching — `HOME=/tmp/x node a.ts` matches an entry `node` — so an entry must start with the program name: `HOME=/tmp node` is a rule that can never fire. Names that change which program runs or load code into it (`LD_*`, `NODE_*`, `GIT_*`, `PYTHON*`, `PATH`, `IFS`, `PAGER`, `BASH_ENV`, …) are refused instead, because they would turn an allowlisted command into arbitrary code. |
| `bash.writable` | `boolean` | Grant write access to the write scope, for tests and builds; git's own directories and `node_modules` are added, so `git add`/`commit` and an install work. Only scope entries that cover a whole subtree open a directory; file-level entries open just the files they match. In a linked worktree git's grant excludes `.git/hooks` and `.git/config`; in a plain checkout it cannot. |
| `bash.network` | `boolean` | Restore networking inside the sandbox. |
| `bash.writablePaths` | `string[]` | Further writable paths, such as the pnpm store. |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are derived from the toolchain manifests the project has; `false` disables detection, an array appends explicit directories. |
| `bash.env` | `object` | Environment variables injected into the sandbox. |
| `bash.deny` | `string[]` | Commands no caller can re-allow. A project profile's entries are unioned in from the caller's own, so a dispatch can add deny entries but never remove one. |
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

Merging favours the stricter side: a call overrides a profile per key, except `bash.deny`, which no
caller can relax. A dispatch to a role that has a profile passes only `agent`, `model` and `task` —
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
