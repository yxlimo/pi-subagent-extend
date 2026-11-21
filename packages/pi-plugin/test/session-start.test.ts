// Session start: role-md policy resolution, worktree defaults, role wiring and /permission output.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import type {
  EventHandler,
  FakeExtensionApi,
  PromptOptions,
  Outcome,
  SessionContext,
} from "./types.ts"
import { handler, specOf, ext, workdir, repo, writeAgentMd, childSystemPrompt } from "./harness.ts"

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
// 170. 角色 md 的 extend.worktree.enabled: true 给 subagent 派单补默认值；补值不是拒绝。
{
  const proj = join(workdir, "proj-worktree-default")
  writeAgentMd({
    cwd: proj,
    role: "coder",
    extend: {
      permissions: { scope: ["."], allowTools: ["subagent", "subagent_launch", "read"] },
      worktree: { enabled: true },
    },
  })
  // 172 复用这个角色：没有 worktree 配置的 md 不得长出 worktree 键。
  writeAgentMd({ cwd: proj, role: "plain", extend: { permissions: { scope: ["."], allowTools: ["subagent"] } } })
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "filling the default is not a refusal")
  assert.equal(input.worktree, true)
  h.restore()
  console.log("  ok   a role md's worktree default fills a subagent dispatch")
}

// 171. 调用方显式 false 是「我要共享工作树」，不能被角色 md 默认值盖掉。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x", worktree: false }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, false, "an explicit false survives the role md default")
  h.restore()
  console.log("  ok   explicit worktree: false wins over the role default")
}

// 172. md 没有 worktree 字段时不能凭空长出这个键。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "plain", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "no worktree key appears without a strategy")
  h.restore()
  console.log("  ok   no worktree field leaves the input untouched")
}

// 173. 工作流里的 subagent_launch 也要补：tasks[] / chain 的子代理不能漏。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { workflowRunId: "run-1", key: "k", agent: "coder", task: "x" }
  assert.equal(await h.call("subagent_launch", input), undefined)
  assert.equal(input.worktree, true, "the nested launch gets the same default")
  h.restore()
  console.log("  ok   nested subagent_launch gets the role md's worktree default")
}

// 174. 非派单工具不补，即使入参里也带了个 agent 字段。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { path: "src/x.ts", agent: "coder" }
  assert.equal(await h.call("read", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "only dispatch tools are touched")
  h.restore()
  console.log("  ok   non-dispatch tools are left alone")
}

// 175. 角色解析不到就 fail open，不拿别的角色的策略来补。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "ghost-role-175", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "an unknown agent has no strategy")
  h.restore()
  console.log("  ok   an unresolvable agent gets no default")
}

// 176. ??= 把 null 也算「没给」：显式 false 才有优先权。
{
  const proj = join(workdir, "proj-worktree-default")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x", worktree: null }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "null is absent under ??=")
  h.restore()
  console.log("  ok   a null worktree is filled like a missing one")
}

// 177. 没有角色 md 时，本次 bindings 自己写了 worktree 也照样生效。
{
  const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-worktree-call-"))
  const h = await handler({
    cwd: empty,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], worktree: true, allowTools: ["subagent"] },
    }),
  })
  const input: Record<string, unknown> = { agent: "ghost", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the call's own bindings carry the strategy")
  h.restore()
  rmSync(empty, { recursive: true, force: true })
  console.log("  ok   call-level worktree applies without a role md")
}


// 170-182. worktree 补值的护栏（review P1）与派单自带 worktree 覆盖（P2）。
const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
const worktreeProj = (name: string, role: string, extend: Record<string, unknown>, tracked: "tracked" | "untracked" | "none"): string => {
  const proj = join(workdir, name)
  writeAgentMd({ cwd: proj, role, extend })
  if (tracked !== "none") spawnSync("git", ["init", "-q"], { cwd: proj, stdio: "ignore" })
  if (tracked === "tracked") spawnSync("git", ["add", join(".pi", "agents", `${role}.md`)], { cwd: proj, stdio: "ignore" })
  return proj
}
const extendWorktree = { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: true } }
const extendPlain = { permissions: { scope: ["."], allowTools: ["subagent"] } }

// 178. 未跟踪的角色 md：补值时告警一次，第二次派单不再重复。
//      未跟踪的 md 在 worktree 副本里不存在，子代理认不出角色，等于没有任何角色策略。
if (!gitAvailable) {
  console.log("  skip  untracked role md warning（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-untracked", "coder", extendWorktree, "untracked")
  const h = await handler({ cwd: proj })
  const first: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", first), undefined)
  assert.equal(first.worktree, true, "the default is still filled")
  const warns = h.ui.filter((m) => m.includes("not tracked by git"))
  assert.equal(warns.length, 1, "one warning for the untracked role md")
  assert.match(warns[0], /worktree: true/, "the warning explains that worktree: true uses a copy")
  assert.match(warns[0], /\.pi\/agents\/coder\.md/, "the warning names the role md")
  assert.match(warns[0], /no role policy/, "the warning says the child runs with no role policy")
  assert.match(warns[0], /Commit the role md/, "the warning says to commit it")
  const second: Record<string, unknown> = { agent: "coder", task: "y" }
  assert.equal(await h.call("subagent", second), undefined)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 1, "still one warning")
  h.restore()
  console.log("  ok   an untracked role md warns once, with why and how")
}

// 179. 已跟踪的角色 md 不告警。
if (!gitAvailable) {
  console.log("  skip  tracked role md stays silent（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-tracked", "coder", extendWorktree, "tracked")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "a tracked role md is silent")
  h.restore()
  console.log("  ok   a tracked role md stays silent")
}

// 180. 判定不了（不在 git 仓库里）时不告警：宁可少说，不许误报。
{
  const proj = worktreeProj("proj-wt-norepo", "coder", extendWorktree, "none")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true)
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "an undecidable check stays silent")
  h.restore()
  console.log("  ok   an undecidable git-tracking check warns nothing")
}

// 181. 派单自带 worktree: false 覆盖 md 的 true：不补值。
{
  const proj = worktreeProj("proj-wt-false", "coder", extendWorktree, "none")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = {
    agent: "coder",
    task: "x",
    extensionBindings: { "pi-subagents-extend/1": { worktree: false } },
  }
  assert.equal(await h.call("subagent", input), undefined)
  assert.ok(!Object.hasOwn(input, "worktree"), "the dispatch's false suppresses the role md default")
  h.restore()
  console.log("  ok   a dispatch's worktree: false overrides the role md default")
}

// 182. 派单自带 worktree: true 而 md 没有该字段：补值；来源是派单，不告警。
if (!gitAvailable) {
  console.log("  skip  dispatch worktree participates（环境里没有 git）")
} else {
  const proj = worktreeProj("proj-wt-own-true", "plain", extendPlain, "untracked")
  const h = await handler({ cwd: proj })
  const input: Record<string, unknown> = {
    agent: "plain",
    task: "x",
    extensionBindings: { "pi-subagents-extend/1": { worktree: true } },
  }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the dispatch's own worktree participates in the decision")
  assert.equal(h.ui.filter((m) => m.includes("not tracked by git")).length, 0, "a dispatch-sourced strategy warns about no file")
  h.restore()
  console.log("  ok   a dispatch's own worktree: true fills in, with no role-md warning")
}

// 183-200. Role config source and versioned namespace (phase 1).
const rc = (await import(join(repo, "src", "role-config.ts"))) as unknown as typeof import("../src/role-config.ts")

// 183. The active_agent tag gives the role wherever it stands alone on a line.
{
  assert.equal(rc.parseRoleName('<active_agent name="coder"/>\nyou are a helpful assistant'), "coder")
  assert.equal(rc.parseRoleName('rewritten prompt\n\n<active_agent name="coder"/>\n\nsystem prompt'), "coder", "the bridge puts the tag after the rewritten prompt")
  console.log("  ok   parseRoleName reads the role from any line that is only the tag")
}

// 184. No tag, a tag quoted inside another line, or an empty name is no role.
{
  assert.equal(rc.parseRoleName("a prompt with no tag"), null)
  assert.equal(rc.parseRoleName('first line\ncontext: <active_agent name="coder"/>'), null, "a tag inside another line is not the role")
  assert.equal(rc.parseRoleName('<active_agent name=""/>'), null, "an empty name is no role")
  console.log("  ok   parseRoleName returns null when the tag is absent, quoted or empty")
}

// 185. Whitespace around the tag is tolerated.
{
  assert.equal(rc.parseRoleName('  <active_agent   name="coder"  />  \nnext'), "coder")
  console.log("  ok   parseRoleName tolerates surrounding whitespace")
}

// 186. XML-escaped role names are decoded.
{
  assert.equal(rc.parseRoleName('<active_agent name="a&amp;b&quot;c"/>'), 'a&b"c')
  assert.equal(rc.parseRoleName('<active_agent name="coder&#45;x"/>'), "coder-x")
  console.log("  ok   parseRoleName decodes escaped role names")
}

// 187. Agent md resolution walks project levels before user levels.
{
  const proj = join(workdir, "resolve-proj")
  const home = join(workdir, "resolve-home")
  const files = [
    join(proj, ".pi", "agents", "worker.md"),
    join(proj, ".agents", "worker.md"),
    join(home, ".pi", "agent", "agents", "worker.md"),
    join(home, ".agents", "worker.md"),
  ]
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, file)
  }
  for (let i = 0; i < files.length; i += 1) {
    assert.equal(rc.resolveAgentFile("worker", proj, home), files[i])
    rmSync(files[i])
  }
  assert.equal(rc.resolveAgentFile("worker", proj, home), null, "no file means no role")
  console.log("  ok   agent md resolution follows the project-then-user order")
}

