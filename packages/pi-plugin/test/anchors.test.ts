// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session.
//
// Resolving the file a write targets: the anchor ownership recorded in the
// hashline sidecar, the two sides of a copy/move, and the explicit `path`
// argument compared after resolution.
//   node test/anchors.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, dirname, basename } from "node:path"
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
// 93. 锚点编辑工具不带路径时，目标从「锚点归属」解析出来再判。归属由宿主扩展记在会话
//     sidecar 里（sessions/<sha256(sessionFile) 前 24 位>.registry.jsonl），这里用真的
//     文件布局去喂它：解析得到的路径必须真的受写范围约束，而不是解析成功就放行。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-anchor-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "inside.ts"), "inside\n")
  mkdirSync(join(tree, "..", `${basename(tree)}-elsewhere`), { recursive: true })

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hldir-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const sidecar = join(hl, "sessions", `${key}.registry.jsonl`)
  const insideAbs = join(tree, "src", "inside.ts")
  const outsideAbs = join(tree, "..", `${basename(tree)}-elsewhere`, "x.ts")
  writeFileSync(
    sidecar,
    [
      JSON.stringify({ kind: "session", sessionFile }),
      JSON.stringify({ kind: "allocate", path: insideAbs, rows: [["aaina", "inside"], ["aainb", "more"]] }),
      JSON.stringify({ kind: "allocate", path: outsideAbs, rows: [["aainc", "elsewhere"]] }),
      "",
    ].join("\n"),
  )

  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: false } }),
  })
  const allowed = await h.call("replace", { remove_from: "aaina", remove_to: "aainb", text: "x" })
  assert.notEqual(allowed?.block, true, "an anchor-only write resolves to its own file and stays allowed")
  const refused = await h.call("replace", { remove_from: "aainc", remove_to: "aainc", text: "x" })
  assert.equal(refused?.block, true, "an anchor owned by a file outside the scope is refused")
  assert.match(String(refused?.reason), /outside the scope|not writable/, "and it is judged by the scope")

  // 释放之后归属没了：不能继续放行，必须退回「拿不到目标」。
  writeFileSync(
    sidecar,
    [
      JSON.stringify({ kind: "session", sessionFile }),
      JSON.stringify({ kind: "allocate", path: insideAbs, rows: [["aaina", "inside"]] }),
      JSON.stringify({ kind: "free", path: insideAbs }),
      "",
    ].join("\n"),
  )
  const freed = await h.call("replace", { remove_from: "aaina", remove_to: "aaina", text: "x" })
  assert.equal(freed?.block, true, "a freed anchor no longer resolves, so the write is refused")
  assert.match(String(freed?.reason), /no target path/, "and the refusal says the target is unknown")

  h.restore()
  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   锚点归属解析：范围内放行、范围外拒绝、释放后拒绝")
}
// 94. 锚点解析不出来的两条硬边界：sidecar 不存在、以及锚点是未知值。两者都必须拒绝，
//     绝不能因为「读不到就不知道」而放行——那是把写范围变成摆设。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-anchor-miss-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hldir-miss-"))
  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = join(hl, "session.jsonl")

  // scope 用整棵树：否则「拿不到目标 → 按 . 判定 → 落在范围外 → 拒绝」会替这条拒绝挡着，
  // 用例就失去了判别力（实测过：把这条拒绝关掉，只有在写范围覆盖根目录时才真的放行）。
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: false } }),
  })
  const noSidecar = await h.call("replace", { remove_from: "zzzzz", text: "x" })
  assert.equal(noSidecar?.block, true, "no sidecar means no target, so the write is refused")
  assert.match(String(noSidecar?.reason), /requirePath/, "and it names the option that avoids the guesswork")

  mkdirSync(join(hl, "sessions"), { recursive: true })
  const key = createHash("sha256").update(String(process.env.PI_SESSION_FILE)).digest("hex").slice(0, 24)
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [JSON.stringify({ kind: "session", sessionFile: String(process.env.PI_SESSION_FILE) }), ""].join("\n"),
  )
  const unknownAnchor = await h.call("replace", { remove_from: "zzzzz", text: "x" })
  assert.equal(unknownAnchor?.block, true, "an unknown anchor is refused rather than allowed")

  h.restore()
  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   锚点解析不到时一律拒绝，绝不因读不到而放行")
}
// 95. copy / move 是双文件工具：`source_*` 属于源文件，`anchor` 属于目标文件。两组锚点必须
//     分别判定 —— 合成一组去查只会拿到先命中的那一侧（源在前），于是目标完全没判，源在写范围
//     内、目标在范围外时会被放行。这类工具在子进程里直接落盘，没有 Landlock 兜底，那就是真的
//     写越界。顺带钉住 copy 与 move 的源权限不同：copy 只读源，move 删源里的行。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-transfer-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  mkdirSync(join(tree, "docs"), { recursive: true })

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-xfer-hl-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const srcAbs = join(tree, "src", "a.ts")
  const docAbs = join(tree, "docs", "b.md")
  const writeSidecar = (rows: Record<string, string>) =>
    writeFileSync(
      join(hl, "sessions", `${key}.registry.jsonl`),
      [
        JSON.stringify({ kind: "session", sessionFile }),
        ...Object.entries(rows).map(([path, anchor]) =>
          JSON.stringify({ kind: "allocate", path, rows: [[anchor, "line"]] }),
        ),
        "",
      ].join("\n"),
    )
  writeSidecar({ [srcAbs]: "srcA", [docAbs]: "docB" })

  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile

  const transferTools = [
    {
      name: "copy",
      parameters: { properties: { anchor: { type: "string" }, source_from: { type: "string" } } },
    },
    {
      name: "move",
      parameters: { properties: { anchor: { type: "string" }, source_from: { type: "string" } } },
    },
  ]
  const transfer = { source_from: "srcA", source_to: "srcA", anchor: "docB", direction: "after" }
  const open = async (bindings: Record<string, unknown>) => {
    const h = await handler({ cwd: tree, piTools: transferTools, bindings: JSON.stringify({ "pi-subagents-extend/1": bindings }) })
    return h
  }

  // 源与目标都在读范围里，写范围只有 docs：copy 只读源 → 放行；move 要删源 → 拒绝并点名源。
  const copyOnly = await open({ scope: ["src/**", "docs/**"], writeScope: ["docs/**"], bash: false })
  const copyAllowed = await copyOnly.call("copy", transfer)
  assert.notEqual(copyAllowed?.block, true, "copy 只读源，源只读时仍应放行")
  const moveRefused = await copyOnly.call("move", transfer)
  assert.equal(moveRefused?.block, true, "move 会删源里的行，源只读时必须拒绝")
  assert.match(String(moveRefused?.reason), /source file/, "拒绝文案点名是源那一侧不行")
  assert.match(String(moveRefused?.reason), /src\/a\.ts/, "并给出源文件路径")
  copyOnly.restore()

  // 源在写范围内、目标在写范围外：这是修复前会放行的那条。必须拒绝，且点名目标。
  const destOutside = await open({ scope: ["src/**", "docs/**"], writeScope: ["src/**"], bash: false })
  for (const tool of ["copy", "move"]) {
    const refused = await destOutside.call(tool, transfer)
    assert.equal(refused?.block, true, `${tool} 不能把内容写到写范围之外`)
    assert.match(String(refused?.reason), /docs\/b\.md/, `${tool} 的拒绝文案点名目标文件`)
    assert.doesNotMatch(String(refused?.reason), /neither readable nor writable/, `${tool} 不再把源当成写目标去判`)
  }
  destOutside.restore()

  // 两侧都可写：都放行（否则上面两条可以靠「一律拒绝」骗过去）。
  const bothWritable = await open({ scope: ["src/**", "docs/**"], writeScope: ["src/**", "docs/**"], bash: false })
  for (const tool of ["copy", "move"]) {
    const allowed = await bothWritable.call(tool, transfer)
    assert.notEqual(allowed?.block, true, `${tool} 两侧都可写时放行`)
  }
  // 声明覆盖：把 copy 的源改成按写判，源只读时就要拒。
  bothWritable.restore()
  const override = await open({
    scope: ["src/**", "docs/**"],
    writeScope: ["docs/**"],
    bash: false,
    tools: { copy: { transferSource: "write" } },
  })
  const overridden = await override.call("copy", transfer)
  assert.equal(overridden?.block, true, "transferSource: write 让 copy 的源也只读不了")
  assert.match(String(overridden?.reason), /source file/, "并且文案仍然点名源")
  override.restore()

  // 目标锚点查不到归属：两侧都得知道才能判，所以一律拒绝，绝不因为缺一侧就只判另一侧。
  writeSidecar({ [srcAbs]: "srcA" })
  const halfKnown = await open({ scope: ["src/**", "docs/**"], writeScope: ["docs/**"], bash: false })
  const halfRefused = await halfKnown.call("copy", transfer)
  assert.equal(halfRefused?.block, true, "目标锚点解析不到时拒绝")
  assert.match(String(halfRefused?.reason), /destination anchors/, "并说明缺的是目标那一侧")
  halfKnown.restore()

  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   copy/move 的源与目标分别判定：源只读时 copy 放行、move 拒绝，写越界被挡")
}
// 96. replace_match 的锚点叫 replace_from / replace_to（宿主 schema 就是这两个名字），
//     不带 path 时同样必须能解析出目标 —— 漏了这一对，等于在目标宿主上把「改一行的一部分」
//     这个动作整个废掉，而拒绝文案还会让模型去「显式传 path」，它做不到。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-rmatch-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "inside.ts"), "inside\n")
  const elsewhere = join(tree, "..", `${basename(tree)}-elsewhere`)
  mkdirSync(elsewhere, { recursive: true })

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hldir-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const insideAbs = join(tree, "src", "inside.ts")
  const outsideAbs = join(elsewhere, "x.ts")
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [
      JSON.stringify({ kind: "session", sessionFile }),
      JSON.stringify({ kind: "allocate", path: insideAbs, rows: [["aamaa", "inside"], ["aamab", "more"]] }),
      JSON.stringify({ kind: "allocate", path: outsideAbs, rows: [["aamac", "elsewhere"]] }),
      "",
    ].join("\n"),
  )

  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: false } }),
  })
  const payload = (from: string, to: string) => ({
    replace_from: from,
    replace_to: to,
    match: "ins",
    replacement: "INS",
  })

  const allowed = await h.call("replace_match", payload("aamaa", "aamab"))
  assert.notEqual(
    allowed?.block,
    true,
    "replace_match 只给 replace_from/replace_to 时也要解析出目标并放行",
  )
  const refused = await h.call("replace_match", payload("aamac", "aamac"))
  assert.equal(refused?.block, true, "锚点属于写范围外的文件时必须拒绝")
  assert.match(String(refused?.reason), /outside the scope|not writable/, "并且是按写范围判的")
  // 显式给 path 时照旧判 path：这条不是新行为，只是别在改 ANCHOR_ARGS 时弄坏。
  const withPath = await h.call("replace_match", { ...payload("aamaa", "aamab"), path: insideAbs })
  assert.notEqual(withPath?.block, true, "带 path 的 replace_match 仍然放行")

  h.restore()
  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   replace_match 的锚点入参：只给 replace_from/replace_to 也能判，越界照样拒绝")
}
// 97. 锚点分属两个文件时拒绝：拿不到唯一目标就不判，也不猜宿主会写哪一个。
//     主场景用规范名（remove_from 指 A 文件、remove_to 指 B 文件）—— 这种入参能真正递到本层，
//     宿主自己的 resolveEditTarget 也以 `paths.size > 1` 拒绝它（E_BAD_SHAPE）。
//     附带场景是两种拼写并存：宿主在 prepareArguments 里就把别名删掉了，pi 的 tool_call 钩子
//     拿到的是归一化后的入参，所以那种形状到不了这里 —— 留着只是把同一条规则多钉一次。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-mixed-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "inside.ts"), "inside\n")
  const elsewhere = join(tree, "..", `${basename(tree)}-elsewhere`)
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, "out.ts"), "out\n")

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hldir-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const insideAbs = join(tree, "src", "inside.ts")
  const outsideAbs = join(elsewhere, "out.ts")
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [
      JSON.stringify({ kind: "session", sessionFile }),
      JSON.stringify({ kind: "allocate", path: insideAbs, rows: [["aanaa", "inside"], ["aanab", "more"]] }),
      JSON.stringify({ kind: "allocate", path: outsideAbs, rows: [["aanac", "out"]] }),
      "",
    ].join("\n"),
  )
  // src 可读可写，树外那个只可读不可写：判对了就必须拒绝，判错了（判到 inside）会放行。
  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: false } }),
  })

  // 同一份文件的两种拼写：一致，放行（否则这条靠「一律拒绝」也能过）。
  const agree = await h.call("replace", { remove_from: "aanaa", remove_to: "aanab", text: "x" })
  assert.notEqual(agree?.block, true, "同一份文件的锚点照旧放行")

  // 主场景：两个规范名锚点分属两个文件（一个在写范围内、一个在树外）。这种入参能真正递到
  // 本层（没有别名参与，prepareArguments 不会动它）。目标不唯一 → 拒绝，不去挑先命中的那个。
  const split = await h.call("replace", { remove_from: "aanaa", remove_to: "aanac", text: "x" })
  assert.equal(split?.block, true, "两个锚点分属不同文件时拒绝，不挑一个算数")
  assert.match(String(split?.reason), /different files/, "文案点明锚点分属两个文件")
  assert.match(String(split?.reason), /split this into one call per file/, "并给出唯一出路：拆成两次调用")
  // 附带场景：两种拼写并存、各指一处。这种形状到不了真实管线（宿主在 prepareArguments 里
  // 就把别名删了，pi 的钩子收到的是归一化后的入参），这里只是把同一条规则再钉一次。
  const mixed = await h.call("replace_match", {
    replace_from: "aanac",
    replace_to: "aanac",
    remove_from: "aanaa",
    remove_to: "aanab",
    match: "out",
    replacement: "OUT",
  })
  assert.equal(mixed?.block, true, "锚点分别属于两个文件时拒绝，不猜宿主会写哪一个")

  h.restore()
  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   锚点跨两个文件时拒绝：别名与规范名并存也不猜")
}
// 98. copy / move 显式给的 `path` 必须按**解析后的绝对路径**和锚点归属比对。
//     注册表里存的是 toCwd 之后的绝对路径，宿主也是把 providedPath resolve 到 cwd 再比
//     （fs-write.ts 的 resolveInCwd → toCwd）。早先拿原始字符串直比，任何相对写法都对不上，
//     于是把宿主本来会执行的调用一律拒掉 —— 而相对写法正是模型最常给的形式。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-relpath-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  mkdirSync(join(tree, "docs"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "alpha\n")
  writeFileSync(join(tree, "docs", "b.md"), "beta\n")

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hldir-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const sourceAbs = join(tree, "src", "a.ts")
  const destAbs = join(tree, "docs", "b.md")
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [
      JSON.stringify({ kind: "session", sessionFile }),
      JSON.stringify({ kind: "allocate", path: sourceAbs, rows: [["relaa", "alpha"], ["relab", "more"]] }),
      JSON.stringify({ kind: "allocate", path: destAbs, rows: [["relac", "beta"]] }),
      "",
    ].join("\n"),
  )
  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile
  const tools = [
    { name: "copy", parameters: { properties: { path: { type: "string" }, anchor: { type: "string" } } } },
    { name: "move", parameters: { properties: { path: { type: "string" }, anchor: { type: "string" } } } },
  ]
  const h = await handler({
    cwd: tree,
    piTools: tools,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**", "docs/**"], writeScope: ["src/**", "docs/**"], bash: false } }),
  })
  const payload = { source_from: "relaa", source_to: "relaa", anchor: "relac", direction: "after" }

  // 相对写法指向目标侧：修复前因 `"docs/b.md" !== "/abs/docs/b.md"` 被拒，宿主却会照做。
  const relDest = await h.call("copy", { ...payload, path: "docs/b.md" })
  assert.notEqual(relDest?.block, true, "相对 path 指向目标文件时放行（按解析后的绝对路径比）")
  // 带 ./ 前缀同样算同一个文件。
  const dotted = await h.call("copy", { ...payload, path: "./docs/b.md" })
  assert.notEqual(dotted?.block, true, "./ 前缀不影响判定")
  // 指向源侧也放行（宿主允许 path 指任一侧）。
  const relSource = await h.call("move", { ...payload, path: "src/a.ts" })
  assert.notEqual(relSource?.block, true, "相对 path 指向源文件时同样放行")
  // 指到第三处：仍然要拒，且说清对不上两侧 —— 否则「一律放行」也能过上面三条。
  const stray = await h.call("copy", { ...payload, path: "docs/other.md" })
  assert.equal(stray?.block, true, "path 既不是源也不是目标时拒绝")
  assert.match(String(stray?.reason), /matches neither file/, "文案说明对不上两侧的哪一侧")

  h.restore()
  if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
  else process.env.PI_HASHLINE_DIR = previous.dir
  if (previous.session === undefined) delete process.env.PI_SESSION_FILE
  else process.env.PI_SESSION_FILE = previous.session
  console.log("  ok   copy/move 的显式 path 按解析后的绝对路径比对")
}
rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\nanchors module tests passed")
