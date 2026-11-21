// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session.
//
// The path candidates a bash command yields, and the working-tree check that
// refuses a read-class command pointing outside the tree.
//   node test/bash-paths.test.ts

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
// pathCandidates 的纯抽取用例（101–107、115）与接线用例（108–114）共用这一个导入。
const bashMatch = (await import(join(repo, "src", "bash-match.ts"))) as unknown as {
  pathCandidates?: (command: string) => string[]
}

function pathCandidates(command: string): string[] {
  assert.equal(typeof bashMatch.pathCandidates, "function", "src/bash-match.ts must export pathCandidates")
  return (bashMatch.pathCandidates as (command: string) => string[])(command)
}


// 101. 绝对路径候选：选项与引号里的碎片不是路径。
{
  assert.deepEqual(
    pathCandidates("rg -a -o 'x' /nix/store/anything"),
    ["/nix/store/anything"],
    "only the absolute path is a candidate: flags and the quoted fragment are not paths",
  )
  console.log("  ok   pathCandidates extracts the absolute path candidate only")
}

// 102. 相对路径也是候选：只认绝对路径的话，最常见的 `rg foo src/index.ts` 写法就漏了。
{
  assert.deepEqual(pathCandidates("rg foo src/index.ts"), ["src/index.ts"], "a relative path is a candidate too")
  console.log("  ok   pathCandidates extracts relative path candidates")
}

// 103. 代码片段不是路径：引号与括号一律跳过 —— 宁可漏放，不许误拒。
{
  assert.deepEqual(
    pathCandidates(`node -e 'require("/nix/store/x")'`),
    [],
    "a quoted code fragment yields no candidate",
  )
  console.log("  ok   pathCandidates skips quoted code fragments")
}

// 104. 动态拼接不是路径：`$DIR` 这类 token 跳过，同一条命令里的静态路径留着。
{
  assert.deepEqual(pathCandidates("rg $DIR /home/x"), ["/home/x"], "a variable reference is skipped, the static path stays")
  console.log("  ok   pathCandidates skips dynamic references")
}

// 105. URL 不是路径：含 `:` 的 token 跳过，否则 `rg foo https://…` 会被当成树外路径而误拒。
{
  assert.deepEqual(pathCandidates("rg foo https://example.com/a"), [], "a URL yields no candidate")
  console.log("  ok   pathCandidates skips URLs")
}

// 106. 引号旁边的路径仍要抽出来：引号只影响切词，不影响路径本身。
{
  const candidates = pathCandidates("rg 'foo bar' ./src/a.ts")
  assert.ok(candidates.includes("./src/a.ts"), "the path next to the quoted fragment is extracted")
  assert.ok(
    candidates.every((candidate) => !candidate.includes("'")),
    `quoted fragments are not candidates, got: ${candidates.join(", ")}`,
  )
  console.log("  ok   pathCandidates extracts the path next to a quoted fragment")
}

// 107. 候选最多 32 个：参数可以很长，全量收集会让判定成本随参数个数漂移。
{
  const many = Array.from({ length: 40 }, (_, index) => `/tmp/p${index}`)
  const candidates = pathCandidates(`rg x ${many.join(" ")}`)
  assert.equal(candidates.length, 32, "at most 32 candidates")
  assert.deepEqual(candidates, many.slice(0, 32), "the first 32 candidates, in order")
  console.log("  ok   pathCandidates caps the candidate list at 32")
}

