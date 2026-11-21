// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
// 3. readOnly bindings block edit/write even inside the scope.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "read-only read passes")
  const edit = await h.call("edit", { path: "src/a.ts" })
  assert.equal(edit?.block, true, "read-only edit is blocked")
  assert.match(edit.reason, /no write grant/, "block reason says there is no write grant")
  h.restore()
  console.log("  ok   readOnly 时范围内也禁止 edit/write")
}

// 4. Explicit empty scope denies every file access.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: [] } }) })
  const read = await h.call("read", { path: "src/a.ts" })
  assert.equal(read?.block, true, "an explicit empty scope denies reads")
  h.restore()
  console.log("  ok   显式空范围拒绝一切文件访问")
}

// 5. Malformed bindings fail closed with a diagnosable reason.
{
  const h = await handler({ bindings: "{not json" })
  const read = await h.call("read", { path: "src/a.ts" })
  assert.equal(read?.block, true, "malformed bindings deny reads")
  assert.match(read.reason, /not valid JSON/, "block reason names the parse error")
  h.restore()
  console.log("  ok   bindings 损坏时 fail closed 并说明原因")
}
// 15. Glob semantics regression: `**` must not be re-rewritten by the `*` rule.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["web/src/**", "lib/**/x.ts", "a?b", "one.ts"] },
    }),
  })
  const allowed = ["web/src/a.vue", "web/src/x/y/z.vue", "lib/x.ts", "lib/a/b/x.ts", "aXb", "one.ts"]
  for (const path of allowed) {
    assert.equal(await h.call("ls", { path }), undefined, `"${path}" is inside the scope`)
  }
  const denied = ["web/other.ts", "web/srcs/a.ts", "lib/a.ts", "a/b", "two.ts"]
  for (const path of denied) {
    const refused = await h.call("ls", { path })
    assert.equal(refused?.block, true, `"${path}" is outside the scope`)
  }
  h.restore()

  // A bare `**` means the whole tree.
  const all = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"] } }) })
  for (const path of ["README.md", "deep/dir/file.ts", "web/src/x/y.vue"]) {
    assert.equal(await all.call("ls", { path }), undefined, `"**" covers "${path}"`)
  }
  all.restore()
  // A trailing slash is just another way to write the directory.
  const slash = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/auth/"] } }) })
  for (const path of ["src/auth", "src/auth/login.ts", "src/auth/a/b/c.ts"]) {
    assert.equal(await slash.call("ls", { path }), undefined, `"${path}" is inside "src/auth/"`)
  }
  const narrow = await slash.call("ls", { path: "src/other.ts" })
  assert.equal(narrow?.block, true, "trailing-slash scope stays narrow")
  slash.restore()
  console.log("  ok   glob：** 覆盖整棵树，dir/** 与 dir/ 覆盖任意深度，* 不跨层")
}
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
// 41. writeScope: read the whole task scope, write only one directory.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src", "lib", ".pi/reports"], writeScope: [".pi/reports"], maxDenies: 0, maxWriteDenies: 0 },
    }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "reading the source tree still works")
  assert.equal(await h.call("grep", { path: "lib" }), undefined, "searching lib still works")
  assert.equal(await h.call("write", { path: ".pi/reports/review.md", content: "x" }), undefined, "writing inside writeScope works")

  const denied = await h.call("write", { path: "lib/x.ts", content: "x" })
  assert.equal(denied?.block, true, "writing outside writeScope is refused even though it is readable")
  assert.match(denied.reason, /readable but not writable/, "the refusal names the collision: readable, not writable")
  assert.match(denied.reason, /write scope is \.pi\/reports/, "the refusal shows the write scope")
  assert.match(denied.reason, /report/i, "the refusal points at the right way out: report it")
  assert.equal(await h.call("read", { path: "lib/x.ts" }), undefined, "the same path stays readable")
  h.restore()
  console.log("  ok   writeScope：全范围可读，只有一份目录可写，拒绝文案说清撞的是写范围")
}

// 42. No writeScope means write == read; an empty one means read-only writes.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await h.call("write", { path: "src/a.ts", content: "x" }), undefined, "without writeScope, in-scope writes pass")
  h.restore()

  const empty = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], writeScope: [], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await empty.call("read", { path: "src/a.ts" }), undefined, "reads are unaffected by an empty writeScope")
  const blocked = await empty.call("write", { path: "src/a.ts", content: "x" })
  assert.equal(blocked?.block, true, "an empty writeScope refuses every write")
  assert.match(blocked.reason, /readable but not writable/, "and says it is a write refusal, not an unreadable path")
  empty.restore()
  console.log("  ok   writeScope 缺省等于 scope；空数组等于只读")
}