// 188. readExtendBlock returns the extend object from valid frontmatter.
{
  const file = join(workdir, "md-valid.md")
  writeFileSync(file, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# body\n')
  const out = rc.readExtendBlock(file)
  assert.deepEqual(out.problems, [])
  assert.deepEqual(out.block, { permissions: { scope: ["src/**"] } })
  console.log("  ok   readExtendBlock returns the extend object")
}

// 189. No frontmatter is not a problem.
{
  const file = join(workdir, "md-no-front.md")
  writeFileSync(file, "# just a heading\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.deepEqual(out.problems, [])
  console.log("  ok   no frontmatter yields no block and no problem")
}

// 190. Frontmatter without extend is not a problem.
{
  const file = join(workdir, "md-no-extend.md")
  writeFileSync(file, "---\ntitle: hello\n---\nbody\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.deepEqual(out.problems, [])
  console.log("  ok   frontmatter without extend yields no problem")
}

// 191. Invalid YAML reports a problem instead of throwing.
{
  const file = join(workdir, "md-bad-yaml.md")
  writeFileSync(file, "---\nextend: [unterminated\n---\n")
  const out = rc.readExtendBlock(file)
  assert.equal(out.block, undefined)
  assert.equal(out.problems.length, 1)
  assert.match(out.problems[0], /invalid YAML/)
  console.log("  ok   invalid YAML yields one problem, not a throw")
}

// 192. permissions map onto the existing policy fields.
{
  const out = rc.policyFromBlock({
    permissions: {
      scope: ["src/**"],
      write: ["src/gen/**"],
      readOnly: true,
      allowTools: ["subagent"],
      budgets: { deny: 7, writeDeny: 3 },
    },
  })
  assert.deepEqual(out.problems, [])
  assert.deepEqual(out.policy, {
    scope: ["src/**"],
    writeScope: ["src/gen/**"],
    readOnly: true,
    allowTools: ["subagent"],
    maxDenies: 7,
    maxWriteDenies: 3,
  })
  console.log("  ok   permissions map onto scope, write, budgets and the rest")
}

// 193. permissions.bash is reported, not silently dropped.
{
  const out = rc.policyFromBlock({ permissions: { scope: ["."], bash: { read: ["git status"] } } })
  assert.ok(out.problems.some((p) => p.includes("the legacy read/write spelling belongs to bindings")))
  assert.deepEqual(out.policy?.scope, ["."], "the other fields still convert")
  console.log("  ok   permissions.bash reports the legacy spelling and points to bindings")
}

// 194. Wired top-level blocks are no longer reported; unknown ones still are.
{
  const out = rc.policyFromBlock({ worktree: {}, setup: {}, output: {} })
  assert.deepEqual(out.problems, [])
  console.log("  ok   wired blocks are silent")
}

// 195. Unknown keys are reported by name.
{
  const inPermissions = rc.policyFromBlock({ permissions: { scope: ["."], mystery: 1 } })
  assert.ok(inPermissions.problems.some((p) => p.includes("mystery")))
  const topLevel = rc.policyFromBlock({ spooky: {} })
  assert.ok(topLevel.problems.some((p) => p.includes("spooky")))
  console.log("  ok   unknown keys are reported by name")
}

// 196. A mistyped scope is reported and omitted, other fields survive.
{
  const out = rc.policyFromBlock({ permissions: { scope: "src/**", readOnly: true } })
  assert.ok(out.problems.some((p) => p.includes("permissions.scope")))
  assert.equal(out.policy?.scope, undefined)
  assert.equal(out.policy?.readOnly, true)
  console.log("  ok   a string scope is reported and omitted")
}


// A child run: activate, fire session_start, then before_agent_start with a role tag.
const childRun = async (opts: { cwd: string; home: string; systemPrompt: string; bindings?: string; order?: "normal" | "hostile"; beforeStartEmissions?: number; beforeStartDelayMs?: number; beforeStartCwds?: string[]; foreground?: boolean; rawBindings?: boolean; systemPromptOptions?: PromptOptions }) => {
  const prev = {
    bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS,
    child: process.env.PI_SUBAGENT_CHILD,
    home: process.env.HOME,
  }
  if (opts.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = opts.rawBindings ? opts.bindings : wrapDispatchBindings(opts.bindings)
  if (opts.foreground) delete process.env.PI_SUBAGENT_CHILD
  else process.env.PI_SUBAGENT_CHILD = "1"
  process.env.HOME = opts.home
  const handlers: Record<string, EventHandler> = {}
  const ui: string[] = []
  const api: FakeExtensionApi = {
    on(event, fn) { handlers[event] = fn },
    registerCommand() {},
  }
  ext.activate(api)
  const ctx: SessionContext = { cwd: opts.cwd, ui: { notify: (message) => ui.push(message) } }
  if (opts.order === "hostile") {
    // A hostile host could emit session_start after the role wiring; the grant must survive it.
    await handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: opts.systemPrompt, systemPromptOptions: opts.systemPromptOptions }, ctx)
    await handlers.session_start?.({ type: "session_start" }, ctx)
  } else {
    await handlers.session_start?.({ type: "session_start" }, ctx)
    const emitBeforeStart = (cwd?: string) => handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: opts.systemPrompt, systemPromptOptions: opts.systemPromptOptions }, cwd ? { ...ctx, cwd } : ctx)
    if (opts.beforeStartEmissions && opts.beforeStartEmissions > 1) {
      await Promise.all(
        Array.from({ length: opts.beforeStartEmissions }, async (_, i) => {
          if (i > 0 && opts.beforeStartDelayMs) await new Promise((r) => setTimeout(r, opts.beforeStartDelayMs))
          return emitBeforeStart(opts.beforeStartCwds?.[i])
        }),
      )
    } else {
      await emitBeforeStart()
    }
  }
  return {
    call: async (tool: string, input?: Record<string, unknown>): Promise<Outcome> =>
      (await handlers.tool_call({ type: "tool_call", toolName: tool, input, toolCallId: "r1" }, ctx)) as Outcome,
    ui,
    restore: () => {
      if (prev.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = prev.bindings
      if (prev.child === undefined) delete process.env.PI_SUBAGENT_CHILD
      else process.env.PI_SUBAGENT_CHILD = prev.child
      if (prev.home === undefined) delete process.env.HOME
      else process.env.HOME = prev.home
    },
  }
}

// 199. The role md fills scope when no bindings file exists.
{
  const home = join(workdir, "role-home-199")
  const md = join(home, ".agents", "phase1-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# phase1-coder\n')
  const proj = join(workdir, "role-proj-199")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase1-coder"/>\nhello' })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope allows its subtree")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "paths outside the md scope are refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   the role md fills scope when no bindings exist")
}

// 200. A bindings value wins over the md baseline for the same key.
{
  const home = join(workdir, "role-home-200")
  const md = join(home, ".agents", "phase1-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n')
  const proj = join(workdir, "role-proj-200")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "allowed"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase1-coder"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }),
  })
  assert.equal(await run.call("read", { path: join(proj, "src", "x.ts") }), undefined, "the bindings scope works")
  const mdPath = await run.call("read", { path: join(proj, "allowed", "x.ts") })
  assert.ok(mdPath && mdPath.block, "the md scope does not add to the bindings scope")
  assert.ok(
    mdPath.reason.includes("(source: extensionBindings pi-subagents-extend/1)"),
    `the refusal must name the bindings layer, got: ${mdPath.reason}`,
  )
  assert.ok(
    !mdPath.reason.includes(md) && !mdPath.reason.includes("role md"),
    `the md contributed no policy key, so it must not appear as a source, got: ${mdPath.reason}`,
  )
  run.restore()
  console.log("  ok   bindings wins over the md baseline for the same key")
}

// 201. The role md names itself as the source when it is the only configuration.
{
  const home = join(workdir, "role-home-201")
  const md = join(home, ".agents", "source-label-coder-201.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# source-label-coder-201\n')
  const proj = join(workdir, "role-proj-201")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="source-label-coder-201"/>\nhello',
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope still allows its subtree")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "paths outside the md scope are refused")
  assert.ok(
    outside.reason.includes(`(source: role md ${md})`),
    `the reason must name the md file as the only source layer, got: ${outside.reason}`,
  )
  assert.ok(
    !outside.reason.includes("extensionBindings"),
    `the md-only reason must not claim an extensionBindings layer, got: ${outside.reason}`,
  )
  run.restore()
  console.log("  ok   the role md names itself as the source when it is the only configuration")
}


// 202. A payload key and an md deny union name both layers, in contribution order.
//      A refusal's source is the parent agent's only clue about which file to edit, so it names
//      every layer that actually contributed — extensionBindings first, then the role md — and
//      only those layers. Here the md contributes through the deny union alone: the payload
//      declares scope and bash, so the md's only way in is its deny entry joining the union.
{
  const proj = join(workdir, "role-proj-202")
  const md = writeAgentMd({
    cwd: proj,
    role: "source-label-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { deny: ["git stash"] } } },
  })
  const run = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("source-label-coder-202", "Contribution-order role for the deny union."),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git status", "git stash"] } },
    }),
  })
  assert.equal(await run.call("bash", { command: "git status" }), undefined, "the payload's own allowlist still runs its commands")
  const denied = await run.call("bash", { command: "git stash" })
  assert.ok(denied && denied.block, "the md's deny entry blocks a command the payload's own allowlist names")
  assert.ok(
    denied.reason.includes(`(source: extensionBindings pi-subagents-extend/1 + role md ${md})`),
    `the reason must name the bindings layer then the md layer, got: ${denied.reason}`,
  )
  run.restore()

  // Negative control: the union is inert — the payload's deny already carries the entry — so the
  // source must not gain the md layer. Without this, a "names both layers" assertion would pass
  // even when the union added nothing.
  const inertMd = writeAgentMd({
    cwd: proj,
    role: "union-inert-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { deny: ["git stash"] } } },
  })
  const inert = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("union-inert-coder-202", "Inert-union control for the deny union."),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git status"], deny: ["git stash"] } },
    }),
  })
  const sharedDeny = await inert.call("bash", { command: "git stash" })
  assert.ok(sharedDeny && sharedDeny.block, "the deny entry both layers carry still blocks the command")
  assert.ok(
    sharedDeny.reason.includes("(source: extensionBindings pi-subagents-extend/1)") && !sharedDeny.reason.includes(inertMd),
    `an unchanged deny must not name the md as a source, got: ${sharedDeny.reason}`,
  )
  inert.restore()

  // Second control: the md declares bash but no deny, so the union has nothing to add either.
  const noDenyMd = writeAgentMd({
    cwd: proj,
    role: "no-deny-coder-202",
    extend: { permissions: { scope: ["src/**"], bash: { allow: ["cat f"] } } },
  })
  const plain = await childRun({
    cwd: proj,
    home: workdir,
    systemPrompt: childSystemPrompt("no-deny-coder-202", "Deny-less control for the deny union."),
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git status"] } } }),
  })
  const missed = await plain.call("bash", { command: "git commit" })
  assert.ok(missed && missed.block, "a command outside the payload allowlist is refused")
  assert.ok(
    missed.reason.includes("(source: extensionBindings pi-subagents-extend/1)") && !missed.reason.includes(noDenyMd),
    `an md bash block without deny must not name the md as a source, got: ${missed.reason}`,
  )
  plain.restore()
  console.log("  ok   the bindings key and an md deny union name both layers, in contribution order")
}
// 203. A role tag below the first line still applies the md scope.
{
  const home = join(workdir, "role-home-203")
  const md = join(home, ".agents", "later-line-coder-203.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# later-line-coder-203\n')
  const proj = join(workdir, "role-proj-203")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: 'rewritten prompt\n\n<active_agent name="later-line-coder-203"/>\n\nsystem prompt',
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope is active")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "a path outside the md scope is refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   a role tag on a later line applies the md scope")
}

// 204. The md is found by walking up from the dispatch cwd.
{
  const home = join(workdir, "role-home-204")
  const md = join(workdir, "role-root-204", ".pi", "agents", "nested-coder-204.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n# nested-coder-204\n')
  const nested = join(workdir, "role-root-204", "packages", "app")
  mkdirSync(join(nested, "allowed"), { recursive: true })
  mkdirSync(join(nested, "outside"), { recursive: true })
  const run = await childRun({
    cwd: nested,
    home,
    systemPrompt: '<active_agent name="nested-coder-204"/>\nhello',
  })
  assert.equal(await run.call("read", { path: join(nested, "allowed", "x.ts") }), undefined, "the md at the root is active")
  const outside = await run.call("read", { path: join(nested, "outside", "x.ts") })
  assert.ok(outside && outside.block, "a path outside the root md scope is refused")
  assert.match(outside.reason, /outside the read scope/)
  run.restore()
  console.log("  ok   a dispatch in a nested package finds the md at the project root")
}

// 205. A child with no identifiable role warns once that the md limits are not applied.
{
  const home = join(workdir, "role-home-205")
  const proj = join(workdir, "role-proj-205")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "a prompt with no active_agent tag" })
  const warnings = run.ui.filter((message) => message.includes("role md limits are NOT applied"))
  assert.equal(warnings.length, 1, `exactly one warning about the missing md limits, got: ${run.ui.join(" | ")}`)
  assert.match(warnings[0], /no active_agent role was found/)
  assert.equal(await run.call("read", { path: join(proj, "anything.ts") }), undefined, "an unbound child is unchanged")
  run.restore()
  console.log("  ok   a child with no identifiable role warns once and does not crash")
}

