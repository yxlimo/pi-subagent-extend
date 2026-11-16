# Architecture

## Three entry points

The package exposes three modules. Which audience a module serves is decided by **how it is
loaded**, never by inspecting the session at run time.

| Entry point | Loaded by | Behaviour |
| --- | --- | --- |
| `src/index.ts` | the agent's `subagentOnlyExtensions`, plus ambient loading | scope and bash |
| `src/main-context.ts` | ambient loading only (`.pi/extensions/` symlink or a global install) | injects `.pi/main-only.md` into the main session; in a background subagent it strips the markers instead |
| `src/child-context.ts` | declared by an agent's `subagentOnlyExtensions` only | strips the markers, never injects |

Two context modules exist because a foreground subagent and the main session **cannot be told
apart from inside the process**: a foreground subagent runs in the same process and has no
`PI_SUBAGENT_CHILD`, so its environment is identical to the main session's, while a background
subagent is a separate process carrying that variable. The `PI_SUBAGENT_CHILD === "1"` check in
`main-context.ts` exists to stop background subagents, which load it ambiently too.

pi's frontmatter has two fields that matter here: `subagentOnlyExtensions` (this agent's
subagents) and `extensions` (same, plus the session itself). Foreground subagents load only what
is declared there; background subagents additionally load ambient extensions.

## Configuration sources

Two, and either can stand alone:

- **Bindings**, passed by the parent on each dispatch as
  `extensionBindings: { "pi-subagent-extend/1": { … } }`. pi-subagents encodes them into
  `PI_SUBAGENT_EXTENSION_BINDINGS`; the extension reads that variable once at activation, because
  it exists only until a foreground subagent's session starts and is then restored.