// 43. readOnly with no writeScope is read-only; writeScope: [] is the same thing.
//     早先这里钉的是「readOnly 压过 writeScope」，于是「只读会话 + 一份报告文件」无法表达。
//     现在显式 writeScope 才是那个文件（见 79），不写才等价于空写范围。
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true } }),
  })
  const edit = await h.call("edit", { path: "src/a.ts", content: "x" })
  assert.equal(edit?.block, true, "readOnly without a writeScope refuses every write")
  assert.match(edit.reason, /no write grant/, "and says there is none")
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "reads still work")
  h.restore()

  const empty = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true, writeScope: [] } }),
  })
  const same = await empty.call("edit", { path: "src/a.ts", content: "x" })
  assert.equal(same?.block, true, "an explicit empty writeScope is the same situation")
  empty.restore()
  console.log("  ok   readOnly 不写 writeScope 就是只读；显式写才放行（见 79）")
}
// 45. dir/** really covers files directly under dir (the shape a report suspected).
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["lib/router/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await h.call("write", { path: "lib/router/stream-limits.ts", content: "x" }), undefined, "a file directly under dir/** is writable")
  assert.equal(await h.call("read", { path: "lib/router" }), undefined, "the directory itself is in scope")
  const out = await h.call("read", { path: "lib/other.ts" })
  assert.equal(out?.block, true, "a sibling of the granted directory is refused")
  assert.match(out.reason, /"lib\/other\.ts" is outside the read scope/, "the refusal names the full path, not a truncated parent")
  h.restore()
  console.log("  ok   dir/** 覆盖其下文件；拒绝文案给全路径")
}
// 50. scope '.' means the whole repository, not nothing.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], writeScope: [".pi/reports"], maxDenies: 0, maxWriteDenies: 0 },
    }),
  })
  // 仓库根 + 嵌套文件都要能读：`compile` 曾经把 "." 编译成 ^\.$ / ^\./.*$，
  // 而 matches 比的是相对路径（根是空串、文件是 "src/a.ts"），两条都命中不了。
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "a nested file is readable when the scope is the whole tree")
  assert.equal(await h.call("read", { path: "README.md" }), undefined, "a root file is readable when the scope is the whole tree")
  assert.equal(await h.call("grep", { path: "." }), undefined, "a search rooted at the repository root is allowed")
  assert.equal(await h.call("ls", { path: "./" }), undefined, "and so is the same thing spelled with a trailing slash")

  const write = await h.call("write", { path: "src/auth/login.ts", content: "x" })
  assert.equal(write?.block, true, "writeScope still confines writes when the read scope is the whole tree")
  assert.match(write.reason, /readable but not writable/, "the refusal says the read was fine and the write was not")
  assert.equal(await h.call("write", { path: ".pi/reports/r.md", content: "x" }), undefined, "writing inside writeScope still works")
  h.restore()

  // 同一个坑的另一种写法：带 "./" 前缀的条目曾经也一条都不命中。
  const dotted = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["./src/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await dotted.call("read", { path: "src/auth/login.ts" }), undefined, "a scope written './src/**' covers src/**")
  const outside = await dotted.call("read", { path: "docs/x.md" })
  assert.equal(outside?.block, true, "and still confines reads outside it")
  dotted.restore()
  console.log("  ok   范围写 '.' 等于整棵树，'./x' 等于 'x'；写仍受 writeScope 限制")
}

// 50b. 软链是唯一能绕过词法比较的向量：`src/link` 指到树外时，词法上它仍在 `src/` 之下。
//      edit/write 在父进程里跑，没有 Landlock 兜底，所以判定必须看真实路径。
{
  const dir = join(workdir, "symlink-escape")
  const outside = join(workdir, "symlink-outside")   // workdir 之内、但不在 dir 之内
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(dir, "src", "link"))

  const narrow = await handler({ cwd: dir, bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], writeScope: ["src/**"] } }) })
  const writeThrough = await narrow.call("write", { path: "src/link/evil.txt", content: "x" })
  assert.equal(writeThrough?.block, true, "a write through a symlink leaving the scope is refused")
  assert.match(writeThrough.reason, /outside the (read |write )?scope/, "and the reason is the scope, not something else")
  const readThrough = await narrow.call("read", { path: "src/link/evil.txt" })
  assert.equal(readThrough?.block, true, "a read through the same symlink is refused too")
  // 同一棵树内部、指向树内的软链仍然放行：这是正常布局，不该被误伤。
  symlinkSync(join(dir, "src"), join(dir, "src", "self"))
  const inside = await narrow.call("read", { path: "src/self/index.ts" })
  assert.equal(inside, undefined, "a symlink that stays inside the tree still resolves")
  narrow.restore()

  // 整棵树的范围（"." / "**"）也不能把软链出口放进来。
  const whole = await handler({ cwd: dir, bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."] } }) })
  const escaped = await whole.call("write", { path: "src/link/evil2.txt", content: "x" })
  assert.equal(escaped?.block, true, "a whole-tree scope still does not follow a symlink out of the tree")
  whole.restore()
  console.log("  ok   软链指到树外被真实路径判定拦下；树内软链仍放行")
}
// 79. A read-only session can still be granted exactly one file to write.
//     缺陷：`readOnly` 无条件把写范围清空，于是「只读会话 + 一份报告文件」无法表达，review
//     子代理只能把报告塞进回复里（会超）。现在显式 writeScope 优先于 readOnly 的默认空集。
{
  const reportDir = mkdtempSync(join(tmpdir(), "pisw-"))
  const report = join(reportDir, "report.md")
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        readOnly: true,
        writeScope: [report],
        maxDenies: 0,
        maxWriteDenies: 0,
      },
    }),
  })
  assert.equal(await h.call("write", { path: report, content: "x" }), undefined, "the granted report file is writable")
  assert.equal(await h.call("edit", { path: report }), undefined, "and so is editing it")
  const other = await h.call("write", { path: join(reportDir, "other.md"), content: "x" })
  assert.equal(other?.block, true, "a sibling file in the same directory is not")
  const inTree = await h.call("write", { path: join(workdir, "src", "a.ts"), content: "x" })
  assert.equal(inTree?.block, true, "and neither is the task tree — readOnly still means read-only")
  // 报告仍是交付物，不是修改任务树：读、跑只读命令照常。
  assert.equal(await h.call("read", { path: join(workdir, "src", "a.ts") }), undefined, "reads are unaffected")
  h.restore()
  rmSync(reportDir, { recursive: true, force: true })
  console.log("  ok   readOnly + writeScope：只放行点名的那一个文件，任务树仍然只读")
}

// 80. An absolute grant is honoured; a relative one still cannot leave the tree.
//     相对授权绑在项目树上（`matches` 里「落在工作树之外一律不认」是软链逃逸的唯一防线）。
//     绝对路径是父代理点名的，子代理无法自己构造，所以单独放行 —— 但相对写法一条都不能出树。
{
  const outsideDir = mkdtempSync(join(tmpdir(), "pisw2-"))
  const outside = join(outsideDir, "note.md")

  const rel = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  const escaped = await rel.call("write", { path: outside, content: "x" })
  assert.equal(escaped?.block, true, "a relative scope never reaches outside the tree")
  rel.restore()

  const abs = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], writeScope: [outsideDir], maxDenies: 0, maxWriteDenies: 0 },
    }),
  })
  assert.equal(await abs.call("write", { path: outside, content: "x" }), undefined, "an absolute grant is honoured")
  const sibling = await abs.call("write", { path: join(tmpdir(), "elsewhere.md"), content: "x" })
  assert.equal(sibling?.block, true, "but it covers only what it names")
  abs.restore()
  rmSync(outsideDir, { recursive: true, force: true })
  console.log("  ok   绝对写授权按绝对路径放行，相对授权仍然出不了树")
}
// 90. bindings.tools 的两种用法：给自建工具声明类别与路径入参名；把路径入参声明成 false
//     等于「永远拒绝」，因为拿不到目标就没有授权能覆盖它。声明写坏则整份绑定作废。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-decl-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "a\n")

  const declared = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: false,
        tools: { my_edit: { access: "write", path: "file" } },
      },
    }),
  })
  const okWrite = await declared.call("my_edit", { file: "src/a.ts" })
  assert.notEqual(okWrite?.block, true, "a declared tool is judged by its declared path argument")
  const badWrite = await declared.call("my_edit", { file: "../x.ts" })
  assert.equal(badWrite?.block, true, "and outside the scope it is refused")
  declared.restore()

  const noPath = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: false, tools: { replace: { path: false } } },
    }),
  })
  const refused = await noPath.call("replace", { path: "src/a.ts", remove_from: "x", text: "y" })
  assert.equal(refused?.block, true, "a write tool declared without a path argument is always refused")
  assert.match(String(refused?.reason), /no path argument/, "and the message says why")
  noPath.restore()

  const broken = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: false, tools: { replace: { access: "banana" } } },
    }),
  })
  const dead = await broken.call("read", { path: "src/a.ts" })
  assert.equal(dead?.block, true, "a broken declaration refuses everything (fail closed)")
  assert.match(String(dead?.reason), /access must be/, "and says what was wrong")
  broken.restore()
  console.log("  ok   tools 声明：自定义类别与路径入参、path: false 永久拒绝、写坏就整份作废")
}
// 92. 工具名是外部输入，撞上 `__proto__` / `constructor` 这类键时不能把原型链当成声明：
//     否则 `policy.tools["constructor"]` 会读到 Object 的构造器，`{}.access` 虽为 undefined
//     也会让「是否有声明」的判断失真。这里钉住的是「当成未声明」，以及不崩。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-proto-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: false,
        tools: { constructor: { access: "write", path: "file" } },
      },
    }),
  })
  // 声明生效：给了 file 就走写判定（树外 → 拒），而不是「未知工具」或崩溃。
  const declared = await h.call("constructor", { file: "../x.ts" })
  assert.equal(declared?.block, true, "a tool literally named constructor is still judged")
  assert.match(String(declared?.reason), /outside the scope|not writable|tool constructor/, "and not via the prototype chain")
  // 未声明的原型键工具名：按未声明处理（未知工具拒绝），不崩。
  const undeclared = await h.call("__proto__", { path: "src/a.ts" })
  assert.equal(undeclared?.block, true, "__proto__ is not silently treated as a known tool")
  h.restore()
  console.log("  ok   原型键工具名不污染声明表")
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
// 197. A /2 payload is refused and both versions appear in the message.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/2": { scope: ["."] } }) })
  const outcome = await h.call("read", { path: join(workdir, "src", "auth", "x.ts") })
  assert.ok(outcome && outcome.block, "a wrong-version payload is refused")
  assert.match(outcome.reason, /pi-subagents-extend\/1/)
  assert.match(outcome.reason, /pi-subagents-extend\/2/)
  h.restore()
  console.log("  ok   a wrong-version namespace is refused with both versions named")
}

// 198. Two of our namespaces are refused as ambiguous.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."] },
      "pi-subagents-extend/2": { scope: ["."] },
    }),
  })
  const outcome = await h.call("read", { path: join(workdir, "src", "auth", "x.ts") })
  assert.ok(outcome && outcome.block, "two of our namespaces are refused")
  assert.match(outcome.reason, /ambiguous/)
  h.restore()
  console.log("  ok   two versioned namespaces are refused as ambiguous")
}
// 264. The documented dispatch payload puts the policy under `permissions`.
{
  const h = await handler({
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"] } } }),
  })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "the wrapped scope is enforced")
  const outside = await h.call("read", { path: "docs/x.md" })
  assert.equal(outside?.block, true, "files outside the wrapped scope are refused")
  assert.match(outside.reason, /extensionBindings/, "the refusal names the bindings layer")
  h.restore()
  console.log("  ok   a dispatch payload with permissions is accepted and its scope enforced")
}

// 265. A flat payload is another contract, not a shorter spelling of the wrapped one.
{
  const h = await handler({
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }),
  })
  const blocked = await h.call("read", { path: "src/auth/login.ts" })
  assert.equal(blocked?.block, true, "a flat payload grants no scope")
  assert.match(blocked.reason, /permissions/, "the refusal names the missing object")
  assert.ok(
    blocked.reason.includes('"permissions":{"scope":["src/**"]}'),
    `the minimal correct payload is shown inline, got: ${blocked.reason}`,
  )
  assert.doesNotMatch(blocked.reason, /scope is missing/, "the complaint is about the wrapper, not the field")
  h.restore()
  console.log("  ok   a flat dispatch payload is refused with the permissions wrapper shown")
}
// 269. An unknown namespace-level key is refused and the four accepted keys are named.
{
  const h = await handler({
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { permissions: { scope: ["src/**"] }, nonsense: 1 },
    }),
  })
  const blocked = await h.call("read", { path: "src/auth/login.ts" })
  assert.equal(blocked?.block, true, "an unknown namespace key refuses everything")
  assert.match(blocked.reason, /nonsense/, "the offending key is named")
  for (const key of ["permissions", "worktree", "setup", "output"]) {
    assert.ok(blocked.reason.includes(key), `the accepted key "${key}" is named`)
  }
  h.restore()
  console.log("  ok   an unknown namespace key is refused and the four accepted keys are named")
}

// 270. The role-md spelling "write" inside permissions is refused, not silently widened.
{
  const h = await handler({
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { permissions: { scope: ["."], write: { scope: ["."] } } },
    }),
  })
  const blocked = await h.call("write", { path: "a.ts", content: "x" })
  assert.equal(blocked?.block, true, "the role-md write spelling is refused, not treated as a grant")
  assert.match(blocked.reason, /write/, "the offending key is named")
  assert.match(blocked.reason, /writeScope/, "the dispatch spelling is named")
  h.restore()
  console.log("  ok   a role-md write spelling is refused and names the dispatch writeScope")
}

// 271. An unknown key inside permissions is refused by name.
{
  const h = await handler({
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { permissions: { scope: ["."], nonsense: 1 } },
    }),
  })
  const blocked = await h.call("read", { path: "a.ts" })
  assert.equal(blocked?.block, true, "an unknown permissions key refuses everything")
  assert.match(blocked.reason, /nonsense/, "the unknown key is named")
  h.restore()
  console.log("  ok   an unknown key inside permissions is refused by name")
}

// 272. A __proto__ key inside permissions changes nothing: the declared scope still decides.
{
  const h = await handler({
    rawBindings: true,
    bindings: '{"pi-subagents-extend/1":{"permissions":{"scope":["src/**"],"__proto__":{"scope":["**"]}}}}',
  })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "the declared scope still allows its files")
  const outside = await h.call("read", { path: "docs/x.md" })
  assert.equal(outside?.block, true, "the prototype key grants nothing outside the declared scope")
  h.restore()
  console.log("  ok   a __proto__ key inside permissions is inert")
}
// 275. A dispatch-level reset with the documented permissions wrapper narrows a wide session layer.
//      Cases 130-135 put reset in profile files or harness-lifted flat fields, so a reader that
//      accepts reset but ignores it inside a real dispatch payload would go unnoticed. Both halves
//      are asserted: without reset the session's allowances survive, with reset only this
//      dispatch's list remains.
{
  const proj = join(workdir, "proj-dispatch-reset-275")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({
      impl: { scope: ["src/**"], allowTools: ["read", "todo_write"], bash: { allow: ["git show", "git diff"] } },
    }),
  )
  const items = { items: [] }
  const wide = await handler({
    cwd: proj,
    profile: "impl",
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        permissions: { scope: ["."], allowTools: ["read"], bash: { allow: ["git diff"] } },
      },
    }),
  })
  assert.equal(
    await wide.call("bash", { command: "git show" }),
    undefined,
    "without reset the session's bash entry survives the dispatch's own list",
  )
  assert.equal(
    await wide.call("todo_write", items),
    undefined,
    "without reset the session's tool allowance survives too",
  )
  wide.restore()

  const dispatch = JSON.stringify({
    "pi-subagents-extend/1": {
      permissions: { scope: ["."], reset: true, allowTools: ["read"], bash: { allow: ["git diff"] } },
    },
  })
  const narrow = await handler({ cwd: proj, profile: "impl", rawBindings: true, bindings: dispatch })
  const droppedBash = await narrow.call("bash", { command: "git show" })
  assert.equal(droppedBash?.block, true, "reset drops the bash entry the session layer supplied")
  assert.match(String(droppedBash?.reason), /command not in the allowlist/, "the refusal is the allowlist rule")
  const droppedTool = await narrow.call("todo_write", items)
  assert.equal(droppedTool?.block, true, "reset drops the tool the session layer allowed")
  assert.match(String(droppedTool?.reason), /not on the allow list/, "the reader is told which key to change")
  assert.equal(await narrow.call("bash", { command: "git diff" }), undefined, "the dispatch's own entry still runs")
  narrow.restore()
  console.log("  ok   dispatch-level reset narrows both the session bash allowlist and allowTools")
}
rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\npolicy module tests passed")