// 206. An md write grant cannot restore writes the bindings suppressed.
{
  const home = join(workdir, "role-home-206")
  const md = join(home, ".agents", "readonly-coder-206.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n    write: ["reports/**"]\n---\n')
  const proj = join(workdir, "role-proj-206")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "reports"), { recursive: true })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="readonly-coder-206"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], readOnly: true } }),
  })
  const write = await run.call("write", { path: join(proj, "reports", "x.md"), content: "x" })
  assert.ok(write && write.block, "the md cannot re-grant a write the bindings suppressed")
  assert.match(write.reason, /no write grant/)
  run.restore()
  console.log("  ok   a readOnly binding keeps its empty write scope against the md")
}

// 207. A known role with no md anywhere warns once and names the directories tried.
{
  const home = join(workdir, "role-home-207")
  const proj = join(workdir, "role-proj-207")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="missing-coder-207"/>\nhello' })
  const warnings = run.ui.filter((message) => message.includes("role md limits are NOT applied"))
  assert.equal(warnings.length, 1, `exactly one warning about the missing md, got: ${run.ui.join(" | ")}`)
  assert.ok(warnings[0].includes("missing-coder-207"), "the role is named")
  assert.ok(warnings[0].includes(join(proj, ".pi", "agents")), "the project directory is named")
  assert.ok(warnings[0].includes(join(home, ".agents")), "the home fallback directory is named")
  run.restore()
  console.log("  ok   a missing role md warns once and names the directories tried")
}

// 208. No role tag and no bindings/profile: the warning must say the child is unconstrained.
{
  const home = join(workdir, "role-home-208")
  const proj = join(workdir, "role-proj-208")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "a prompt with no active_agent tag" })
  const warnings = run.ui.filter((message) => message.includes("no active_agent role was found"))
  assert.equal(warnings.length, 1, `exactly one no-role warning, got: ${run.ui.join(" | ")}`)
  assert.match(warnings[0], /no configuration is in effect/, "the warning says no configuration is active")
  assert.match(warnings[0], /tool calls in this child are unconstrained/, "the warning says the child is unconstrained")
  run.restore()
  console.log("  ok   an unconfigured child warns that no configuration is in effect and it is unconstrained")
}

// 209–220. Role-config phase 2: the single bash.allow column, with read/write judged internally.
const bashApi = (await import(join(repo, "src", "bash-match.ts"))) as unknown as typeof import("../src/bash-match.ts")

// 209. commandAccess: every writer in the table classifies as write.
{
  const writers = [
    "mkdir d", "cp a b", "mv a b", "rm f", "touch f", "chmod +x f", "chown u f",
    "ln -s a b", "tee f", "dd if=a of=b", "truncate -s 0 f", "install a b", "rsync a b",
    "sed -i s/a/b/ f", "sed --in-place s/a/b/ f",
    "git add .", "git commit -m x", "git switch x", "git stash", "git init",
    "git worktree add x", "git rm f", "git mv a b", "git apply p", "git cherry-pick x",
    "git merge x", "git rebase x", "git tag v1",
    "pnpm install", "npm add x", "yarn remove x", "bun uninstall x", "pnpm update", "npm ci", "pnpm test",
    "node a.mjs", "python a.py", "python3 a.py", "sh a.sh", "bash a.sh", "zsh a.sh",
    "ruby a.rb", "perl a.pl",
  ]
  for (const cmd of writers) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `writer must be write: ${cmd}`)
  }
  console.log("  ok   commandAccess puts every writer in the write class")
}

// 210. commandAccess: readers, unknown programs and non-writing subcommands stay read.
{
  const readers = [
    "cat f", "ls", "rg x", "find .", "grep x f", "head f", "tail f", "wc f", "file f",
    "stat f", "diff a b", "cmp a b", "du .", "df .", "echo hi", "pwd", "which node", "type ls",
    "git status", "git diff", "git log", "git show HEAD", "git rev-parse HEAD", "git branch",
    "git remote -v", "git blame f", "git describe",
    "frobnicate --things",
  ]
  for (const cmd of readers) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `reader/unknown must be read: ${cmd}`)
  }
  console.log("  ok   commandAccess leaves readers, unknown programs and non-writing subcommands as read")
}

// 211. commandAccess peels assignments, wrappers and paths, and judges every chain segment.
{
  const peeled = [
    "env rm x", "sudo rm x", "nice rm x", "timeout 5 rm x", "xargs rm x",
    "/usr/bin/rm x", "./rm x", "FOO=1 rm x", "env FOO=1 rm x",
  ]
  for (const cmd of peeled) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `peeled writer must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("cat x; rm y", true), "write", "a chain with a writer writes")
  assert.equal(bashApi.commandAccess("cat x && rm y", true), "write", "&& with a writer writes")
  assert.equal(bashApi.commandAccess("cat x | grep y", true), "read", "an all-reader pipe stays read")
  console.log("  ok   commandAccess peels assignments/wrappers/paths and scans every chain segment")
}

// 212. commandAccess honours the writable ceiling; isUnknownProgram names unlisted programs.
{
  assert.equal(bashApi.commandAccess("rm x", false), "read", "no write grant forces read for a writer")
  assert.equal(bashApi.commandAccess("cat x; rm y", false), "read", "the ceiling wins even for a chain")
  assert.equal(bashApi.isUnknownProgram("frobnicate x"), true, "a program outside both tables is unknown")
  assert.equal(bashApi.isUnknownProgram("rm x"), false, "a listed writer is not unknown")
  assert.equal(bashApi.isUnknownProgram("cat x"), false, "a listed reader is not unknown")
  console.log("  ok   writable=false forces read; unknown programs are distinguishable")
}

// 213. parseBashRule gives allow its own column and keeps legacy read/write unchanged.
{
  const only = bashApi.parseBashRule({ allow: ["git status"] })
  assert.deepEqual(only?.read, [], "allow alone does not populate read")
  assert.deepEqual(only?.write, [], "allow alone no longer populates write")
  assert.deepEqual(only?.allow, ["git status"], "allow alone populates allow")

  const legacy = bashApi.parseBashRule({ read: ["cat f"], write: ["rm f"], allow: ["git status"] })
  assert.deepEqual(legacy?.read, ["cat f"], "legacy read is unchanged")
  assert.deepEqual(legacy?.write, ["rm f"], "legacy write no longer absorbs allow")
  assert.deepEqual(legacy?.allow, ["git status"], "allow stays separate")

  assert.equal(bashApi.parseBashRule({}), undefined, "all three columns empty means no bash")
  assert.equal(bashApi.parseBashRule({ allow: [] }), undefined, "an explicitly empty allow is still no bash")
  console.log("  ok   parseBashRule keeps allow as its own column")
}

// 214. classifyCommand takes access from the column that matched; allEntries includes allow.
{
  const legacy = bashApi.parseBashRule({ read: ["cat f"], write: ["rm f"] })
  assert.ok(legacy)
  assert.equal(bashApi.classifyCommand(legacy, "rm f")?.access, "write", "legacy write is still write")
  assert.equal(bashApi.classifyCommand(legacy, "rm f")?.column, "write", "and reports the write column")
  assert.equal(bashApi.classifyCommand(legacy, "cat f")?.access, "read", "legacy read is still read")
  assert.equal(bashApi.classifyCommand(legacy, "cat f")?.column, "read", "and reports the read column")

  const allowed = bashApi.parseBashRule({ allow: ["rm w", "cat r", "frobnicate u"], writable: true })
  assert.ok(allowed)
  const w = bashApi.classifyCommand(allowed, "rm w")
  assert.equal(w?.access, "write", "allow + writer program is write")
  assert.equal(w?.column, "allow", "and reports the allow column")
  assert.equal(bashApi.classifyCommand(allowed, "cat r")?.access, "read", "allow + reader program is read")
  const unknown = bashApi.classifyCommand(allowed, "frobnicate u")
  assert.equal(unknown?.access, "read", "allow + unknown program is read")
  assert.ok(unknown && bashApi.isUnknownProgram("frobnicate u"), "and the program is flagged unknown")
  assert.deepEqual(bashApi.allEntries(allowed), ["rm w", "cat r", "frobnicate u"], "allow shows up in allEntries")

  const ceiling = bashApi.parseBashRule({ allow: ["rm w"], writable: false })
  assert.ok(ceiling)
  assert.equal(bashApi.classifyCommand(ceiling, "rm w")?.access, "read", "writable:false ceilings an allow writer")
  console.log("  ok   classifyCommand derives allow access from the program, legacy columns untouched")
}

// 215. An allow-listed writer with writable:false is refused before spawn, on the write budget.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  const outcome = await h.call("bash", input)
  assert.equal(outcome?.block, true, "the writer is refused")
  assert.match(outcome?.reason ?? "", /the role may run this command/, "the allow grant is acknowledged")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.match(outcome?.reason ?? "", /Write refusal 1 in a row/i, "it counts on the write budget")
  assert.equal(input.command, "rm x", "the command is not rewritten, so nothing was spawned")
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m) => h.ui.push(m) } })
  assert.match(h.ui.at(-1) ?? "", /write denials: 1\/1/, "the write budget was consumed")
  assert.match(h.ui.at(-1) ?? "", /read denials: 0\//i, "the grant budget was untouched")
  h.restore()
  console.log("  ok   allow + writer + writable:false is a write-budget refusal before spawn")
}

// 216. An allow-listed reader runs through the sandbox like any bash call.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["cat src/auth/x.ts"] } } }),
  })
  const input = { command: "cat src/auth/x.ts" }
  assert.equal(await h.call("bash", input), undefined, "the reader is allowlisted and runs")
  assert.match(input.command, /pi-subagents-extend-helper/, "it goes through the sandbox")
  assert.deepEqual(specOf(input.command).read, ["/"], "the spec is the usual read-only sandbox")
  h.restore()
  console.log("  ok   allow + reader runs under the sandbox")
}

// 217. The md's permissions.bash accepts the new keys and reports bad/unknown ones.
{
  const good = rc.policyFromBlock({
    permissions: { scope: ["."], bash: { allow: ["cat f", "rm x"], deny: ["rm f"], writable: true, network: false } },
  })
  assert.deepEqual(good.problems, [], "a well-formed bash block is accepted")
  assert.deepEqual(good.policy?.bash, {
    allow: ["cat f", "rm x"], deny: ["rm f"], writable: true, network: false,
  }, "the bash keys map onto the role policy")

  const bad = rc.policyFromBlock({
    permissions: { scope: ["."], bash: { allow: "cat f", writable: "yes", mystery: 1 } },
  })
  assert.ok(bad.problems.some((p) => p.includes("permissions.bash.allow")), "a non-array allow is reported")
  assert.ok(bad.problems.some((p) => p.includes("permissions.bash.writable")), "a non-boolean writable is reported")
  assert.ok(bad.problems.some((p) => p.includes("mystery")), "unknown keys are still reported")
  assert.equal(bad.policy?.bash?.allow, undefined, "a bad allow is omitted")

  const legacy = rc.policyFromBlock({ permissions: { scope: ["."], bash: { write: ["rm f"] } } })
  assert.ok(legacy.problems.some((p) => p.includes('use "allow"')), "the md legacy spelling points to allow")
  assert.equal(legacy.policy?.bash, undefined, "and is not accepted")
  console.log("  ok   md permissions.bash takes allow/deny/writable/network and reports bad keys")
}

// 218. md permissions.bash.allow reaches a child session and gates bash end to end.
{
  const home = join(workdir, "role-home-218")
  const md = join(home, ".agents", "md-bash-coder.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["**"]\n    bash:\n      allow: ["cat src/auth/x.ts"]\n      writable: false\n---\n# md-bash-coder\n')
  const proj = join(workdir, "role-proj-218")
  mkdirSync(join(proj, "src", "auth"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="md-bash-coder"/>\nhello' })
  assert.equal(await run.call("bash", { command: "cat src/auth/x.ts" }), undefined, "the md allowlist runs the reader")
  const blocked = await run.call("bash", { command: "rm src/auth/x.ts" })
  assert.ok(blocked && blocked.block, "a command outside the md allowlist is refused")
  run.restore()
  console.log("  ok   md permissions.bash.allow reaches the child and gates bash")
}

// 219. A legacy bash.read/bash.write config warns once about the migration.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { read: ["cat f"], write: ["rm f"] } } }),
  })
  const warnings = h.ui.filter((m) => m.includes("legacy columns"))
  assert.equal(warnings.length, 1, "one migration warning for the legacy config")
  assert.match(warnings[0], /bash\.allow/, "the warning names the new column")
  assert.match(warnings[0], /read\/write is judged internally/, "it says access is judged internally")
  const before = h.ui.length
  await h.call("bash", { command: "cat f" })
  assert.equal(h.ui.length, before, "no repeat warning on a later call")
  h.restore()
  console.log("  ok   a legacy bash.read/write config warns once about bash.allow")
}

// 220. A failed write by an allow-listed unknown program explains that it ran read-only.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["frobnicate"] } } }),
  })
  const input = { command: "frobnicate" }
  assert.equal(await h.call("bash", input), undefined, "the unknown program is allowlisted and runs")
  const target = `/var/tmp/pi-extend-${process.pid}/out.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /outside the writes the parent granted/, "the ordinary write-refusal note is present")
  assert.match(text, /could not tell that this program writes, so it was not treated as a write/, "the read-only cause sentence is corrected")
  assert.doesNotMatch(text, /ran read-only/, "it no longer claims the program ran read-only")
  assert.match(text, /ask for bash\.writable: true/, "a role without the ceiling is asked for the ceiling")
  assert.doesNotMatch(text, /ask for writablePaths/, "and not for writablePaths it cannot use")
  h.restore()
  console.log("  ok   a failed write by an unknown allow-listed program explains the ceiling, not a read-only run")
}

// 221. A writablePaths grant must not widen a bash.writable:false role, even for a read command.
//      The ceiling is the role's own contract: a grant reaches the sandbox spec only when the role
//      is writable. Put the grant in the repo (not /tmp), where dropHiddenGrants keeps it when it is
//      present, so its absence pins the writable gate rather than tmpfs filtering.
{
  const cwd = mkdtempSync(join(repo, ".test-cwd-"))
  const grant = join(cwd, "no-write-grant")
  mkdirSync(grant, { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: false, writablePaths: [grant] },
      },
    }),
    cwd,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "the read command passes")
  const spec = specOf(input.command)
  assert.ok(
    !spec.write.includes(grant),
    `a writable:false role must not mount its writablePaths grant, got: ${spec.write.join(", ")}`
  )
  h.restore()
  rmSync(cwd, { recursive: true, force: true })
  console.log("  ok   a writable:false role does not mount its writablePaths grant")
}

// 222. The git write table must cover every subcommand that rewrites the work tree or history.
//      A missed verb is the worst failure: the command runs as a read and nothing says so.
{
  const writers = [
    "git reset --hard", "git clean -fd", "git checkout b", "git restore f",
    "git pull", "git revert HEAD", "git tag v1",
    "git branch -d x", "git remote add o u",
  ];
  for (const cmd of writers) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `git writer must be write: ${cmd}`)
  }
  const readers = ["git status", "git log", "git tag -l", "git branch", "git remote -v"]
  for (const cmd of readers) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `git reader must be read: ${cmd}`)
  }
  console.log("  ok   git write/read subcommands and argument predicates are classified correctly")
}

// 223. find is a reader until an action argument appears; those arguments write on their own.
{
  for (const cmd of ["find . -delete", "find . -exec rm {} +"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `find action must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("find . -name x", true), "read", "a plain find stays a reader")
  console.log("  ok   find's deleting/executing arguments are write, a plain find is read")
}

// 224. A package manager runs arbitrary code unless its subcommand is provably read-only.
{
  for (const cmd of ["pnpm run build", "pnpm exec rm x", "pnpm test", "npm run build"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `package manager must be write: ${cmd}`)
  }
  for (const cmd of ["pnpm list", "npm view x"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `read-only subcommand must be read: ${cmd}`)
  }
  console.log("  ok   package managers are write except for the read-only subcommand set")
}

// 225. xargs flags must be consumed so the program word is judged, not the flags.
{
  for (const cmd of ["xargs -0 rm", "xargs -a list rm", "xargs -n1 rm"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `flagged xargs must be write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("xargs frobnicate", true), "write", "an unknown payload program is still write")
  // 这两条钉住旗标表本身：旗标吃掉后认出 reader，判 read；没有旗标表就会落到「判不准即 write」。
  for (const cmd of ["xargs -0 cat", "xargs -a list cat"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `flagged xargs with a reader must be read: ${cmd}`)
  }
  console.log("  ok   xargs flag tables expose the program word, and unknown programs are write")
}

// 226. sed -i takes an optional suffix: -i.bak and -i'' are in-place writes too.
{
  assert.equal(bashApi.commandAccess("sed -i.bak s/a/b/ f", true), "write", "a suffixed -i writes")
  assert.equal(bashApi.commandAccess("sed s/a/b/ f", true), "read", "plain sed stays a reader")
  console.log("  ok   every -i spelling is a write, plain sed is a read")
}

// 227. isUnknownProgram checks every segment, and known readers never masquerade as unknown
//      (otherwise the read side of the tables is unpinned: unknown also falls back to read).
{
  for (const cmd of ["git status", "find .", "cat x", "ls"]) {
    assert.equal(bashApi.isUnknownProgram(cmd), false, `known reader must not be unknown: ${cmd}`)
  }
  assert.equal(bashApi.isUnknownProgram("cat x; frobnicate y"), true, "an unknown later segment counts")
  assert.equal(bashApi.isUnknownProgram("frobnicate y; cat x"), true, "an unknown first segment counts")
  console.log("  ok   isUnknownProgram scans every segment and keeps known readers known")
}

// 228. A command granted by `allow` is refused for writable:false even when a legacy write
//      column also matches it: the gate keys off the allow grant and intrinsic write, not off
//      which column classifyCommand reported first.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  const outcome = await h.call("bash", input)
  assert.equal(outcome?.block, true, "the writer is refused before spawn")
  assert.match(outcome?.reason ?? "", /the role may run this command/, "the allow grant is acknowledged")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.match(outcome?.reason ?? "", /matched the legacy write column, which does not grant writes/, "the shadowing legacy column is named")
  assert.equal(input.command, "rm x", "the command is not rewritten, so nothing was spawned")
  h.restore()
  console.log("  ok   an allow grant is refused for a writer even when a legacy write column matches first")
}

// 229. The same columns with the write ceiling granted run through the sandbox.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], allow: ["rm x"], writable: true }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  assert.equal(await h.call("bash", input), undefined, "the writer runs when the role can write")
  assert.match(input.command, /pi-subagents-extend-helper/, "it goes through the sandbox")
  h.restore()
  console.log("  ok   the same command runs when bash.writable is true")
}

// 230. An allow-only config with writable:false is still refused, with no legacy clause invented.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["rm x"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const outcome = await h.call("bash", { command: "rm x" })
  assert.equal(outcome?.block, true, "an allow-only writer is refused")
  assert.match(outcome?.reason ?? "", /bash\.writable: false gives no write access/, "the cause is named")
  assert.doesNotMatch(outcome?.reason ?? "", /matched the legacy/, "and no legacy column is invented")
  h.restore()
  console.log("  ok   allow-only + writable:false is still refused, with no legacy clause")
}

// 231. A legacy-only config with writable:false is NOT refused before spawn: the early refusal
//      belongs to the new single-column path, not to existing bindings.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["rm"], writable: false }, maxWriteDenies: 1 },
    }),
  })
  const input = { command: "rm x" }
  assert.equal(await h.call("bash", input), undefined, "a legacy write command is not refused early")
  assert.match(input.command, /pi-subagents-extend-helper/, "it still goes through the sandbox")
  h.restore()
  console.log("  ok   a legacy-only writer config has no new early refusal")
}

// 232. A role WITH the write ceiling does not get the "could not tell" sentence: the note's
//      advice and cause must follow the role's actual grant.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["frobnicate"], writable: true } } }),
  })
  const input = { command: "frobnicate" }
  assert.equal(await h.call("bash", input), undefined, "the unknown program is allowlisted and runs")
  const target = `/var/tmp/pi-extend-${process.pid}/out-232.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /outside the writes the parent granted/, "the ordinary write-refusal note is present")
  assert.doesNotMatch(text, /could not tell that this program writes|not in the write table/, "no read-only cause sentence is added for a writable role")
  assert.match(text, /ask for writablePaths/, "a role with the ceiling is still asked for writablePaths")
  h.restore()
  console.log("  ok   a writable role's write note keeps the writablePaths advice and drops the cause")
}

// 233. A legacy bash column supplied by the dispatch bindings warns under that bindings
//      source alone, not merged into any role-md attribution. (The profile layer is gone;
//      the bindings env is the only non-md source that can still carry legacy columns.)
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["cat f"], write: ["rm f"] } } }),
  })
  const warnings = h.ui.filter((m) => m.includes("legacy columns"))
  assert.equal(warnings.length, 1, "the bindings' legacy columns produce one warning")
  assert.match(
    warnings[0],
    /^pi-subagents-extend: extensionBindings pi-subagents-extend\/1 still spells/,
    "the warning is attributed to the bindings source alone",
  )
  h.restore()
  console.log("  ok   a legacy column from the dispatch bindings warns under the bindings source")
}


// 234. A quoted value in a git global flag must not hide the verb: whitespace splitting used to
//      make `x'` the "subcommand", so the real `reset` was never examined.
{
  const writer = "git -c core.pager='rm x' reset --hard"
  assert.equal(bashApi.commandAccess(writer, true), "write", "a quoted global value does not hide reset")
  // `log` is safe to call read: the quote fragment belongs to the flag's value, not the verb.
  assert.equal(bashApi.commandAccess("git -c core.pager='rm x' log", true), "read", "the quote fragment is not the verb")
  assert.equal(bashApi.requiresNetwork(writer), null, "reset stays local behind a quoted global value")
  assert.equal(
    bashApi.requiresNetwork("git -c core.pager='rm x' fetch"),
    "git fetch",
    "the network verb is found behind the same quoted global value"
  )
  assert.equal(bashApi.commandAccess('git -c core.pager="rm x" clean -fd', true), "write", "double-quoted values too")
  console.log("  ok   quoted git global values no longer hide the verb from write and network checks")
}

// 235. No-argument git globals must be skipped; when an unlisted global makes the verb
//      unlocatable, the verdict is write rather than the read of a guessed subcommand.
{
  for (const cmd of ["git -p reset --hard", "git --paginate clean -fd", "git -P rm x", "git --bare reset --hard"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a no-argument global must not hide the verb: ${cmd}`)
  }
  assert.equal(
    bashApi.commandAccess("git --namespace foo reset --hard", true),
    "write",
    "an unlisted global with an argument leaves the verb unlocatable"
  )
  assert.equal(bashApi.requiresNetwork("git -p fetch"), "git fetch", "a no-argument global does not hide a network verb")
  console.log("  ok   no-argument git globals are skipped, and an unlocatable verb is a write")
}

// 236. config/store/version are not blanket readers: the second token decides whether they write.
{
  for (const cmd of [
    "npm config set registry https://x", "pnpm config set a b", "yarn config set k v",
    "npm config delete k", "pnpm store prune", "npm version patch",
    "npm config", "pnpm store",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a package-manager writer must be write: ${cmd}`)
  }
  for (const cmd of [
    "pnpm config get registry", "pnpm config list", "pnpm store path", "pnpm store status",
    "npm version", "pnpm --version", "npm --help", "yarn -v",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a package-manager query must be read: ${cmd}`)
  }
  console.log("  ok   package-manager config/store/version writes are found, queries and flags-only stay read")
}

// 237. More git branch/remote writes: each argument rewrites a branch, a remote or its refs.
{
  for (const cmd of [
    "git branch -M x", "git branch -C x", "git branch -c x", "git branch -f x",
    "git branch --delete x", "git branch --copy x", "git branch --force x", "git branch --unset-upstream x",
    "git remote prune origin", "git remote set-branches origin main", "git remote update",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a git ref/remote writer must be write: ${cmd}`)
  }
  for (const cmd of ["git branch", "git branch -v", "git remote", "git remote -v", "git remote get-url origin"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a git listing must be read: ${cmd}`)
  }
  console.log("  ok   git branch and remote write arguments are classified correctly")
}

// 238. find -fprint0 writes a file just like -fprint and -fprintf.
{
  assert.equal(bashApi.commandAccess("find . -fprint0 /tmp/out", true), "write", "fprint0 writes a file")
  assert.equal(bashApi.commandAccess("find . -print0", true), "read", "plain stdout printing stays read")
  console.log("  ok   find -fprint0 is a write, -print0 is not")
}

// 239. The writable:false advice is live: buildSpec still grants /tmp and device paths with no
//      write ceiling, so writeRefusalNote's empty-grant early return does not suppress it.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["cat f"], writable: false } } }),
  })
  const input = { command: "cat f" }
  assert.equal(await h.call("bash", input), undefined, "the reader runs")
  const write = specOf(input.command).write
  assert.ok(write.length > 0, "a writable:false spec still has write paths, so the advice branch is reachable")
  const target = `/var/tmp/pi-extend-${process.pid}/out-239.txt`
  const outcome = await h.result("bash", `error: cannot write '${target}': Permission denied`, true)
  const content: unknown = outcome?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : ""
  assert.match(text, /ask for bash\.writable: true/, "a role with no write ceiling is told how to get one")
  assert.doesNotMatch(text, /ask for writablePaths/, "and is not asked to extend grants it cannot use")
  h.restore()
  console.log("  ok   a writable:false role still receives the ceiling advice on a write refusal")
}

// 240. Package-manager flags that take a value must not donate that value as the subcommand:
//      `pnpm -C dir list` used to be classified write, so a read-only query burned the write budget.
{
  for (const cmd of [
    "pnpm -C dir list", "pnpm --dir pkgs/a list", "npm --prefix /tmp/x ls", "pnpm -C dir why x",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a read-only query behind a value-taking flag must be read: ${cmd}`)
  }
  for (const cmd of [
    "pnpm -C dir install", "pnpm --dir pkgs/a run typecheck", "npm --prefix /tmp/x run build",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `the real subcommand still decides the verdict: ${cmd}`)
  }
  // The = forms are one token; they must reach the same verdict as the split forms.
  assert.equal(bashApi.commandAccess("pnpm --dir=pkgs/a list", true), "read", "an inline flag value is not the subcommand")
  assert.equal(bashApi.commandAccess("npm --prefix=/tmp/x ls", true), "read", "the npm inline form too")
  console.log("  ok   value-taking package-manager flags no longer hide the subcommand")
}

// 241. config's action token stays decisive: a flag between the program and the action must not
//      change the verdict, and a global flag after the action must not be mistaken for it.
{
  assert.equal(bashApi.commandAccess("pnpm config --global set x y", true), "write", "config set writes even behind --global")
  assert.equal(bashApi.commandAccess("pnpm config get --global registry", true), "read", "config get stays read with --global")
  console.log("  ok   config's second token still decides read vs write around --global")
}

// 242. An unlisted package-manager flag must not turn a read-only query into a write: skip the
//      flag, then trust a located known subcommand, but never guess a read from an unknown token.
{
  for (const cmd of [
    "pnpm --silent list", "pnpm --ignore-workspace list", "pnpm --stream list",
    "yarn --silent list", "pnpm --parallel -r list",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a read-only subcommand after an unknown flag stays read: ${cmd}`)
  }
  for (const cmd of [
    "pnpm --silent run build", "pnpm --stream test", "pnpm --silent install",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a known writer subcommand after an unknown flag stays write: ${cmd}`)
  }
  assert.equal(bashApi.commandAccess("pnpm --mystery-flag dir list", true), "write", "an unknown token after an uncertain flag is not guessed as read")
  console.log("  ok   unlisted flags no longer hide read-only package-manager subcommands")
}

// 243. A quoted global value spanning three or more words used to be split into whitespace
//      fragments; the first bare fragment became the "subcommand" and hid the real verb.
{
  for (const cmd of [
    "git -c k='a b c' reset --hard",
    'git -c k="a b c" reset --hard',
    "git -C '/x y z' clean -fd",
  ]) {
    assert.equal(bashApi.commandAccess(cmd, true), "write", `a multi-word quoted global must not hide the verb: ${cmd}`)
  }
  // The quoted value belongs to the -c flag; the verb is log, which only reads.
  assert.equal(
    bashApi.commandAccess("git -c core.pager='less -R' log", true),
    "read",
    "a quoted global value is not the verb; log only reads"
  )
  assert.equal(
    bashApi.requiresNetwork("git -c k='a b c' fetch"),
    "git fetch",
    "the network verb is found behind a multi-word quoted global"
  )
  console.log("  ok   multi-word quoted globals no longer hide the verb from write and network checks")
}

// 244. git's version/help flags only print local information: they are read-only, and an
//      uncertain position behind them used to make the verdict write.
{
  for (const cmd of ["git --version", "git --help", "git -h"]) {
    assert.equal(bashApi.commandAccess(cmd, true), "read", `a git version/help flag must be read: ${cmd}`)
  }
  console.log("  ok   git version/help flags are read")
}

// 245. Switching the verdict tokenizer must not disturb allowlist matching: commandMatches keeps
//      splitting on whitespace, so a literal entry with a quoted argument still matches by prefix.
{
  const entry = "git -c core.pager='rm x' reset"
  assert.equal(
    bashApi.commandMatches(entry, "git -c core.pager='rm x' reset --hard"),
    true,
    "a literal entry with a quoted argument still matches by whitespace-token prefix"
  )
  assert.equal(
    bashApi.commandMatches(entry, "git -c core.pager='rm x' clean -fd"),
    false,
    "and still refuses a different verb"
  )
  console.log("  ok   allowlist matching is unchanged by the verdict tokenizer switch")
}

// 246. preExec runs once per child session from the role md; failures keep the session alive.
{
  const home = join(workdir, "role-home-246")
  const md = join(home, ".agents", "phase3-setup.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: printf "ran\\n" >> marker.txt\n---\n# phase3-setup\n')
  const proj = join(workdir, "role-proj-246")
  mkdirSync(proj, { recursive: true })
  const marker = join(proj, "marker.txt")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-setup"/>\nhello' })
  assert.equal(readFileSync(marker, "utf8"), "ran\n", "exactly one run")
  assert.equal(await run.call("read", { path: marker }), undefined, "the session proceeds after preExec")
  run.restore()

  const failMd = join(home, ".agents", "phase3-fail.md")
  writeFileSync(failMd, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: printf "boom\\n" >&2; exit 7\n---\n# phase3-fail\n')
  const failing = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-fail"/>\nhello' })
  assert.ok(failing.ui.some((m) => m.includes("setup.preExec exited with code 7") && m.includes("boom")), failing.ui.join("\n"))
  assert.equal(await failing.call("read", { path: marker }), undefined, "a failing preExec does not block the child")
  failing.restore()

  const ignoredMd = join(home, ".agents", "phase3-ignored.md")
  writeFileSync(ignoredMd, '---\nextend:\n  permissions:\n    scope: ["."]\n---\n# phase3-ignored\n')
  const payloadMarker = join(proj, "payload-marker.txt")
  const ignored = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-ignored"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], setup: { preExec: `printf ran > ${payloadMarker}` } } }),
  })
  assert.ok(ignored.ui.some((m) => m.includes("setup in extensionBindings is ignored")), ignored.ui.join("\n"))
  assert.equal(existsSync(payloadMarker), false, "a payload setup is never executed")
  ignored.restore()
  console.log("  ok   preExec runs once from the md; failures warn; payload setup is ignored")
}

// 247. The nodeModules hint appears only on the refusal that goes through the link.
{
  const home = join(workdir, "role-home-247")
  const md = join(home, ".agents", "phase3-keep.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n    write: []\n  worktree:\n    nodeModules: keep\n---\n# phase3-keep\n')
  const proj = join(workdir, "role-proj-247")
  const target = join(proj, "deps", "shared")
  mkdirSync(target, { recursive: true })
  mkdirSync(join(proj, "src"), { recursive: true })
  symlinkSync(target, join(proj, "node_modules"), "dir")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-keep"/>\nhello' })
  const linked = await run.call("write", { path: join(proj, "node_modules", "pkg", "x.js"), content: "x" })
  assert.ok(linked && linked.block && linked.reason.includes("readable but not writable"), "the write is refused")
  assert.match(linked.reason, /worktree\.nodeModules: remove/, "the refusal names the fix")
  const plain = await run.call("write", { path: join(proj, "src", "x.js"), content: "x" })
  assert.ok(plain && plain.block, "an ordinary write is also refused")
  assert.ok(!plain.reason.includes("worktree.nodeModules"), "but gets no nodeModules hint")
  assert.equal(existsSync(join(proj, "node_modules")), true, "keep leaves the link alone")
  run.restore()
  console.log("  ok   the readable-but-not-writable hint is limited to the node_modules link")
}
// 248. The deliverable grant must survive a session_start emitted after the wiring (P1-3).
{
  const home = join(workdir, "role-home-248")
  const md = join(home, ".agents", "phase3-order.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n    write: []\n  output:\n    deliverable: report.md\n---\n# phase3-order\n')
  const proj = join(workdir, "role-proj-248")
  mkdirSync(proj, { recursive: true })
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."],
      bash: { read: ["git status"], writable: true },
    },
  })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-order"/>\nhello',
    bindings,
    order: "hostile",
  })
  const target = join(proj, "report.md")
  assert.equal(existsSync(target), true, "the deliverable file was created")
  const input = { command: "git status" }
  assert.equal(await run.call("bash", input), undefined, "the bash command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir === target || dir.endsWith("/report.md")),
    `the deliverable grant survives the later session_start, got: ${spec.write.join(", ")}`,
  )
  run.restore()
  console.log("  ok   the deliverable grant survives a session_start after the wiring")
}

// 249. The nodeModules hint reaches the neither-readable-nor-writable refusal (P1-1).
{
  const home = join(workdir, "role-home-249")
  const md = join(home, ".agents", "phase3-hint.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n    write: []\n  worktree:\n    nodeModules: keep\n---\n# phase3-hint\n')
  const proj = join(workdir, "role-proj-249")
  const main = join(workdir, "role-main-249")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(main, { recursive: true })
  symlinkSync(main, join(proj, "node_modules"), "dir")
  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-hint"/>\nhello' })
  const refused = await run.call("write", { path: join(proj, "node_modules", "pkg", "x.js"), content: "x" })
  assert.ok(refused && refused.block, "the write is refused")
  assert.match(refused.reason, /neither readable nor writable/, "the refusal is the no-scope branch")
  assert.match(refused.reason, /worktree\.nodeModules: remove/, "the refusal names the fix")
  const plain = await run.call("write", { path: join(proj, "src", "x.js"), content: "x" })
  assert.ok(plain && plain.block, "an ordinary write is still refused")
  assert.ok(!plain.reason.includes("worktree.nodeModules"), "and gets no false hint")
  run.restore()
  console.log("  ok   the nodeModules hint reaches the neither-readable-nor-writable refusal")
}

// 250. P1-2: a second before_agent_start arriving mid-preExec must await the in-flight wiring.
{
  const home = join(workdir, "role-home-250")
  const md = join(home, ".agents", "phase3-double.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: sleep 0.3; printf \'ran\\n\' >> count.txt\n  output:\n    deliverable: report.md\n---\n# phase3-double\n')
  const proj = join(workdir, "role-proj-250")
  mkdirSync(proj, { recursive: true })
  const count = join(proj, "count.txt")
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."],
      bash: { read: ["git status"], writable: true },
    },
  })
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase3-double"/>\nhello',
    bindings,
    beforeStartEmissions: 2,
    beforeStartDelayMs: 50,
  })
  assert.equal(readFileSync(count, "utf8"), "ran\n", "preExec ran exactly once across two emissions")
  assert.equal(existsSync(join(proj, "report.md")), true, "the deliverable was wired")
  const input = { command: "git status" }
  assert.equal(await run.call("bash", input), undefined, "the bash command still passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir === join(proj, "report.md") || dir.endsWith("/report.md")),
    `the deliverable grant survives the second emission, got: ${spec.write.join(", ")}`,
  )
  run.restore()
  console.log("  ok   a mid-preExec before_agent_start awaits the in-flight wiring")
}

// 251. P2-2: the transfer read refusal must not carry the write-only nodeModules hint.
{
  const home = join(workdir, "role-home-251")
  const md = join(home, ".agents", "phase3-xfer-hint.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**", "docs/**"]\n    write: ["docs/**"]\n  worktree:\n    nodeModules: keep\n---\n# phase3-xfer-hint\n')
  const proj = join(workdir, "role-proj-251")
  const real = join(workdir, "role-real-251")
  mkdirSync(join(proj, "src"), { recursive: true })
  mkdirSync(join(proj, "docs"), { recursive: true })
  mkdirSync(join(real, "pkg"), { recursive: true })
  symlinkSync(real, join(proj, "node_modules"), "dir")

  const hl = mkdtempSync(join(tmpdir(), "pi-subagents-extend-xfer-hint-hl-"))
  const sessionFile = join(hl, "session.jsonl")
  const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)
  mkdirSync(join(hl, "sessions"), { recursive: true })
  const srcAbs = join(proj, "src", "a.ts")
  const docAbs = join(proj, "docs", "b.md")
  const modSrc = join(proj, "node_modules", "pkg", "src.js")
  const modDest = join(proj, "node_modules", "pkg", "dest.js")
  writeFileSync(
    join(hl, "sessions", `${key}.registry.jsonl`),
    [
      JSON.stringify({ kind: "session", sessionFile }),
      ...Object.entries({ [srcAbs]: "srcA", [docAbs]: "docB", [modSrc]: "modSrc", [modDest]: "modDest" }).map(([path, anchor]) =>
        JSON.stringify({ kind: "allocate", path, rows: [[anchor, "line"]] }),
      ),
      "",
    ].join("\n"),
  )
  const previous = { dir: process.env.PI_HASHLINE_DIR, session: process.env.PI_SESSION_FILE }
  process.env.PI_HASHLINE_DIR = hl
  process.env.PI_SESSION_FILE = sessionFile

  const run = await childRun({ cwd: proj, home, systemPrompt: '<active_agent name="phase3-xfer-hint"/>\nhello' })
  try {
    const readRefusal = await run.call("copy", { source_from: "modSrc", source_to: "modSrc", anchor: "docB", direction: "after" })
    assert.ok(readRefusal && readRefusal.block, "the transfer read is refused")
    assert.match(String(readRefusal.reason), /read scope/, "it is the read-side refusal")
    assert.ok(!readRefusal.reason.includes("worktree.nodeModules"), "a read refusal carries no write-only hint")

    const moveRefusal = await run.call("move", { source_from: "modSrc", source_to: "modSrc", anchor: "docB", direction: "after" })
    assert.ok(moveRefusal && moveRefusal.block, "the move is refused on its source")
    assert.match(String(moveRefusal.reason), /worktree\.nodeModules: remove/, "the source write refusal keeps the hint")

    const destRefusal = await run.call("copy", { source_from: "srcA", source_to: "srcA", anchor: "modDest", direction: "after" })
    assert.ok(destRefusal && destRefusal.block, "the destination write is refused")
    assert.match(String(destRefusal.reason), /worktree\.nodeModules: remove/, "the destination write refusal keeps the hint")
  } finally {
    run.restore()
    if (previous.dir === undefined) delete process.env.PI_HASHLINE_DIR
    else process.env.PI_HASHLINE_DIR = previous.dir
    if (previous.session === undefined) delete process.env.PI_SESSION_FILE
    else process.env.PI_SESSION_FILE = previous.session
  }
  console.log("  ok   the transfer read refusal has no write-only nodeModules hint")
}

// 252. P2-1: a second child session with a different cwd must get its own wiring, not be skipped.
{
  const home = join(workdir, "role-home-252")
  const md = join(home, ".agents", "phase3-two-sessions.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n  setup:\n    preExec: sleep 0.05; printf \'ran\\n\' >> count.txt\n---\n# phase3-two-sessions\n')
  const projA = join(workdir, "role-proj-252a")
  const projB = join(workdir, "role-proj-252b")
  mkdirSync(projA, { recursive: true })
  mkdirSync(projB, { recursive: true })
  const bindings = JSON.stringify({
    "pi-subagents-extend/1": {
      scope: ["."],
      bash: { read: ["git status"] },
    },
  })
  const countA = join(projA, "count.txt")
  const countB = join(projB, "count.txt")
  const run = await childRun({
    cwd: projA,
    home,
    systemPrompt: '<active_agent name="phase3-two-sessions"/>\nhello',
    bindings,
    beforeStartEmissions: 2,
    beforeStartCwds: [projA, projB],
  })
  assert.equal(existsSync(countA), true, "the first session wired its preExec")
  assert.equal(existsSync(countB), true, "the second session with a different cwd was not skipped")
  assert.equal(readFileSync(countA, "utf8"), "ran\n", "the first session's preExec ran once")
  assert.equal(readFileSync(countB, "utf8"), "ran\n", "the second session's preExec ran once")
  run.restore()
  console.log("  ok   a second child session with a different cwd is wired independently")
}

// 253. A tagless prompt still applies the md scope through its body (systemPromptMode: replace host).
{
  const home = join(workdir, "role-home-253")
  const md = join(home, ".agents", "body-match-253.md")
  mkdirSync(dirname(md), { recursive: true })
  const body = "BODY MATCH ROLE MARKER a distinctive child prompt body carried through systemPromptMode replace that identifies this role without any active_agent tag at all"
  writeFileSync(md, `---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n${body}\n`)
  const proj = join(workdir, "role-proj-253")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: `rewritten prompt\n${body}\ntail` })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope is applied from the body match")
  const outside = await run.call("write", { path: join(proj, "outside", "x.ts"), content: "x" })
  assert.ok(outside && outside.block, "a write outside the md scope is refused")
  assert.ok(
    outside.reason.includes(`(source: role md ${md})`),
    `the refusal must name the md as the source, got: ${outside.reason}`,
  )
  run.restore()
  console.log("  ok   a tagless prompt applies the md scope through its body")
}

// 254. False-positive control: an md body that is NOT in the prompt contributes nothing.
{
  const home = join(workdir, "role-home-254")
  const matchedMd = join(home, ".agents", "present-254.md")
  const decoyMd = join(home, ".agents", "absent-254.md")
  mkdirSync(dirname(matchedMd), { recursive: true })
  const presentBody = "PRESENT ROLE BODY that appears in the child prompt and must supply the scope while the absent decoy contributes nothing"
  const decoyBody = "ABSENT ROLE BODY that never appears in the prompt and must not grant the outside directory to this child under any circumstance"
  writeFileSync(matchedMd, `---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n---\n${presentBody}\n`)
  writeFileSync(decoyMd, `---\nextend:\n  permissions:\n    scope: ["outside/**"]\n---\n${decoyBody}\n`)
  const proj = join(workdir, "role-proj-254")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: `rewritten prompt\n${presentBody}\ntail` })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the matched md's scope is applied")
  const outside = await run.call("read", { path: join(proj, "outside", "x.ts") })
  assert.ok(outside && outside.block, "the decoy's outside/** scope is not applied")
  assert.match(outside.reason, /outside the read scope/)
  assert.ok(!outside.reason.includes(decoyMd), "the decoy md is not named as a source")
  run.restore()
  console.log("  ok   a role md whose body is absent from the prompt contributes nothing")
}

// 255. No tag and no body match still warns, with the systemPromptMode: replace hint when an extend md exists.
{
  const home = join(workdir, "role-home-255")
  const md = join(home, ".agents", "unknown-255.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["."]\n---\n# a role body that is not in the prompt\n')
  const proj = join(workdir, "role-proj-255")
  mkdirSync(proj, { recursive: true })
  const run = await childRun({ cwd: proj, home, systemPrompt: "UNMATCHED PROMPT 255 with no role tag and no role body markers" })
  const joined = run.ui.join("\n")
  assert.match(joined, /no active_agent role was found/, "the existing no-role warning stays")
  assert.match(joined, /systemPromptMode: replace/, "the likely cause is named")
  assert.match(joined, /append/, "the fix is named")
  run.restore()
  console.log("  ok   a tagless unmatched prompt warns about systemPromptMode: replace")
}

// 256. A foreground child has no PI_SUBAGENT_CHILD (measured: pi-subagents sets it only for
// host === "runner"; a foreground child runs in the parent with restoreProcessEnv). Its bindings
// payload is the child signal, so the role md extend must still be applied there.
{
  const home = join(workdir, "role-home-256")
  const md = join(home, ".agents", "fg-coder-256.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n  output:\n    deliverable: report.md\n---\n# fg-coder-256\n')
  const proj = join(workdir, "role-proj-256")
  mkdirSync(join(proj, "allowed"), { recursive: true })
  mkdirSync(join(proj, "outside"), { recursive: true })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="fg-coder-256"/>\nhello',
    bindings: JSON.stringify({ "pi-subagents-extend/1": {} }),
    foreground: true,
    systemPromptOptions: options,
  })
  assert.equal(await run.call("read", { path: join(proj, "allowed", "x.ts") }), undefined, "the md scope allows its subtree in a foreground child")
  const outside = await run.call("write", { path: join(proj, "outside", "x.ts"), content: "x" })
  assert.ok(outside && outside.block, "a write outside the md scope is refused in a foreground child")
  assert.ok(
    outside.reason.includes(`role md ${md}`),
    `the refusal must name the md as a source, got: ${outside.reason}`,
  )
  assert.ok(
    Object.keys(options.sections ?? {}).some((name) => name.includes("deliverable")),
    `the md's deliverable must be wired into the prompt sections, got: ${Object.keys(options.sections ?? {}).join(", ")}`,
  )
  run.restore()
  console.log("  ok   a foreground child applies the role md extend from its bindings payload")
}

// 257. The main session is not a child: no bindings payload and no role identity in the prompt
// must keep the role-md layer inert (no warning, no wiring).
{
  const home = join(workdir, "role-home-257")
  const md = join(home, ".agents", "main-excluded-257.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["allowed/**"]\n  output:\n    deliverable: report.md\n---\n# MAIN EXCLUDED ROLE BODY 257 distinctive marker\n')
  const proj = join(workdir, "role-proj-257")
  mkdirSync(proj, { recursive: true })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: "ORDINARY MAIN SESSION PROMPT 257 with no active_agent tag and no role body marker",
    foreground: true,
    bindings: undefined,
    systemPromptOptions: options,
  })
  const joined = run.ui.join("\n")
  assert.ok(
    !joined.includes("role md limits are NOT applied") && !joined.includes("no active_agent role was found"),
    `a main session must not emit role-md warnings, got: ${joined}`,
  )
  assert.deepEqual(Object.keys(options.sections ?? {}), [], "a main session must have no role deliverable wiring")
  run.restore()
  console.log("  ok   a main session is excluded from role wiring")
}

// 258. /permission must name the binding namespace and version, taken from bindingKey().
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["ls"] } } }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const lines = notified.join("\n").split("\n")
  const sourceAt = lines.findIndex((line) => line.startsWith("Source: "))
  assert.ok(sourceAt >= 0, "the command prints the source line")
  assert.equal(lines[sourceAt + 1], `Bindings: ${rc.bindingKey()}`, "the binding key from bindingKey() follows the source line")
  h.restore()
  console.log("  ok   /permission prints the binding namespace and version")
}

// 259. /permission shows one bash allow column in enforcement order, plus a legacy line.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["cat r"], write: ["cat w"], allow: ["cat a"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /^bash allow \(no write access: commands that write are refused\): cat a$/m, "the allow line carries the allow column only, not the legacy columns")
  assert.match(text, /bash \(legacy columns, migrate to allow\): read cat r \| write cat w/, "the legacy line names read and write")
  assert.doesNotMatch(text, /bash read: |bash write: /, "the retired two-column display is gone")
  h.restore()
  console.log("  ok   /permission shows one bash allow column plus the legacy line")
}

// 260. The legacy line is absent when only the allow column is populated.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["ls a"] } } }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /bash allow \(no write access: commands that write are refused\): ls a/, "the allow column shows the allow entry")
  assert.doesNotMatch(text, /legacy columns, migrate to allow/, "an allow-only config gets no legacy line")
  h.restore()
  console.log("  ok   /permission prints the legacy line only when a legacy column is set")
}

// 261. A project .pi/subagent-bindings.json warns once per process about the compat layer.
{
  const proj = join(workdir, "compat-bindings-258")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  writeFileSync(join(proj, ".pi/subagent-bindings.json"), "{}")
  const first = await handler({ cwd: proj })
  const warns = first.ui.filter((m) => m.includes("older configuration layer"))
  assert.equal(warns.length, 1, "one compat warning naming the bindings file")
  assert.match(warns[0], /\.pi\/subagent-bindings\.json/, "the file is named")
  assert.match(warns[0], /extend:/, "the md extend block is named as the new home")
  assert.match(warns[0], /is now ignored/, "it says the old file is ignored")
  first.restore()

  const second = await handler({ cwd: proj })
  assert.equal(second.ui.filter((m) => m.includes("older configuration layer")).length, 0, "a second session_start is silent")
  second.restore()
  console.log("  ok   a project .pi/subagent-bindings.json warns once per process")
}

// 262. .pi/agent-profiles/*.ts warns once; a project with neither warns nothing.
{
  const proj = join(workdir, "compat-profiles-258")
  mkdirSync(join(proj, ".pi/agent-profiles"), { recursive: true })
  writeFileSync(join(proj, ".pi/agent-profiles/x.ts"), "export default {}")
  const first = await handler({ cwd: proj })
  const warns = first.ui.filter((m) => m.includes("older configuration layer"))
  assert.equal(warns.length, 1, "one compat warning naming the profiles directory")
  assert.match(warns[0], /agent-profiles/, "the directory is named")
  assert.match(warns[0], /extend:/, "the md extend block is named as the new home")
  first.restore()

  const second = await handler({ cwd: proj })
  assert.equal(second.ui.filter((m) => m.includes("older configuration layer")).length, 0, "a second session_start is silent")
  second.restore()

  const bare = join(workdir, "compat-none-258")
  mkdirSync(bare, { recursive: true })
  const clean = await handler({ cwd: bare })
  assert.equal(clean.ui.filter((m) => m.includes("older configuration layer")).length, 0, "no compat file means no warning")
  clean.restore()
  console.log("  ok   .pi/agent-profiles warns once; a project with neither is silent")
}

// 263. A dispatch carrying a foreign /2 binding key warns once with both keys.
{
  const matching = await handler()
  await matching.call("subagent", { extensionBindings: { "pi-subagents-extend/1": {} } })
  assert.equal(matching.ui.filter((m) => m.includes("declares binding")).length, 0, "the current version warns nothing")
  matching.restore()

  const h = await handler()
  const wrong = { "pi-subagents-extend/2": {} }
  await h.call("subagent", { extensionBindings: wrong })
  const warns = h.ui.filter((m) => m.includes("declares binding"))
  assert.equal(warns.length, 1, "exactly one warning for the wrong version")
  assert.match(warns[0], /pi-subagents-extend\/2/, "the received key is named")
  assert.match(warns[0], /pi-subagents-extend\/1/, "the correct key is named")
  await h.call("subagent", { extensionBindings: wrong })
  assert.equal(h.ui.filter((m) => m.includes("declares binding")).length, 1, "a second dispatch stays silent")
  h.restore()
  console.log("  ok   a wrong dispatch version warns once with both keys")
}


// 266. `setup` at either level is ignored once and never executed.
{
  const home = join(workdir, "role-home-266")
  const md = join(home, ".agents", "phase4-setup.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# phase4-setup\n')
  const proj = join(workdir, "role-proj-266")
  mkdirSync(join(proj, "src"), { recursive: true })
  const marker = join(proj, "payload-marker.txt")
  const command = `printf ran > ${marker}`
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase4-setup"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        setup: { preExec: command },
        permissions: { scope: ["src/**"], setup: { preExec: command } },
      },
    }),
  })
  const warns = run.ui.filter((m) => m.includes("setup in extensionBindings is ignored"))
  assert.equal(warns.length, 1, `setup warns once even at both levels, got: ${run.ui.join("\n")}`)
  assert.equal(existsSync(marker), false, "payload setup is never executed")
  assert.equal(await run.call("read", { path: join(proj, "src/a.ts") }), undefined, "the scope is unchanged")
  const outside = await run.call("read", { path: join(proj, "outside.ts") })
  assert.equal(outside?.block, true, "the ignored key does not widen the scope")
  run.restore()
  console.log("  ok   setup in a dispatch payload warns once at either level and changes nothing")
}

// 267. `output` at either level is ignored once and cannot grant a deliverable path.
{
  const home = join(workdir, "role-home-267")
  const md = join(home, ".agents", "phase4-output.md")
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n# phase4-output\n')
  const proj = join(workdir, "role-proj-267")
  mkdirSync(join(proj, "src"), { recursive: true })
  const deliverable = "report.md"
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="phase4-output"/>\nhello',
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        output: { deliverable },
        permissions: { scope: ["src/**"], output: { deliverable } },
      },
    }),
  })
  const warns = run.ui.filter((m) => m.includes("output in extensionBindings is ignored"))
  assert.equal(warns.length, 1, `output warns once even at both levels, got: ${run.ui.join("\n")}`)
  assert.equal(await run.call("read", { path: join(proj, "src/a.ts") }), undefined, "the scope is unchanged")
  const report = await run.call("read", { path: join(proj, deliverable) })
  assert.equal(report?.block, true, "a payload output does not widen the read scope")
  run.restore()
  console.log("  ok   output in a dispatch payload warns once at either level and changes nothing")
}
// 268. A dispatch payload with worktree beside permissions is honoured and wins
//      over the role md's worktree default. This is the block-level key that
//      used to be dropped by extractCallConfig.
{
  const proj = join(workdir, "blocks-proj-268")
  writeAgentMd({
    cwd: proj,
    role: "coder",
    extend: { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: false } },
  })
  const h = await handler({
    cwd: proj,
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { worktree: true, permissions: { scope: ["."], allowTools: ["subagent"] } },
    }),
  })
  const input: Record<string, unknown> = { agent: "coder", task: "x" }
  assert.equal(await h.call("subagent", input), undefined)
  assert.equal(input.worktree, true, "the payload's block-level worktree wins over the role md default")
  const warns = h.ui.filter((m) => m.includes("not tracked by git"))
  assert.equal(warns.length, 0, "a payload worktree is not treated as a role default")
  h.restore()
  console.log("  ok   a dispatch's worktree beside permissions wins over the role md default")
}


// 273. A malformed payload with no permissions does not honour its worktree.
{
  const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-malformed-273-"))
  const h = await handler({
    cwd: empty,
    rawBindings: true,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { worktree: true } }),
  })
  const input: Record<string, unknown> = { agent: "ghost", task: "x" }
  const outcome = await h.call("subagent", input)
  assert.equal(outcome?.block, true, "the malformed payload is refused")
  const malformed = await h.call("read", { path: "x.ts" })
  assert.equal(malformed?.block, true, "a path call is refused too")
  assert.match(String(malformed?.reason), /permissions object/, "the missing permissions object is named")
  assert.equal(input.worktree, undefined, "its worktree is not filled")
  h.restore()
  rmSync(empty, { recursive: true, force: true })
  console.log("  ok   a payload without permissions does not get its worktree honoured")
}



// 276. /permission prints the allow column and the legacy read/write columns on separate lines.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["git diff --stat"], read: ["cat r"], write: ["cat w"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const lines = notified.join("\n").split("\n")
  const allowLine = lines.find((line) => line.startsWith("bash allow"))
  const legacyLine = lines.find((line) => line.startsWith("bash (legacy columns, migrate to allow): "))
  assert.ok(allowLine, "the allow column has its own line")
  assert.ok(legacyLine, "the legacy columns have their own line")
  assert.equal(allowLine, "bash allow (no write access: commands that write are refused): git diff --stat", "the allow line names only the allow column")
  assert.equal(
    legacyLine,
    "bash (legacy columns, migrate to allow): read cat r | write cat w",
    "the legacy line names both legacy columns",
  )
  assert.ok(!allowLine?.includes("read cat r"), "the allow line does not carry a legacy column")
  assert.ok(!legacyLine?.includes("git diff --stat"), "the legacy line does not carry the allow entry")
  h.restore()
  console.log("  ok   /permission keeps the allow column and the legacy columns on separate lines")
}

// 277. /permission states no-write-access on the allow column itself, not per entry.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["git commit", "git diff"], writable: false },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  const allowLine = text.split("\n").find((line) => line.startsWith("bash allow"))
  assert.ok(allowLine, "the allow line is printed")
  assert.match(
    allowLine ?? "",
    /^bash allow \(no write access: commands that write are refused\): /,
    "the no-write-access note belongs to the column",
  )
  assert.match(allowLine ?? "", /git commit \| git diff/, "both entries are still listed")
  assert.doesNotMatch(allowLine ?? "", /\(will be refused/, "no individual entry is marked as refused")
  h.restore()
  console.log("  ok   /permission puts the no-write-access note on the allow column, not on entries")
}

// 278. A pattern that can also match a read is not flagged; a matching write still hits the write rule.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["git tag", "git commit"], writable: false },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  const allowLine = text.split("\n").find((line) => line.startsWith("bash allow"))
  assert.ok(allowLine, "the allow line is printed")
  assert.match(
    allowLine ?? "",
    /^bash allow \(no write access: commands that write are refused\): /,
    "the column carries the note",
  )
  assert.doesNotMatch(allowLine ?? "", /git tag \(will be refused/, "git tag is not singled out as refused")
  assert.doesNotMatch(allowLine ?? "", /git commit \(will be refused/, "nor is the genuine writer")

  const listing = { command: "git tag -l" }
  assert.equal(await h.call("bash", listing), undefined, "the listing form of the tag pattern still runs")

  const commit = { command: "git commit" }
  const denied = await h.call("bash", commit)
  assert.equal(denied?.block, true, "a genuine write through a matching entry is refused")
  assert.match(String(denied?.reason), /write refusal|gives no write access/, "the refusal is the write rule")
  assert.doesNotMatch(String(denied?.reason), /not in the allowlist/, "not an allowlist miss")

  h.restore()
  console.log("  ok   patterns are not classified; a matching read runs and a matching write hits the write rule")
}

// 279. /permission leaves the no-write note off a writable allow column.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { allow: ["ls a"], writable: true },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.ok(text.includes("bash allow: ls a"), "the writable column prints its entries")
  assert.equal(text.includes("no write access"), false, "no write refusal note is printed")
  h.restore()
  console.log("  ok   /permission prints a plain allow line when the column is writable")
}

// 280. /permission does not describe a write gate that an empty allow column cannot trigger.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["cat r"], write: ["cat w"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.ok(text.includes("bash allow: (none)"), "the empty allow column is printed")
  assert.equal(text.includes("no write access"), false, "the write note needs an allow match to apply")
  h.restore()
  console.log("  ok   /permission keeps the no-write note off a legacy-only policy")
}