// 108. 只读类 bash 指向树外绝对路径要拒：文案点名路径、说清撞的是工作树，
//      并且说这是提醒不是墙 —— 模型要知道自己该改路径，而不是以为整条命令被禁。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const outside = "/home/other-notes"
  const denied = await h.call("bash", { command: `rg foo ${outside}` })
  assert.equal(denied?.block, true, "a read-class command pointing outside the tree is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.match(denied.reason, /path nudge, not a wall/, "the refusal says it is a nudge, not a wall")
  assert.ok(denied.reason.includes(outside), `the refusal names the path verbatim, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   read-class bash outside the tree is refused with a nudge message")
}

// 109. 树内路径照旧放行：这条是正控，防止「一律拒绝」也能过上一条。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] } },
    }),
    cwd: workdir,
  })
  const inside = join(workdir, "src", "auth", "notes.txt")
  writeFileSync(inside, "x\n")
  assert.equal(await h.call("bash", { command: "rg foo src/auth/notes.txt" }), undefined, "a relative in-tree path passes")
  assert.equal(await h.call("bash", { command: `rg foo ${inside}` }), undefined, "an absolute in-tree path passes")
  h.restore()
  console.log("  ok   read-class bash inside the tree still passes")
}

// 110. 工具链目录不再是豁免集：`/nix/store` 作为参数指向树外，要拒。
//      豁免集收窄成设备与系统信息（/etc、/proc、/dev、/sys）之后，工具链目录回到了「树外」这一侧。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const denied = await h.call("bash", { command: "rg foo /nix/store/anything" })
  assert.equal(denied?.block, true, "a toolchain path passed as an argument is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.ok(denied.reason.includes("/nix/store/anything"), `the refusal names the offending argument, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   工具链目录不再豁免：作为参数的 /nix/store 路径被拒")
}

// 111. 引号里的代码片段不误拒：跳过规则生效时，`node -e 'require("/home/other/x")'` 照旧放行。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["node"] } },
    }),
    cwd: workdir,
  })
  assert.equal(
    await h.call("bash", { command: `node -e 'require("/home/other/x")'` }),
    undefined,
    "a path quoted inside code is not a candidate, so the command passes",
  )
  h.restore()
  console.log("  ok   quoted code fragments do not trigger the working-tree path check")
}

// 112. 写类命令不受这条检查影响：写类命令撞的是写范围，这条检查管的是工作树。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"] } },
    }),
    cwd: workdir,
  })
  const input = { command: "pnpm test /home/other-notes" }
  assert.equal(await h.call("bash", input), undefined, "a write-class command keeps working")
  assert.ok(input.command.includes("pnpm test /home/other-notes"), "the command payload is preserved")
  h.restore()
  console.log("  ok   write-class bash is not subject to the working-tree path check")
}

// 113. 裸相对路径带斜杠、解析后落在树外：必须拒。
//      斜杠是「路径」与「裸词/包名」在文本上唯一稳定的分界，所以 `escape-link/x` 这种
//      相对写法也是候选：cwd 下有 escape-link -> 树外目录时，它能读到树外（真实逃逸形态）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  // 指向树外目录的软链：它在 cwd 之下，解析后却在树外。
  const link = join(workdir, "escape-link")
  symlinkSync(dirname(repo), link)
  const denied = await h.call("bash", { command: "rg foo escape-link/x" })
  assert.equal(denied?.block, true, "a relative path with a slash that resolves outside the tree is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.match(denied.reason, /path nudge, not a wall/, "the refusal says it is a nudge, not a wall")
  assert.ok(denied.reason.includes("escape-link/x"), `the refusal names the offending argument, got: ${denied.reason}`)
  // 另一条逃逸形态：`..` 抬出 cwd。
  const up = await h.call("bash", { command: "rg foo ../outside/x" })
  assert.equal(up?.block, true, "a relative path that climbs out of the tree is refused")
  h.restore()
  rmSync(link, { force: true })
  console.log("  ok   relative paths with a slash that resolve outside the tree are refused")
}

// 114. 正向控制：树内的相对路径（带斜杠）照旧放行 —— 上一条的对照组。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] } },
    }),
    cwd: workdir,
  })
  mkdirSync(join(workdir, "src", "nested"), { recursive: true })
  writeFileSync(join(workdir, "src", "nested", "a.ts"), "x\n")
  assert.equal(
    await h.call("bash", { command: "rg foo src/nested/a.ts" }),
    undefined,
    "an in-tree relative path with a slash passes",
  )
  h.restore()
  console.log("  ok   in-tree relative paths with a slash still pass")
}

// 115. 没有斜杠的裸词不是路径候选：`foo`、`pattern` 不收；包名（`@scope`、`@scope/pkg`）也不收 ——
//      全收只是噪声，还会把 32 个候选的额度挤掉。
{
  assert.deepEqual(pathCandidates("rg foo"), [], "a bare word is not a candidate")
  assert.deepEqual(pathCandidates("rg pattern"), [], "a search pattern is not a candidate")
  assert.deepEqual(pathCandidates("rg @scope"), [], "a package scope without a slash is not a candidate")
  assert.deepEqual(pathCandidates("rg @scope/pkg"), [], "a package spec is not a candidate")
  console.log("  ok   pathCandidates skips words without a slash")
}

