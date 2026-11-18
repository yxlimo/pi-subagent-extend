# Testing

`pnpm test` runs four suites, all offline: no model, and no network beyond localhost.

| Suite | Cases | What it is |
| --- | --- | --- |
| `test/extension.test.ts` | 97 | the extension's own judgement, against a fake pi API |
| `test/context.test.ts` | 10 | the marker stripping and `.pi/main-only.md` injection |
| `test/mock-session.test.ts` | 6 | a real pi process, driven by a scripted mock model |
| `test/hashline-e2e.test.ts` | 4 | a real pi process loading the real `pi-hashline-edit-pro` |

`cargo test` in `packages/helper` covers the sandbox itself: the ABI check, the ruleset, the
namespace decisions, the capability drop and process supervision.

## One suite whose cases run the helper for real

Several scope cases do not stop at inspecting the rewritten command: they execute it, so the
assertion is about the kernel rather than about the string. Those run only where the kernel can
enforce the sandbox. Below Landlock ABI 7 the suite points `PI_SUBAGENTS_EXTEND_HELPER` at a stub
that answers `--describe` with ABI 7 and runs nothing, says so in its output, and the live blocks
print `skip` — asserting on the stub's silence would test the stub, not the sandbox.

The helper the suite executes is the cargo build output
(`packages/helper/target/release/pi-subagents-extend-helper`), never the copy in
`packages/pi-plugin/bin/`: that copy is what a loaded extension resolves, so a test run that wrote
to it would replace the binary under a live session. `pretest` therefore only builds; installing
into `bin/` is the separate `pnpm run build:helper`, and `PI_SUBAGENTS_EXTEND_HELPER` overrides
the path when a specific binary is wanted.

Verified both ways through that override: a fake ABI 3 helper gives three skips and a green suite,
and the real one executes all of them.

The suites are TypeScript and are included in `tsconfig.json`, so `pnpm run typecheck` checks them
too. That is not cosmetic: `await h.call(...)?.block` reads the property off the promise, which the
compiler rejects and JavaScript silently accepts as `undefined` — the shape of a test that passes for
the wrong reason.

`scripts` in `package.json` run them through node's type stripping, so there is no build step
between editing a test and running it.

## How the tool-judging layer is covered

The layer decides whether a tool call may touch a path, so most cases assert one of three things:
allowed, refused by the read scope, or refused by the write scope.

Tool *classification* is declared, not inferred: `DEFAULT_TOOL_ACCESS` maps a name to `read` or
`write`, `bindings.tools` overrides it, and the path *argument* name is read from the tool's own
`parameters` schema (`path`, else `file_path`). Cases 86-91 pin the declared classification: `replace`
and `undo_last_change` are judged by the write scope, `allowTools` cannot widen a path tool, a missing
target names the argument without charging the budget, a custom tool is judged by its declaration,
`path: false` means always refused, a malformed `tools` entry refuses everything, the schema-derived
argument name is honoured, and a tool named `constructor` or `__proto__` cannot reach a declaration
through the prototype chain.

