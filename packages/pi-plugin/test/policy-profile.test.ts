// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  CommandSpec,
  EventHandler,
  ExtensionModule,
  FakeExtensionApi,
  HandlerOptions,
  Harness,
  AnnotatedMessages,
  Outcome,
  PatchedResult,
  SessionContext,
} from "./types.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")

// The suite must not write into the developer's real home. Spec files, `git-excludes` and the
// `xdg-cache` tree live in the extension's state directory, so point that at a throwaway one for
// the run. Not `tmpdir()`: the helper mounts a private tmpfs over `/tmp`, so a grant underneath
// it cannot take effect — the helper refuses such a spec (exit 77) and names the tmpfs as the
// cause.
// Redirecting `HOME` instead is too blunt: on CI `cargo` is rustup's shim and tries to create
// `$HOME/.rustup`, which the sandbox refuses because the package directory is not a write grant.
const realState = process.env.PI_SUBAGENTS_EXTEND_STATE
const testState = mkdtempSync(join(repo, ".test-state-"))
process.env.PI_SUBAGENTS_EXTEND_STATE = testState

// Cleanup runs on `exit` too, not only on the success path: a failed assertion would otherwise
// leave `.test-state-*` behind as an untracked directory, and pi-subagents' own patch capture
// (`git add -A`) would sweep it into a patch. Both steps are idempotent.
const restoreState = (): void => {
  if (realState === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
  else process.env.PI_SUBAGENTS_EXTEND_STATE = realState
  rmSync(testState, { recursive: true, force: true })
}
process.on("exit", restoreState)
// `exit` does not run on a signal: Ctrl-C during a run would leave the directory behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restoreState()
    process.exit(130)
  })
}

// The sandbox helper is a Rust binary. Tests execute the cargo build output and
// never the copy in `bin/`: that copy belongs to a loaded extension, so writing to
// it during a test run would swap the binary out from under a running session —
// `ETXTBSY` at best, a silent behaviour change between calls at worst. An explicit
// override wins, so a stub can be substituted; then the build output; a packaged
// `bin/` copy is the last resort for a checkout with no Rust toolchain.
function resolveHelperBin(): string {
  const candidates = [
    process.env.PI_SUBAGENTS_EXTEND_HELPER?.trim(),
    join(repo, "..", "helper", "target", "release", "pi-subagents-extend-helper"),
    join(repo, "bin", "pi-subagents-extend-helper"),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    "no sandbox helper found; run `cargo build --release --manifest-path packages/helper/Cargo.toml`",
  )
}
const helperBin = resolveHelperBin()

// These cases inspect the command the extension rewrites and the spec it writes;
// none of them executes the helper, so the kernel's Landlock ABI only decides
// whether bash is offered at all. Where the ABI is below the required 7 the real
// helper refuses bash, and the suite would report a failure that says nothing about
// the extension. Point the environment at a stub instead: enforcement is covered by
// the helper's own cargo tests and by running this suite on a 6.15 or later kernel.
interface HelperDescription {
  landlock?: { kernel_abi?: number; supported?: boolean }
  network_namespace?: boolean
}

function helperAbi(bin: string): HelperDescription | undefined {
  const out = spawnSync(bin, ["--describe"], { encoding: "utf8" });
  try {
    return JSON.parse(out.stdout) as HelperDescription;
  } catch {
    return undefined;
  }
}

const described = helperAbi(helperBin);
// Cases that execute the helper for real need a kernel that can enforce the
// sandbox. With the stub there is nothing to enforce, so those parts are skipped
// instead of asserting on the stub's silence.
if (described?.landlock?.supported) {
  process.env.PI_SUBAGENTS_EXTEND_HELPER = helperBin
} else {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-stub-"))
  const stub = join(stubDir, "pi-subagents-extend-helper")
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"landlock":{"kernel_abi":7,"required_abi":7,"supported":true,"reason":null},"network_namespace":true,"resolver_sockets":[]}'\n`,
  )
  chmodSync(stub, 0o755)
  process.env.PI_SUBAGENTS_EXTEND_HELPER = stub
  console.log(
    `  note  kernel Landlock ABI ${described?.landlock?.kernel_abi ?? "unknown"} is below the required 7;` +
      " the suite runs against a stub helper that reports ABI 7",
  )
}



