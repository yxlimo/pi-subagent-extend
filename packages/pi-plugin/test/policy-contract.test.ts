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
// 5. Malformed bindings fail closed with a diagnosable reason.
{
  const h = await handler({ bindings: "{not json" })
  const read = await h.call("read", { path: "src/a.ts" })
  assert.equal(read?.block, true, "malformed bindings deny reads")
  assert.match(read.reason, /not valid JSON/, "block reason names the parse error")
  h.restore()
  console.log("  ok   bindings 损坏时 fail closed 并说明原因")
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
