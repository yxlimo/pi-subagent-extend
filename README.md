# pi-subagent-extend

A pi extension that confines a subagent to the files its task covers, and keeps main-agent-only
instructions out of a subagent's prompt.

> Formerly `pi-allow-reads`, then `pi-subagent-permission`. The binding namespace, the helper
> binary and the skill directories were renamed along the way; the former identifiers are not
> accepted.

When the parent agent delegates, it names the files the task covers. Inside the subagent, every
tool call outside that scope is refused, so a subagent cannot wander through the repository, and
`bash` — the one tool whose paths cannot be judged from its arguments — either stays disabled or
runs under a kernel sandbox that enforces the same boundary.

The second concern is context isolation. A section of `AGENTS.md` fenced by
`<!-- main-agent-only:start -->` and `<!-- main-agent-only:end -->` never reaches a subagent,
and content that belongs entirely to the main agent goes in `.pi/main-only.md`, which is injected
into the main session only. Either concern works without the other.

| Package | Directory | What it is |
| --- | --- | --- |
| `pi-subagent-extend` | `packages/pi-plugin` | the pi extension: scope, bash, context isolation |
| — | `packages/helper` | the sandbox helper (Rust: Landlock plus network, mount and PID namespaces) |
| — | `packages/worktree-setup` | a `worktreeSetupHook` for pi-subagents: runs whatever a project declares |

## Requirements

- Linux 6.15 or later for the sandbox (Landlock ABI 7). Below that, `bash` stays disabled rather
  than falling back to weaker rules; scope enforcement and context isolation are unaffected.
- pi-subagents, if you want the extension to be loaded per agent.

## Install

```bash
cd packages/pi-plugin
pnpm install
pnpm run build:helper
./install.sh
```

`install.sh` symlinks `~/.pi/agent/extensions/pi-subagent-extend`, which pi discovers on start.
With no bindings the extension is a no-op, so the global link has no effect on a parent session
or on an unscoped subagent.

To scope only the subagents of one agent, skip the global link and declare the extension in that
agent's frontmatter instead:

```markdown
---
name: worker
description: Implements a task within the given scope
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts
---
```

## Use

The parent passes the scope on each dispatch:

```text
subagent(
  agent: "worker",
  task: "Fix the null pointer in login.ts",
  extensionBindings: { "pi-subagent-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
)
```

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `string[]` | Globs describing what the subagent may read. Required; an empty array refuses all file access. |
| `writeScope` | `string[]` | Globs describing what `edit` and `write` may touch. Defaults to `scope`; an empty array makes writing impossible while reads keep working. A refused write is charged to `maxWriteDenies`, not `maxDenies`, and the refusal points at a report. |
| `readOnly` | `boolean` | Refuse `edit` and `write` even inside the scope: the same as `writeScope: []`, budget included — the refusal is charged to `maxWriteDenies` and answered with a report rather than an escalation. |
| `maxReads` | `number` | Cap on successful reads. |
| `allowTools` | `string[]` | Extra non-executor tool names to allow. |
| `maxDenies` | `number` | Consecutive grant refusals before the run stops; an allowed working call resets the count. `0` disables. Defaults to 5. |
| `maxWriteDenies` | `number` | The same budget for write refusals, which are counted separately; defaults to 2. |
| `probe` | `object \| boolean` | Circles-and-collisions detection; see [probes](docs/architecture.md#probes). |
| `bash.read` / `bash.write` | `string[]` | Commands allowed to only read or to write, matched per token as a prefix, or `re:` regexes. |
| `bash.writable` | `boolean` | Grant write access to the write scope, for tests and builds; git's own directory and `node_modules` are added, so `git add`/`commit` and an install work. |
| `bash.network` | `boolean` | Restore networking inside the sandbox. |
| `bash.writablePaths` | `string[]` | Further writable paths, such as the pnpm store. |
| `bash.scratchPaths` | `false \| string[]` | Adjusts the build/test artefact directories, which are derived from the toolchain manifests the project has; `false` disables detection, an array appends explicit directories. |
| `bash.env` | `object` | Environment variables injected into the sandbox. |
| `bash.deny` | `string[]` | Commands no caller can allow; only a project profile can set this. |

`/permission` shows the read scope, the write scope when it differs, the bash allowlist, both
read and write denial counts, and the probe state. The namespace is `pi-subagent-extend/1`;
bindings reach the subagent through `PI_SUBAGENT_EXTENSION_BINDINGS`, or by hand when there is no
parent agent:

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-subagent-extend/1":{"scope":["src/**"],"readOnly":true}}' \
pi -e ~/extensions/pi-subagent-extend/packages/pi-plugin/src/index.ts -p "<task>"
```

**Profiles.** Bindings written per dispatch are easy to forget, and forgetting them means no
restriction at all. A project can instead declare per-role defaults once, in
`.pi/subagent-bindings.json`, and load them from the agent definition. Merging favours the
stricter side: a call overrides a profile per key, except `bash.deny`, which no caller can
relax. See [architecture](docs/architecture.md#agent-profiles).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | the three entry points, the refusal model, probes, the denial budget, the hard stop, and the notes a subagent sees on a refusal |
| [docs/sandbox.md](docs/sandbox.md) | what the helper does: Landlock, the namespaces, capabilities, and why offline means "no route out" |
| [docs/worktrees.md](docs/worktrees.md) | the worktree setup hook, the `node_modules` link, and what a worktree run actually delivers |
| [docs/testing.md](docs/testing.md) | the offline suites, the mock model, and the four CI legs |

## Development

```bash
cd packages/pi-plugin && pnpm install && pnpm run typecheck && pnpm test
cd ../helper && cargo test
```

`pnpm test` runs a lint pass and then three offline suites: 50 scope cases, 10 context cases and 6
sessions against a real pi process driven by a scripted mock model. No model and no network beyond
localhost. The suites are TypeScript and are type checked with the source, so a typo in a fixture is
a compile error rather than an assertion that silently passes. See [testing](docs/testing.md).

## Boundaries

The scope is a file-level boundary, not a content-level one. The sandbox prevents out-of-scope
writes and network access, not reads, because running a test suite needs to read the whole tree.
Refusing `bash` outright is a deliberate decision, not a gap: the paths inside a shell command
cannot be parsed reliably.

The extension is not a sandbox against malicious code. A subagent inherits the parent's
environment and credentials, so this guards against a subagent overstepping its task, not against
an adversary. Genuinely untrusted input needs container-level isolation.