const ext = (await import(join(repo, "src", "index.ts"))) as unknown as ExtensionModule

/**
 * The documented dispatch payload nests policy under `permissions`. Most cases in this suite
 * predate that contract and pass the policy fields flat, so the harness lifts them into the
 * documented shape; cases that pin the contract itself pass `rawBindings` to opt out.
 */
const wrapDispatchBindings = (raw: string | undefined): string | undefined => {
  if (!raw) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw
  const table = parsed as Record<string, unknown>
  let changed = false
  for (const [key, value] of Object.entries(table)) {
    if (!key.startsWith("pi-subagents-extend/")) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const ns = value as Record<string, unknown>
    if (Object.hasOwn(ns, "permissions")) continue
    // 块级键（worktree/setup/output）在派单里与 permissions 平级，其余是策略字段。
    const blockLevel = ["worktree", "setup", "output"]
    const permissions: Record<string, unknown> = {}
    const rest: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(ns)) {
      if (blockLevel.includes(name)) rest[name] = field
      else permissions[name] = field
    }
    table[key] = { ...rest, permissions }
    changed = true
  }
  return changed ? JSON.stringify(table) : raw
}

type HandlerArgs = HandlerOptions & { rawBindings?: boolean }

/**
 * Activate the extension with the given bindings env and return its tool_call handler.
 * Pass `profile` to activate through the profile loader (per-role defaults).
 */
async function handler({ bindings, rawBindings, cwd = workdir, profile, profileFile, piTools }: HandlerArgs = {}): Promise<Harness> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = rawBindings ? bindings : wrapDispatchBindings(bindings)

  const handlers: Record<string, EventHandler> = {}
  const commands: Record<string, CommandSpec> = {}
  const ui: string[] = []
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }
  if (piTools) api.getAllTools = () => piTools
  ext.activate(api, profile ? { profileName: profile, profileFile } : {})

  const aborts: string[] = []
  const ctx: SessionContext = { cwd, ui: { notify: (message: string) => ui.push(message) }, actions: { abort: () => aborts.push("abort") } }
  if (handlers.session_start) {
    // session_start is async but only reports; flush it before returning.
    await handlers.session_start({ type: "session_start" }, ctx)
  }

  // pi 给每次工具调用一个新 id，所以默认 id 也按调用递增：写死 "t1" 会让「两次调用
  // 各自带 spec」的用例看起来像是靠泄漏才成立。result 不带 id 时配对**最近一次** call，
  // 这样「call 完紧跟 result」的老写法照旧成立。
  let callSeq = 0
  let lastCallId = "t0"
  const call = async (
    toolName: string,
    input?: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<Outcome> => {
    const id = toolCallId ?? `t${++callSeq}`
    lastCallId = id
    return (await handlers.tool_call({ type: "tool_call", toolCallId: id, toolName, input }, ctx)) as Outcome
  }
  const result = async (
    toolName: string,
    content: unknown,
    isError = false,
    toolCallId?: string,
  ): Promise<PatchedResult | undefined> =>
    (await handlers.tool_result?.(
      {
        type: "tool_result",
        toolCallId: toolCallId ?? lastCallId,
        toolName,
        input: {},
        content,
        isError,
      },
      ctx,
    )) as PatchedResult | undefined
  const context = async (messages: unknown[]): Promise<AnnotatedMessages | undefined> =>
    (await handlers.context?.({ type: "context", messages }, ctx)) as AnnotatedMessages | undefined
  /** Fire session_shutdown, which is where the extension sweeps stale spec files. */
  const shutdown = async (): Promise<void> => {
    await handlers.session_shutdown?.({ type: "session_shutdown" }, ctx)
  }

  return {
    call,
    result,
    context,
    shutdown,
    aborts,
    ui,
    commands,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}



const workdir = mkdtempSync(join(tmpdir(), "pi-subagents-extend-test-"))
mkdirSync(join(workdir, "src/auth"), { recursive: true })
{
  // Cases 29-30 share the fixture case 28 creates in extension.test.ts; recreate it here so
  // this file runs standalone.
  const proj = join(workdir, "proj-profile")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({
      default: { bash: { read: ["mise run typecheck"], write: ["mise run fix"] } },
      impl: { bash: { read: ["mise run test"], write: ["mise run fix"] } },
    }),
  )
}
// 29. Profile defaults and the call's bindings merge per key.
{
  const proj = join(workdir, "proj-profile")
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "the call's scope applies")
  const out = await h.call("read", { path: "docs/x.md" })
  assert.equal(out?.block, true, "the call's scope still bounds reads")
  assert.match(out.reason, /profile impl/, "source names the profile that supplied defaults")
  const input = { command: "mise run test" }
  assert.equal(await h.call("bash", input), undefined, "profile bash applies alongside the call's scope")
  h.restore()
  console.log("  ok   profile 与 bindings 按 key 合并")
}