- **A profile**, a per-role default declared in the project and loaded through a two-line module
  the agent declares. See [agent profiles](#agent-profiles).

Without either, the extension does nothing: no scope, no refusals, no side effects.

Wildcards: `**` matches any number of directory levels, `*` any characters within one level, `?`
one character. A pure path glob also matches the directory itself and everything beneath it, so
`src` and `src/**` both cover the whole directory. Malformed bindings, or an invalid `scope`, fail
closed: the session keeps running, every file access is refused, and the refusal states why.

## The refusal model

While a scope is active the extension fails closed — a tool that is not listed here is refused
too.

| Tool | Behaviour |
| --- | --- |
| `read` | path resolved (a missing one means the working directory), allowed when inside the scope, subject to `maxReads` |
| `edit` / `write` | the target must be inside the write scope (`writeScope`, defaulting to `scope`); refused even inside it when `readOnly` is set |
| `grep` / `find` / `ls` | as `read` |
| `bash` | refused entirely without an allowlist; with one, only matching commands are allowed and each is rewritten to run under the helper |
| `powershell` / `codemode` | always refused: there is no path to judge, so they would escape the scope |
| `structured_output` | allowed: a session-level tool that touches no files |
| `contact_supervisor` / `intercom` | always allowed: asking the supervisor is the escalation channel |
| anything else | refused, except names listed in `allowTools`; executor-type tools stay refused |

The last rule is what makes the extension a boundary rather than a filter: a tool added by some
other extension is refused until someone names it.

### The three write layers

Reads and writes are authorised by different lists, and neither is merged into the other:

| Layer | Field | Governs |
| --- | --- | --- |
| read | `scope` | `read`, `grep`, `find`, `ls` |
| write, tools | `writeScope` | `edit`, `write` |
| write, processes | `bash.writablePaths` (with `bash.writable`) | the Landlock rules of bash subprocesses |

Without the split, "read the whole repository, write only `.pi/reviews`" cannot be expressed: a
reviewer either may edit `lib/` or may write nothing at all.

Keeping the third layer separate is not tidiness. A `git commit` inside a worktree writes to the
main checkout's `.git/objects`, which has to be granted — and `.git` must never appear in the write
scope, because that is what opens repository metadata to hand editing.

With `bash.writable`, the sandbox is therefore given the write scope plus git's own directory and
`node_modules`, not the working directory wholesale. A subagent that may read `lib/` but not write
it cannot route around the rule with a shell redirect.

Build and test artefacts are the exception that makes this usable, and which ones they are follows
from what the project is built with. `bash.writable` grants the artefact directories of every
toolchain whose manifest appears in the repository root or up to two levels below it — `package.json`
for Node, `Cargo.toml` for Rust, `go.mod` for Go, `pyproject.toml` for Python, `pom.xml` and
`build.gradle` for Java, and the rest of that table in `TOOLCHAINS` — with each directory resolved
next to its manifest, so a monorepo's `packages/web/coverage` lands in the right place.

Two tiers keep this quiet. A directory that exists is granted; a directory the toolchain always
creates (`target`, `__pycache__`, `_build`) is also created when missing, because the first
`cargo test` in a fresh checkout would otherwise fail; anything merely conventional (`dist`, `.next`,
`coverage`) is granted only when the project already has it. The extension does not invent
directories it has no evidence for, and it never consults git for this: `git ls-files --ignored`
answers what is generated, which is not the same question as what the project builds with, and it
costs two subprocesses per sandboxed command.

Caches that belong outside the repository (`go`'s build cache, mypy's) are moved with a single
`XDG_CACHE_HOME` pointing at a persistent `~/.cache` directory. The sandbox's `/tmp` is a per-call
tmpfs, so a cache there is thrown away every command: measured on a fresh module, `go test` takes
3.5 s cold and 51 ms from the second call with the redirect, while a read-only host cache only lets
go reuse what is already there.

**A missing path is its own message.** `read` without a `path` assumes the repository root, and
`write` without one cannot be judged at all. Both say so, instead of pretending the scope rule
was the problem — an agent that reads "out of scope" tries a different path, while an agent that
reads "no path was supplied" supplies one.

### Probes

Four criteria detect a subagent going in circles or colliding with its permissions. The two
error-signal ones are on by default, because they misfire rarely. The two time-based ones misfire
on slow tasks, so they only apply when named: `"probe": {}` or `"probe": true` enables every
default, a partial object enables only the fields it names, `"probe": false` disables all of them.

| Criterion | Default | Behaviour |
| --- | --- | --- |
| Read-only idling | explicit: `idleWriteMs: 360000`, `abortGraceMs: 120000` | no write activity within `idleWriteMs` warns at the next tool boundary; after `abortGraceMs` more, the turn stops |
| Repeating a command | on, `repeatBash: 3` | the third identical `bash` command warns, the fourth stops |
| Finished early | explicit: `successIdleMs: 300000`, `successPatterns` | once output matches a success marker, no new change within `successIdleMs` stops the turn |
| Writing litter | explicit: `forbidWritePatterns: []` | a `write`/`edit` target matching the pattern is refused outright |

Write activity means `edit` and `write` calls and commands matching `bash.write`. Reads do not
count, or a subagent could circle with read-only `bash` and escape the criterion. A task with
`readOnly: true` skips the two time-based criteria, which are meaningless for it.

### The denial budget

`maxDenies` defaults to five; an explicit `0` disables it. Only refusals that **widening the
parent's authorisation could resolve** count: an out-of-scope path, a command not in the
allowlist, the read budget, a `readOnly` write, a tool missing from `allowTools`, bash disabled.

Write refusals have their own budget, `maxWriteDenies`, defaulting to two. It is separate on
purpose: a reviewer that keeps trying to write its report is making a usage mistake, and the answer
is to deliver the report another way, not to conclude that the parent granted the wrong scope. A
single out-of-scope read therefore does not push a write refusal towards a stop, and the refusal
says so — it names the write scope and points at the report.

Usage errors and hard rules never count: a missing path, shell metacharacters, an empty command,
`powershell`/`codemode`, or a command matched by a profile's `bash.deny`. Those cannot be fixed by
granting more, so charging them against the budget would stop a task for the wrong reason.

### The stop is hard

At the budget the subagent is warned that the parent most likely authorised the wrong paths, and
is told to escalate; one more counted refusal ends the run. Every blocked result carries
`terminate`, so pi ends the turn as soon as the whole batch is terminating. There is no closing
report after a stop: the parent reads what the subagent produced before it, plus the refusal text.

That is why `contact_supervisor` and `intercom` are checked **before** every stop mechanism. Once
a run is stopping, the model cannot act on advice — the refusal text addresses the parent instead,
and the rescue channel stays open so a difficulty can be reported rather than silently absorbed.

Refusals are written for the model that reads them: short, and saying what would have to change.

## What a refusal adds

Two annotations are appended to a `bash` result, both to stop an agent from retrying something
that cannot start working.

**Network.** When the command ran offline and failed on the network (`ENETUNREACH`, `EAI_AGAIN`,
`ENOTFOUND`, a resolve failure), a one-line `[sandbox]` note says the network is off per the
parent's bindings, that this is a permission rather than a broken machine, that retrying will fail
the same way, and that `contact_supervisor` asking for `"network": true` is the way out. A raw
errno reads like a broken machine, which is exactly what makes an agent retry with another
registry, flag or timeout.

**Writes.** A `bash` write outside the granted directories is decided by evidence, not wording:
the extension keeps the `write` list of the spec the command ran under, takes the path out of the
refusal line, and annotates only when that path is outside the list **and** the host can read it.
A readable path that Landlock refused cannot have been refused for reading, since reads are
unrestricted — that is what keeps `cat /etc/shadow: Permission denied` from being blamed on the
sandbox. Unresolvable cases stay silent rather than guess.

Neither note counts toward the denial budget, triggers a stop, or consumes the read budget: they
explain a result that already happened.

## Context isolation

Three places for content, chosen by whom it belongs to:

| Content | Where | Visible to a subagent |
| --- | --- | --- |
| rules a subagent must follow too | an ordinary `AGENTS.md` section | yes |
| content that reads better beside the repository rules but is the main agent's | fenced by `<!-- main-agent-only:start -->` … `<!-- main-agent-only:end -->` | no |
| content that is wholly the main agent's | `.pi/main-only.md` | no |

The whole span between a pair of markers, comments and trailing blank line included, is removed
from a subagent's prompt; the main agent reads it unchanged. When a marker is left unterminated the
section is **kept** and the session records a warning: letting a subagent read one extra passage is
better than deleting half a file on a guess about where the boundary lies.

`.pi/main-only.md` is resolved against the project root and injected through pi's `sections` rather
than by rewriting the system prompt, because pi diffs sections and appends a single system message,
so the earlier prompt cache still hits.

A subagent started with `context: "fork"` receives the parent's prompt whole, isolation included;
isolation therefore requires avoiding fork context. This does not overlap pi-subagents'
`inheritProjectContext: false`, which is all-or-nothing and does not read the file at all — right
for a repository whose rules are irrelevant to subagents, wrong for one whose rules a subagent must
follow.

## Agent profiles

Bindings have a practical gap: they can only be written by the parent **on each dispatch**, and an
agent definition has nowhere to declare a default. Omitting them does not remove three
prohibitions — it returns at the top of `tool_call`, so every restriction disappears.

A profile attaches defaults to whichever entry point an agent declares, since the audience has to
come from the loading path:

```ts
// .pi/agent-profiles/writer.ts — the path must be absolute: Node does not expand `~`
import { profile } from "/path/to/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
export default profile("writer");
```

```json
// <project>/.pi/subagent-bindings.json
{
  "default": { "maxDenies": 5 },
  "writer": {
    "bash": {
      "read": ["git status", "git diff"],
      "write": ["pnpm test"],
      "writable": true,
      "deny": ["git stash", "git checkout", "git reset"]
    }
  },
  "review": { "readOnly": true, "bash": { "read": ["git diff", "rg"] } }
}
```

Merging rules:

- The call's bindings override the profile per key, and `bash` overrides as a whole object; arrays
  are never merged, so a grant cannot be widened by accident.
- `bash.deny` is a union **no caller can relax**. That is what makes a project's structural
  prohibition different from an ordinary allowlist.
- A profile may omit `scope`, since a role does not know a task's paths. File access is then
  refused entirely while the bash allowlist still applies, so a forgotten binding fails loudly on
  the first read instead of silently permitting everything.
- A profile that cannot be read — missing file, malformed JSON, neither `default` nor the role name
  present — results in deny-all rather than no restriction.

The main session never loads these modules, so project defaults cannot lock it down by accident.

## Skills

The extension publishes three skills and registers them through `resources_discover`, so they
reach the system prompt of whichever session loads the extension and nothing has to be copied into
`AGENTS.md`:

| Skill | Contents |
| --- | --- |
| `pi-subagent-extend` | file scope, the two bash columns and `re:` patterns, the sandbox, worktree setup, profiles, a call template |
| `pi-subagent-extend-probes` | the probe criteria, the denial budget, warn and stop semantics, how to read a report after a stop |
| `pi-subagent-extend-context` | the markers, `.pi/main-only.md`, the three entry points |

pi advertises only a skill's name and description, so each description names the situations it
covers — the routing decision rests on that line alone. A session that is already scoped does not
register them.

## Boundaries

- The scope is a file-level boundary, not a content-level one: including `docs/**` permits reading
  the whole directory.
- Reads are unrestricted inside the sandbox, because a test suite must read the tree, its
  `node_modules` and its configuration. Read confinement stays with `read`, `grep` and `find`.
- The extension intercepts at `tool_call`. A subagent inherits the parent's environment and
  credentials, so this guards against overstepping, not against malice.
- Nested subagents do not inherit bindings: an unscoped nested subagent runs without this
  extension. Either disable `allowNestedSubagents` for a scoped session or pass bindings on the
  nested call.