// 116. PR 的动机案例：参数指向工具链包体必须拒。
//      实测有一个子代理在 258MB 的包体里 rg 了 140 次，全部为空 —— 那些路径参数每次都指向
//      工具链而不是任务。工具链不再是豁免集的一员，这类参数要回到工作树这一侧。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  const denied = await h.call("bash", { command: "rg -a -o 'x' /nix/store/anything" })
  assert.equal(denied?.block, true, "a read-class command pointing into the toolchain store is refused")
  assert.match(denied.reason, /is outside the working tree/, "the refusal names the working tree")
  assert.doesNotMatch(denied.reason, /read scope/, "the refusal no longer talks about the read scope")
  assert.ok(denied.reason.includes("/nix/store/anything"), `the refusal names the offending argument, got: ${denied.reason}`)
  h.restore()
  console.log("  ok   /nix/store 作为参数被拒（PR 的动机案例）")
}

// 117. 程序位豁免：程序本身写成绝对路径时不算参数候选。
//      可执行文件由 bash 经 PATH 解析，本来就不进参数表；把程序写成绝对路径时，那是在执行
//      工具，不是在工具链目录里翻东西。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["re:/nix/store/[^ ]+/bin/rg .+"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates("/nix/store/abc/bin/rg foo"), [], "the program position is not a path candidate")
  assert.equal(
    await h.call("bash", { command: "/nix/store/abc/bin/rg foo" }),
    undefined,
    "a command whose program is an absolute path passes",
  )
  h.restore()
  console.log("  ok   程序位是绝对路径时不算候选，放行")
}

// 118. 判据是工作树，不是读范围：范围比树窄时，树内范围外的路径照旧放行。
//      这与 read 工具不同（read 按范围拒，范围外读不到），差异是有意的：构建要读整棵树，
//      按范围收窄会让一条本来能跑的构建命令死在插件层。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] }, maxDenies: 0 },
    }),
    cwd: workdir,
  })
  mkdirSync(join(workdir, "docs"), { recursive: true })
  writeFileSync(join(workdir, "docs", "x.md"), "x\n")
  const read = await h.call("read", { path: "docs/x.md" })
  assert.equal(read?.block, true, "the read tool still refuses a path outside the scope")
  assert.equal(
    await h.call("bash", { command: "rg foo docs/x.md" }),
    undefined,
    "a read-class command may name an in-tree path outside the scope",
  )
  h.restore()
  console.log("  ok   判据是工作树：树内但范围外的路径对 bash 放行")
}

// 119. 设备与系统信息仍豁免：`/etc` 下的路径不是任务文件，是系统状态，放行。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["sed"] } },
    }),
    cwd: workdir,
  })
  assert.equal(
    await h.call("bash", { command: "sed -n '1,5p' /etc/hosts" }),
    undefined,
    "a system information path stays exempt",
  )
  h.restore()
  console.log("  ok   设备与系统信息目录（/etc 等）仍豁免")
}

// 120. 引号包住整个路径时整 token 跳过：已知漏放，钉住现状。
//      抽取按 token 走，引号进了 token 就整个不算路径 —— 里面是什么内容不再判断。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates('rg foo "/home/other/x"'), [], "a quoted whole token is not a candidate")
  assert.equal(
    await h.call("bash", { command: 'rg foo "/home/other/x"' }),
    undefined,
    "a path wrapped in quotes passes",
  )
  h.restore()
  console.log("  ok   引号包住的整 token 被跳过（已知漏放）")
}

// 121. `~user` 不展开：只有 `~/` 会展开，`~root/...` 被当成树内相对路径 —— 已知缺口，钉住现状。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["rg"] } },
    }),
    cwd: workdir,
  })
  assert.deepEqual(pathCandidates("rg foo ~root/.ssh/id_rsa"), ["~root/.ssh/id_rsa"], "the token is a candidate")
  assert.equal(
    await h.call("bash", { command: "rg foo ~root/.ssh/id_rsa" }),
    undefined,
    "a ~user path is not expanded and resolves inside the tree",
  )
  h.restore()
  console.log("  ok   `~user` 不展开（已知缺口）")
}
rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\nbash path tests passed")