// 30. The call's bash is unioned with the profile's, field by field — not applied as a whole
// object. Merging as a whole object failed in the direction that matters: a dispatch that added
// one grant made every grant in the profile disappear, so "authorise one more command" became
// "restate the whole list", and a delegation could never widen anything at all.
{
  const proj = join(workdir, "proj-profile")
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, bash: { read: ["pnpm test"] } },
    }),
  })
  const added = { command: "pnpm test" }
  assert.equal(await h.call("bash", added), undefined, "the entry this dispatch added runs")
  const inherited = { command: "mise run test" }
  assert.equal(await h.call("bash", inherited), undefined, "the profile's read entry survives the call's bash")
  const inheritedDefault = { command: "mise run typecheck" }
  assert.equal(await h.call("bash", inheritedDefault), undefined, "the entry the default layer supplied survives too")
  const inheritedWrite = { command: "mise run fix" }
  assert.equal(await h.call("bash", inheritedWrite), undefined, "the union is per column: the profile's write list survives")
  const outside = await h.call("bash", { command: "curl https://example.com" })
  assert.equal(outside?.block, true, "a command in neither layer is still refused")
  h.restore()
  console.log("  ok   调用方的 bash 与 profile 并集，不是整体覆盖")
}
// 130. `bash.reset: true` says "only these entries this time": the profile's `bash.read` /
//      `bash.write` are dropped before the call's own are applied. Pinned because a union on every
//      layer leaves no way to narrow — a role that lists 27 commands would be a floor, not a
//      default, and a dispatch that has to be tighter could not say so.
{
  const proj = join(workdir, "proj-reset")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({
      default: { bash: { read: ["git status"] } },
      impl: { bash: { read: ["mise run test"], write: ["mise run fix"] } },
    }),
  )
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        maxDenies: 0,
        bash: { reset: true, read: ["pnpm test"] },
      },
    }),
  })
  assert.equal(await h.call("bash", { command: "pnpm test" }), undefined, "the entry this dispatch named runs")
  const droppedRoleRead = await h.call("bash", { command: "mise run test" })
  assert.equal(droppedRoleRead?.block, true, "reset drops the role's read column")
  assert.match(
    String(droppedRoleRead?.reason),
    /command not in the allowlist/,
    "a dropped entry is refused as not allowed, not as forbidden by the project",
  )
  const droppedDefaultRead = await h.call("bash", { command: "git status" })
  assert.equal(droppedDefaultRead?.block, true, "reset drops the default layer's read column as well")
  const droppedWrite = await h.call("bash", { command: "mise run fix" })
  assert.equal(droppedWrite?.block, true, "reset drops the write column too, not only read")
  h.restore()
  console.log("  ok   bash.reset 丢弃 profile 的白名单，只留本次派单给的条目")
}

// 131. `scope` is replaced, not unioned. Unioning scopes would grow file access on every dispatch —
//      the opposite of what a narrower task range is for — so the call's scope wins whole and a path
//      only the profile's scope covered is refused. Both files exist, so the refusal is about the
//      scope and not about a missing target.
{
  const proj = join(workdir, "proj-scope-replace")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "docs"), { recursive: true })
  writeFileSync(join(proj, "src", "a.ts"), "")
  writeFileSync(join(proj, "docs", "x.md"), "")
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ impl: { scope: ["src/**", "docs/**"] } }),
  )
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "the call's narrower scope still covers what it named")
  const outside = await h.call("read", { path: "docs/x.md" })
  assert.equal(outside?.block, true, "a path only the profile's scope covered is refused")
  assert.match(String(outside?.reason), /outside the read scope/, "the refusal is the scope rule, not a usage error")
  h.restore()
  console.log("  ok   scope 仍是替换：派单的范围可以比 profile 更窄")
}

