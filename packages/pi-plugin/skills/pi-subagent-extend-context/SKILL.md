---
name: pi-subagent-extend-context
description: When delegating a subagent, use it to keep main-agent-only content out of the subagent's prompt — the sections fenced by <!-- main-agent-only:start --> in AGENTS.md are invisible to the subagent, and main-agent-only rules go in .pi/main-only.md, which is injected into the main session only. Use it when AGENTS.md mixes in delegation discipline, waiting policy, reporting conventions or main-agent-only write-permission boundaries that a subagent would read as wasted context and mistake for its own duties. Covers the division of labour of the three entry points, how to write the markers, the fallback when a marker is left unclosed, and the trade-off against the all-or-nothing inheritProjectContext switch.
---

# Context isolation: let AGENTS.md feed only what should be fed

`AGENTS.md` goes in whole: a subagent reads it together with the passages that only mean something to the main agent — how to delegate, how to wait for the result, reporting conventions — wasting context, and it may also mistake the main agent's actions for its own duties.

This skill solves that: **the main agent sees everything, a subagent sees the version with the main-agent-only parts removed.**

The file scope and the bash allowlist are in `pi-subagent-extend`, the probe criteria are in `pi-subagent-extend-probes`. The three are independent, so you can use only one of them.

A subagent installing dependencies in a `worktree` is a separate matter (`worktreeSetupHook`), also covered by `pi-subagent-extend`.

## When to use it: who this content belongs to

| Content | Where | Visible to a subagent |
| --- | --- | --- |
| Rules a subagent must follow too (terminology, acceptance commands, no git push, code style) | an ordinary `AGENTS.md` section | yes |
| Content only the main agent needs, but that reads better written together with the repository rules | fenced in `AGENTS.md` by `<!-- main-agent-only:start -->` | no (stripped) |
| Content that is wholly the main agent's (how to delegate, the waiting and follow-up rhythm, how to talk to the user) | `.pi/main-only.md` | no (injected into the main session only) |

The three can be mixed. The test is simple: **would a subagent do the wrong thing by following it** — if yes, fence it or move it.

## How to write the markers

```markdown
# Repository conventions

## Terminology

**Upstream**: means the upstream API.

<!-- main-agent-only:start -->
## Delegation

Delegate with the `subagent` tool and wait for its result before deciding the next step.
Reporting format: which files were changed, what was run, what the result was.
<!-- main-agent-only:end -->

## Acceptance

`mise run test` all green.
```

The whole span (both comments and the trailing blank line included) is deleted from the subagent's prompt, while the main agent reads it as usual. The comments themselves are transparent to the model, so the main agent sees no extra marker noise.

There is only one rule: **the markers must close in pairs**. When there is a start but no end, that whole span is kept as it is, not stripped, and a warning is recorded in the session — better that a subagent sees one passage too many than that half a file is deleted on a guess about where the boundary is.

## The main-agent-only file

`.pi/main-only.md` (relative to the project root, the path is fixed). If it exists it is injected; if it does not, nothing happens.

The injection uses pi's `sections` rather than replacing the whole prompt: pi diffs per section, so a change only appends one system message and the earlier prompt cache still hits.

```markdown
<!-- .pi/main-only.md -->
## Delegation and collaboration

Always delegate with extensionBindings, scope it to the task, never to the whole repository.
While a subagent runs asynchronously, do not sit and wait; do something else, and collect the result when it comes back.
```

The content enters the prompt as it is, with no processing and no added heading — write it however you want it to look.

## Division of labour of the three entry points (read this when changing an agent definition)

Three entry points are wrapped, and they are loaded differently, **so do not declare them together**:

| Entry point | Who loads it | Behaviour |
| --- | --- | --- |
| `src/index.ts` | the agent's `subagentOnlyExtensions` + ambient loading | the permission scope and the bash allowlist (not covered here) |
| `src/main-context.ts` | ambient loading only (`pi.extensions` in `package.json`, i.e. the project `.pi/extensions/` symlink or a global install) | injects `.pi/main-only.md` in the main session; in a background subagent it strips the markers instead |
| `src/child-context.ts` | declared only by the agent's `subagentOnlyExtensions` | strips the markers, never injects |

In the agent definition both paths go on one line:

```yaml
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts, /path/to/pi-subagent-extend/packages/pi-plugin/src/child-context.ts
```

Why split into two files instead of one: **a foreground subagent cannot be distinguished from the main session within the process**. A foreground subagent is a session in the same process without `PI_SUBAGENT_CHILD`, with an environment identical to the main session's; a background subagent is a separate process and has that variable. So the "main-agent-only" logic can only determine its audience by the loading path, not by a runtime check. The `PI_SUBAGENT_CHILD === "1"` in `main-context.ts` exists to hold back background subagents — that file is also loaded by ambient loading, otherwise it would leak.

## The trade-off with inheritProjectContext

pi-subagents has a ready-made switch: `inheritProjectContext: false` makes the subagent **not read AGENTS.md at all** (in the implementation it simply turns on `noContextFiles`, so the file is never even read).

- When the repository rules mean nothing to subagents, this is the easiest option, with zero code.
- But as soon as one repository rule should also be followed by subagents (acceptance commands, no git push, terminology), switching everything off means copying those into every agent definition, and with many agents that becomes duplicated maintenance.

The marker approach of this skill keeps a single file and a single place to maintain. The two do not conflict: with `inheritProjectContext: false` the markers naturally have no meaning either (the file is not read in at all); an agent set to `false` does not need to declare `child-context.ts`.

Also note subagents with `context: "fork"`: they take the parent's whole system prompt along with the project context, so the markers are stripped by `child-context.ts`, but the injection of `.pi/main-only.md` already happened in the parent's prompt — an unexpected leftover. **If you want isolation, do not use fork context.**

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| The subagent still reads the content inside the markers | the agent definition does not declare `child-context.ts`; or that run was a fork context |
| The subagent reads `.pi/main-only.md` | that file was put into AGENTS.md or into some skill, it does not spread by itself; or the agent used fork context |
| The main session does not see `.pi/main-only.md` | the extension is not loaded via ambient loading (declaring it only in `subagentOnlyExtensions` means it is not loaded in the main session) |
| You see a warning about an `unclosed <!-- main-agent-only:start -->` | one half of the marker pair is missing, add `<!-- main-agent-only:end -->` |
