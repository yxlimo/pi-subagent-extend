# Testing

`pnpm test` runs three suites, all offline: no model, and no network beyond localhost.

| Suite | Cases | What it is |
| --- | --- | --- |
| `test/extension.test.ts` | 68 | the extension's own judgement, against a fake pi API |
| `test/context.test.ts` | 10 | the marker stripping and `.pi/main-only.md` injection |
| `test/mock-session.test.ts` | 6 | a real pi process, driven by a scripted mock model |

`cargo test` in `packages/helper` covers the sandbox itself: the ABI check, the ruleset, the
namespace decisions, the capability drop and process supervision.

## One suite whose cases run the helper for real

Several scope cases do not stop at inspecting the rewritten command: they execute it, so the
assertion is about the kernel rather than about the string. Those run only where the kernel can
enforce the sandbox. Below Landlock ABI 7 the suite points `PI_SUBAGENT_EXTEND_HELPER` at a stub
that answers `--describe` with ABI 7 and runs nothing, says so in its output, and the live blocks
print `skip` — asserting on the stub's silence would test the stub, not the sandbox.

The helper the suite executes is the cargo build output
(`packages/helper/target/release/pi-subagent-extend-helper`), never the copy in
`packages/pi-plugin/bin/`: that copy is what a loaded extension resolves, so a test run that wrote
to it would replace the binary under a live session. `pretest` therefore only builds; installing
into `bin/` is the separate `pnpm run build:helper`, and `PI_SUBAGENT_EXTEND_HELPER` overrides
the path when a specific binary is wanted.

Verified both ways through that override: a fake ABI 3 helper gives three skips and a green suite,
and the real one executes all of them.

The suites are TypeScript and are included in `tsconfig.json`, so `pnpm run typecheck` checks them
too. That is not cosmetic: `await h.call(...)?.block` reads the property off the promise, which the
compiler rejects and JavaScript silently accepts as `undefined` — the shape of a test that passes for
the wrong reason.

`scripts` in `package.json` run them through node's type stripping, so there is no build step
between editing a test and running it.

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