// 132. `bash.deny` stays a union under `bash.reset: true` too. Reset narrows the allowlists; it is
//      not a way to dissolve a project prohibition — deny is the hard floor, and the dispatch that
//      names the forbidden command in its own write column still does not get it.
{
  const proj = join(workdir, "proj-reset-deny")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({
      default: { bash: { deny: ["git stash"] } },
      review: { bash: { read: ["git diff"] } },
    }),
  )
  const h = await handler({
    cwd: proj,
    profile: "review",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        maxDenies: 0,
        bash: { reset: true, read: ["git diff"], write: ["git stash"] },
      },
    }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(stash?.block, true, "reset does not drop the profile's deny entries")
  assert.match(
    String(stash?.reason),
    /blocked by the project profile/,
    "the refusal still says the project forbids it, so the reader knows which file to change",
  )
  assert.equal(await h.call("bash", { command: "git diff" }), undefined, "a command outside the deny list still runs")
  h.restore()
  console.log("  ok   bash.deny 在 reset 之后仍然并集：禁令不随白名单一起丢")
}

// 133. A role layer adds to `default`; it does not replace it. The profile's own two layers use
//      the same merge as a dispatch, so the direction matters: `default` is every role's floor,
//      and a role that names one command must still keep the ones the floor supplied. The reverse
//      ("the role overrides") reads plausible and is what the comment here used to claim --
//      pinning the choice so the two cannot drift apart again.
{
  const proj = join(workdir, "proj-default-floor")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({
      default: { bash: { read: ["git show"] } },
      floor: { bash: { read: ["git diff"] } },
      narrow: { reset: true, bash: { read: ["git diff"] } },
    }),
  )
  const h = await handler({ cwd: proj, profile: "floor" })
  assert.equal(
    await h.call("bash", { command: "git show" }),
    undefined,
    "the role inherits the entry the default layer supplied",
  )
  assert.equal(await h.call("bash", { command: "git diff" }), undefined, "the role's own entry applies as well")
  h.restore()
  console.log("  ok   default 是角色的地板：角色在它之上追加，不是替换")
}

// 134. `reset: true` on the role layer is how it narrows under that floor. 133 and this one are
//      two halves of one rule: the floor is a default, not a cage -- without reset there would be
//      no way for a role to drop a command the file grants to everyone.
{
  const proj = join(workdir, "proj-default-floor")
  const h = await handler({ cwd: proj, profile: "narrow" })
  const dropped = await h.call("bash", { command: "git show" })
  assert.equal(dropped?.block, true, "reset drops the entry the default layer supplied")
  assert.match(
    String(dropped?.reason),
    /command not in the allowlist/,
    "a dropped entry is refused as not allowed, not as forbidden by the project",
  )
  assert.equal(await h.call("bash", { command: "git diff" }), undefined, "the role's own entry still runs")
  h.restore()
  console.log("  ok   角色层的 reset: true 能比 default 更窄")
}

// 135. `reset: true` narrows `allowTools` too. `allowTools` had no counterpart for reset, so a
//      dispatch that meant "only these tools" still handed the role every tool the profile listed.
//      Both halves are asserted: without reset the profile's allowance survives (the union that
//      makes a profile useful at all), with reset it is gone.
{
  const proj = join(workdir, "proj-allow-reset")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ impl: { allowTools: ["read", "todo_write"] } }),
  )
  const items = { items: [] }
  const unioned = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, allowTools: ["read"] },
    }),
  })
  assert.equal(
    await unioned.call("todo_write", items),
    undefined,
    "without reset the profile's allowance survives the dispatch's own list",
  )
  unioned.restore()

  const narrowed = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, reset: true, allowTools: ["read"] },
    }),
  })
  const dropped = await narrowed.call("todo_write", items)
  assert.equal(dropped?.block, true, "reset drops the profile's allowance: only this dispatch's list remains")
  assert.match(
    String(dropped?.reason),
    /not on the allow list/,
    "the refusal is the allow-list rule, so the reader knows which key to change",
  )
  narrowed.restore()
  console.log("  ok   reset 同时收窄 allowTools：只留本次派单点名的那几个")
}