Case 95 covers `replace_match` separately, because it was the one tool whose anchors the list did not
know: its two ends are called `replace_from` / `replace_to` (the host's own schema), not the
`remove_from` / `remove_to` that `replace` uses. Missing that pair meant every anchor-only
`replace_match` — its normal shape on a host with `requirePath` off, i.e. the host this layer targets —
was refused with "pass the path explicitly", advice the model cannot follow.

Case 96 covers anchors that do not agree on one file. Two shapes reach or could be imagined here, and
only the first is reachable:

- `remove_from` in one file and `remove_to` in another. This arrives at this layer untouched, and the
  rule refuses it rather than judging whichever anchor happened to resolve first. The host's own
  `resolveEditTarget` refuses it too (`paths.size > 1`), so the point is that this layer's decision does
  not *depend* on the host getting there first: a target that is not unique has no answer, and picking
  one is how a judgement silently covers the wrong file.
- both spellings at once, pointing at different files. This one cannot reach the layer: the host
  normalizes aliases in `prepareArguments` before schema validation, and pi's `tool_call` hook receives
  the post-normalization arguments (`agent-loop`: `prepareToolCallArguments` → `validateToolArguments` →
  `beforeToolCall({args})`). The case pins it anyway as the same rule, and says so.

Mutation-verified on the reachable shape: restoring first-match-wins makes the case *allow* the split
payload. The test asserts refusal and the note the model gets, not a claim about the escape.

The two failure modes are reported differently, because their exits differ. An anchor that cannot be
resolved at all means "re-read the file, the anchors may have expired"; anchors that disagree mean the
payload itself is invalid, so the note names both files and says to split the call — re-reading would
hand back the same refusal. `anchorTargetPath` therefore returns `{path}` / `{miss: "unknown"}` /
`{miss: "disagree", files}`, and case 96 pins the disagree wording.

Case 97 covers the explicit `path` that `copy` / `move` accept. The anchors' owning file comes from the
registry as an absolute path (`toCwd`), and the host compares the *resolved* form of `providedPath`
against it (`resolveInCwd` → `toCwd`). This layer must compare the same way: comparing the raw input
string rejected every relative spelling — `docs/b.md`, `./docs/b.md` — which is the form the model
usually gives and the form the host's own `read` output displays, so legitimate transfers were refused
with advice ("pass the path") the model had already followed. Mutation-verified: restoring the raw
comparison turns the relative-source assertion red.

Cases 92-93 cover recovering a write target from anchor ownership, which the host records in
`sessions/<sha256(sessionFile)[0:24]>.registry.jsonl` as `allocate` / `free` / `clear` events. A
resolver miss must refuse, never allow. Case 93 deliberately uses `scope: ["."]`: with a narrower
scope the fallback target `.` would be refused for the wrong reason and the case would stop
discriminating.

Case 94 covers the two-file tools. `copy` and `move` name a source and a destination in one
call, and the two must be judged separately: resolving them into one list returns whichever anchor
comes first, and that is the source, so the destination went unchecked — a copy out of the write
scope was allowed. The case pins both directions (copy's source may be read-only, move's may not),
the escape (destination outside the write scope is refused, naming the destination), the positive
controls (both sides writable is allowed, so "refuse everything" cannot pass), the
`transferSource` override, and an unresolved destination.

Every case here was mutation-verified — the implementation was reverted and the suite went red —
because a case that cannot fail proves nothing.
## End-to-end against the real host extension

`test/hashline-e2e.test.ts` is the only suite that loads a **third-party** extension.
`pi-hashline-edit-pro` is a pinned devDependency, and the suite drives it in a real pi process:
scripted model, real tool schemas, real anchor sidecar.

The unit cases above test this layer against a fake pi and a fake sidecar — that is, against *my
model* of the host. Two things this layer depends on belong to the host, not to me: the shape of its
tool arguments, and the anchor registry it writes (a JSONL sidecar next to a sqlite hash store).
Either can change in a release and leave every unit case green while a real subagent either cannot
edit a file at all or writes outside its scope. So the verdict here is not a message: it is whether
the file on disk changed.

Anchors cannot be written into a script — the host derives them from file content — so the second
scripted step is a **function** of the incoming messages: it reads the anchor out of the previous
`read` result and calls the tool with it. That is why `mock-llm.ts` accepts function steps.

The four cases: an anchor-only edit inside the write scope lands on disk (proves the sidecar
resolution works against the real format); an anchor owned by an out-of-scope file is refused and
that file is untouched; a cross-file `copy` whose destination is outside the write scope is refused
and the destination is untouched; and the reverse control — a `copy` whose source is read-only and
whose destination is writable — succeeds, so the three refusals cannot be satisfied by refusing
everything.

The host's config directory is redirected with `PI_HASHLINE_DIR`, which the host honours itself, so
its sidecar and hash store land in a temporary directory and the user's real configuration is never
touched. If the package is missing the suite fails rather than skipping: a suite that skips when the
host is absent is a suite that never runs.


## The mock model

`test/mock-llm.ts` is a dependency-free OpenAI-compatible server: `/v1/models`, and
`/v1/chat/completions` streaming `chat.completion.chunk` with text steps and tool-call steps. The
"model" is a script of steps, so a boundary is exact rather than left to chance — whether a run
continued is simply whether the next step was requested. `mock.requests.length` is the signal: after
a hard stop it stops growing.

Sessions run through the officially exported `RpcClient` (`--mode rpc`), a long-lived child whose
lifetime the test controls. `pi -p` is unsuitable because it exits as soon as the parent agent goes
idle, which loses the process while a background subagent is still running.

The session is isolated with `PI_CODING_AGENT_DIR` pointing at a temporary agent directory whose
`models.json` declares the mock as an OpenAI-completions provider, so the user's own configuration is
not touched. Fake `contact_supervisor` and `structured_output` tools are registered by a fixture
(`-e` loads both it and the extension), because in a real session those come from other extensions;
their executions are recorded as marker files, which is how "the rescue channel really ran" is
asserted. `contact_supervisor` and `structured_output` need no `allowTools` entry: they are in the
safe set and are always allowed. The handoff cases additionally need `allowTools: ["subagent"]`,
because the fake `subagent` tool is not in that safe set.

The six cases: a hard stop after two out-of-scope reads with no closing turn; a mixed batch where
`contact_supervisor` runs while the same batch is refused (the case a real model cannot be relied on
to produce); an in-scope control; the regression where a call after a stop reports the stop reason
instead of a fresh verdict; and the two channels that carry the worktree handoff annotation.

## Real-model runs

For final debugging only, never part of `pnpm test`:

```bash
pnpm run test:llm                      # pi's default model
PI_E2E_MODEL=<provider>/<model> pnpm run test:llm
PI_E2E_KEEP=1 pnpm run test:llm        # keep the temporary project and read the transcripts
```

It creates a disposable project holding an `AGENTS.md` with markers, a `.pi/main-only.md`, a
`.pi/extensions/` symlink and two agent definitions, then runs four sessions: the main session, a
foreground subagent, a background subagent (`async: true`) and a control without the extension. The
verdict rests on codes that exist only inside the isolated content: the main session and the control
must produce them, both subagents must answer `NONE`. The background subagent writes its answer to a
file itself, so collecting that evidence does not depend on the parent turn being woken.

A boundary a real-model run reveals comes back as a scripted case in the mock suite, so the suite
stays deterministic.

## Continuous integration

Four legs, all running the full suite. The images are pinned by version, because what these legs
assert is a property of the kernel, and `ubuntu-latest` moved from 24.04 to 26.04 underneath: a
floating label would change the subject of the test without changing the test. Each leg prints its
image and running kernel.

| Leg | Measured kernel | Landlock ABI | Namespaces | Asserts |
| --- | --- | --- | --- | --- |
| `26.04-namespaces` | 7.0.0-1019-azure | 8 | allowed after a sysctl | `network isolated` |
| `24.04-namespaces` | 7.0.0-1014-aws | 8 | allowed after a sysctl | `network isolated` |
| `26.04-fallback` | 7.0.0-1019-azure | 8 | refused by AppArmor | `cannot enter the namespaces` |
| `22.04-abi4` | 6.8.0-1070-azure | 4 | allowed | `ABI 7 is required`, exit 76 |

Ubuntu's default (`apparmor_restrict_unprivileged_userns=1`) lets the user namespace be created and
then refuses `setgroups`, mount, network and PID; the leg that needs them lifts the restriction with
a `sudo sysctl` on a throwaway VM. The fallback leg deliberately leaves it alone.

Each leg's self-check runs the helper directly and fails the build unless it reports the shape that
leg is supposed to see, so a run that quietly took the wrong path fails instead of passing. One
such check already paid for itself: the helper used to print its "network isolated" line only when
there were resolver sockets to shadow, which made "real namespaces" and "silently fell back" look
identical in the log.

24.04 turned out to run a 7.0 kernel as well, so the two namespace legs differ in image, kernel build
and flavour (aws against azure) rather than in kernel generation. 6.8 is the only older kernel on
offer, and at ABI 4 it cannot run the sandbox at all — that leg tests the refusal.