// 136. An explicit empty list empties that column. "Wrote this column" and "did not write it" are
//      different instructions: `read: []` + `write: []` is how a dispatch disables bash, and both
//      the skill and `parseBashRule` say so. Treating the empty list as "add zero entries" left the
//      profile's whole allowlist in place -- the dispatch asked for no bash and got the grant.
{
  const proj = join(workdir, "proj-empty-bash")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ impl: { bash: { read: ["git status"] } } }),
  )
  // The profile's entry has to work on its own, or "it stopped working" proves nothing.
  const open = await handler({ cwd: proj, profile: "impl" })
  assert.equal(await open.call("bash", { command: "git status" }), undefined, "the profile's entry runs on its own")
  open.restore()

  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, bash: { read: [], write: [] } },
    }),
  })
  const denied = await h.call("bash", { command: "git status" })
  assert.equal(denied?.block, true, "an explicit empty read column drops the profile's entry")
  assert.match(
    String(denied?.reason),
    /bash\.read/,
    "the refusal is the no-bash-allowlist one, so the reader sees that no column applies rather than that this command is forbidden",
  )
  h.restore()
  console.log("  ok   显式空列表 = 清空该列：read:[] + write:[] 就是禁用 bash")
}

// 137. A dispatch that says `readOnly: true` without a `writeScope` wins over the profile's
//      `writeScope`. The review profile is shaped exactly like this (readOnly plus a report
//      directory), so a read-only dispatch to it used to keep reporting rights it never asked for:
//      the merged config carried the profile's writeScope and "explicit writeScope wins" handed it
//      back. Naming a writeScope in the same layer is still how "read-only + one file" is said.
{
  const proj = join(workdir, "proj-readonly-scope")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "reports"), { recursive: true })
  writeFileSync(join(proj, "src", "a.ts"), "")
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ review: { scope: ["."], readOnly: true, writeScope: ["reports"] } }),
  )
  const h = await handler({
    cwd: proj,
    profile: "review",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true, maxDenies: 0, maxWriteDenies: 0 },
    }),
  })
  const report = await h.call("write", { path: "reports/r.md", content: "x" })
  assert.equal(report?.block, true, "the dispatch's readOnly wins over the profile's writeScope")
  assert.match(
    String(report?.reason),
    /no write grant/,
    "the refusal is the read-only rule, not the write-scope rule: the profile's writeScope did not win",
  )
  const inTree = await h.call("write", { path: "src/a.ts", content: "x" })
  assert.equal(inTree?.block, true, "the task tree itself is not writable under readOnly")
  h.restore()

  const both = await handler({
    cwd: proj,
    profile: "review",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        readOnly: true,
        writeScope: ["reports"],
        maxDenies: 0,
        maxWriteDenies: 0,
      },
    }),
  })
  assert.equal(
    await both.call("write", { path: "reports/r.md", content: "x" }),
    undefined,
    "naming a writeScope in the dispatch still expresses read-only plus this one directory",
  )
  const stillReadOnly = await both.call("write", { path: "src/a.ts", content: "x" })
  assert.equal(stillReadOnly?.block, true, "readOnly still means the task tree is read-only")
  both.restore()
  console.log("  ok   派单的 readOnly 压过 profile 的 writeScope；同层写 writeScope 才算「只读 + 一个目录」")
}

// 138. A dispatch whose `bash` is not an object disables bash instead of being ignored. With
//      field-by-field merging a broken layer fell through to the profile's whole allowlist, so a
//      typo kept every grant -- the mirror image of `profilePolicy`'s promise that a broken layer
//      must not be papered over into "usable". Old semantics replaced the whole block, which landed
//      on "closed"; this pins that direction back.
{
  const proj = join(workdir, "proj-broken-bash")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ impl: { bash: { read: ["git status"] } } }),
  )
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, bash: "nonsense" },
    }),
  })
  const denied = await h.call("bash", { command: "git status" })
  assert.equal(denied?.block, true, "a broken bash field closes bash rather than inheriting the profile's list")
  assert.match(
    String(denied?.reason),
    /bash\.read/,
    "the refusal says no bash allowlist applies, which is what a broken field means",
  )
  h.restore()
  console.log("  ok   派单把 bash 写坏 = bash 被禁，不是静默沿用 profile 的整份白名单")
}
rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\npolicy module tests passed")
