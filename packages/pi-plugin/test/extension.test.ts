// Offline test for the pi-subagent-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
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
  SandboxSpec,
  SessionContext,
} from "./types.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")

// The sandbox helper is a Rust binary built by `pnpm run build:helper` (the
// package's pretest hook).
const helperBin = join(repo, "bin", "pi-subagent-extend-helper")
if (!existsSync(helperBin)) {
  throw new Error(`missing ${helperBin}; run \`pnpm run build:helper\` first`)
}

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
const liveSandbox = described?.landlock?.supported === true;
if (described?.landlock?.supported) {
  process.env.PI_SUBAGENT_EXTEND_HELPER = helperBin
} else {
  const stubDir = mkdtempSync(join(tmpdir(), "pi-subagent-extend-stub-"))
  const stub = join(stubDir, "pi-subagent-extend-helper")
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"landlock":{"kernel_abi":7,"required_abi":7,"supported":true,"reason":null},"network_namespace":true,"resolver_sockets":[]}'\n`,
  )
  chmodSync(stub, 0o755)
  process.env.PI_SUBAGENT_EXTEND_HELPER = stub
  console.log(
    `  note  kernel Landlock ABI ${described?.landlock?.kernel_abi ?? "unknown"} is below the required 7;` +
      " the suite runs against a stub helper that reports ABI 7",
  )
}

/** The sandbox spec the extension wrote for a rewritten bash command. */
function specOf(command: string): SandboxSpec {
  const match = /'--spec' '([^']+)'/.exec(command)
  assert.ok(match, `no --spec in: ${command}`)
  return JSON.parse(readFileSync(match[1], "utf8")) as SandboxSpec
}

const ext = (await import(join(repo, "src", "index.ts"))) as unknown as ExtensionModule

/**
 * Activate the extension with the given bindings env and return its tool_call handler.
 * Pass `profile` to activate through the profile loader (per-role defaults).
 */
async function handler({ bindings, cwd = workdir, profile, profileFile }: HandlerOptions = {}): Promise<Harness> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = bindings

  const handlers: Record<string, EventHandler> = {}
  const commands: Record<string, CommandSpec> = {}
  const ui: string[] = []
  ext.activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }, profile ? { profileName: profile, profileFile } : {})

  const aborts: string[] = []
  const ctx: SessionContext = { cwd, ui: { notify: (message: string) => ui.push(message) }, actions: { abort: () => aborts.push("abort") } }
  if (handlers.session_start) {
    // session_start is async but only reports; flush it before returning.
    await handlers.session_start({ type: "session_start" }, ctx)
  }

  const call = async (toolName: string, input?: Record<string, unknown>): Promise<Outcome> =>
    (await handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx)) as Outcome
  const result = async (toolName: string, content: unknown): Promise<PatchedResult | undefined> =>
    (await handlers.tool_result?.(
      { type: "tool_result", toolCallId: "t1", toolName, input: {}, content, isError: false },
      ctx,
    )) as PatchedResult | undefined
  const context = async (messages: unknown[]): Promise<AnnotatedMessages | undefined> =>
    (await handlers.context?.({ type: "context", messages }, ctx)) as AnnotatedMessages | undefined

  return {
    call,
    result,
    context,
    aborts,
    ui,
    commands,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

/** Deterministic clock: setTimeout is driven manually via advance(). */
interface TimerHost {
  now(): number
  setTimeout(fn: () => void, delay: number): number
  clearTimeout(id: number): void
}

function fakeClock(): { host: TimerHost; advance(ms: number): void } {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const host: TimerHost = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++seq
      timers.set(id, { at: now + delay, fn })
      return id
    },
    clearTimeout: (id) => void timers.delete(id),
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) break
      const [id, t] = due[0]
      timers.delete(id)
      now = t.at
      t.fn()
    }
    now = target
  }
  return { host, advance }
}

const defaultProbe = () => ({
  idleWriteMs: 6 * 60 * 1000,
  abortGraceMs: 2 * 60 * 1000,
  repeatBash: 3,
  successIdleMs: 5 * 60 * 1000,
  successPatterns: ["fail=0"],
  forbidWritePatterns: [],
})

const workdir = mkdtempSync(join(tmpdir(), "pi-subagent-extend-test-"))
mkdirSync(join(workdir, "src/auth"), { recursive: true })

// 1. No bindings: the extension is inert, every call passes.
{
  const h = await handler({ bindings: undefined })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "unconfigured read passes")
  assert.equal(await h.call("bash", { command: "ls" }), undefined, "unconfigured bash passes")
  assert.equal(h.ui.length, 0, "unconfigured session_start stays silent")
  h.restore()
  console.log("  ok   无 bindings 时不生效，父会话不受影响")
}

// 2. Bindings scope: reads and in-scope writes pass, everything else is denied.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/auth/**", "src/**", "README.md"], maxDenies: 0 },
    }),
  })
  assert.equal(await h.call("read", { path: "src/auth/login.ts" }), undefined, "in-scope read passes")
  assert.equal(await h.call("edit", { path: "src/auth/login.ts" }), undefined, "in-scope edit passes")
  assert.equal(await h.call("grep", { path: "src/auth" }), undefined, "in-scope grep passes")
  assert.equal(await h.call("ls", { path: "src/auth" }), undefined, "dir glob also matches the dir itself")
  assert.equal(await h.call("read", { path: "README.md" }), undefined, "plain-file glob passes")
  assert.equal(await h.call("ls", { path: "src" }), undefined, "'src/**' matches 'src' itself")

  const outside = await h.call("read", { path: "docs/design.md" })
  assert.equal(outside?.block, true, "out-of-scope read is blocked")
  assert.match(outside.reason, /outside the read scope/, "block reason names the read scope")
  const editOutside = await h.call("write", { path: "docs/notes.md" })
  assert.equal(editOutside?.block, true, "out-of-scope write is blocked")

  const bash = await h.call("bash", { command: "cat /etc/passwd" })
  assert.equal(bash?.block, true, "bash is always blocked")
  const codemode = await h.call("codemode", { code: "1" })
  assert.equal(codemode?.block, true, "codemode is always blocked")

  const unknown = await h.call("web_search", { query: "x" })
  assert.equal(unknown?.block, true, "unknown tools fail closed")

  assert.equal(await h.call("structured_output", { result: {} }), undefined, "structured_output passes")
  assert.equal(await h.call("contact_supervisor", { message: "need a wider scope" }), undefined, "contact_supervisor is the report channel")
  h.restore()
  console.log("  ok   范围内放行、范围外拒绝，执行器与未知工具 fail closed")
}

// 3. readOnly bindings block edit/write even inside the scope.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], readOnly: true } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "read-only read passes")
  const edit = await h.call("edit", { path: "src/a.ts" })
  assert.equal(edit?.block, true, "read-only edit is blocked")
  assert.match(edit.reason, /read-only/, "block reason says read-only")
  h.restore()
  console.log("  ok   readOnly 时范围内也禁止 edit/write")
}

// 4. Explicit empty scope denies every file access.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: [] } }) })
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

// 6. Bindings for another namespace leave this extension inert.
{
  const h = await handler({ bindings: JSON.stringify({ "some-other-ext/1": { data: 1 } }) })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "foreign bindings do not engage the scope")
  h.restore()
  console.log("  ok   别的扩展的绑定不触发本扩展")
}

// 7. maxReads caps successful reads.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxReads: 2 } }),
  })
  assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "read 1 passes")
  assert.equal(await h.call("read", { path: "src/b.ts" }), undefined, "read 2 passes")
  const third = await h.call("read", { path: "src/c.ts" })
  assert.equal(third?.block, true, "read 3 is denied by the budget")
  assert.match(third.reason, /read budget/, "block reason names the budget")
  assert.equal(await h.call("grep", { path: "src" }), undefined, "grep does not consume the read budget")
  h.restore()
  console.log("  ok   maxReads 限制 read 次数")
}

// 8. allowTools opens holes for named non-executor tools.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], allowTools: ["todo_write"] } }),
  })
  assert.equal(await h.call("todo_write", { items: [] }), undefined, "allowTools entry passes")
  const executor = await h.call("bash", { command: "ls" })
  assert.equal(executor?.block, true, "allowTools cannot re-enable executors")
  h.restore()
  console.log("  ok   allowTools 放行点名工具，但执行器类仍拒绝")
}

// 9. Search tools without an explicit path default to cwd and get judged on it.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } }) })
  const grep = await h.call("grep", { pattern: "x" })
  assert.equal(grep?.block, true, "pathless grep (cwd) is out of scope here")
  assert.match(grep.reason, /outside (this task's |the )?(read )?scope/, "block reason teaches the scope")
  h.restore()
  console.log("  ok   缺省 path 视为 cwd 并按范围判定")
}

// 10. The bundled usage skill ships with the extension via resources_discover.
{
  const handlers: Record<string, EventHandler> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  }
  ext.activate(api)
  const discover = handlers.resources_discover
  assert.ok(discover, "the extension registers resources_discover")
  const result = (await discover({ type: "resources_discover", cwd: workdir, reason: "startup" }, { cwd: workdir, ui: { notify() {} } })) as
    | { skillPaths?: string[] }
    | undefined
  const dirs = result?.skillPaths ?? []
  assert.equal(dirs.length, 3, "all usage skills are registered")
  const names = dirs.map((dir) => {
    const path = join(dir, "SKILL.md")
    assert.equal(existsSync(path), true, `${dir} holds a SKILL.md`)
    const frontmatter = readFileSync(path, "utf8").slice(0, 400)
    return frontmatter.match(/name: ([\w-]+)/)?.[1]
  })
  assert.deepEqual(
    names.sort(),
    ["pi-subagent-extend", "pi-subagent-extend-context", "pi-subagent-extend-probes"],
    "scope, probe and context skills",
  )
  console.log("  ok   三个用法 skill 随扩展经 resources_discover 注册")
}

// 11. A scoped session does not advertise the delegation skill.
{
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } })
  const handlers: Record<string, EventHandler> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  }
  ext.activate(api)
  const scopedDiscover = handlers.resources_discover
  assert.ok(scopedDiscover, "the extension registers resources_discover")
  const scoped = (await scopedDiscover({ type: "resources_discover", cwd: workdir, reason: "startup" }, { cwd: workdir, ui: { notify() {} } })) as
    | { skillPaths?: string[] }
    | undefined
  assert.equal(scoped?.skillPaths, undefined, "a scoped session gets no skill path")
  if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
  console.log("  ok   已上锁的会话不注册委派 skill")
}

// 12. bash allowlist: a listed command is handed to the sandbox helper, everything else is denied.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: { read: ["pnpm run typecheck"], write: ["pnpm test"] },
      },
    }),
  })
  const input = { command: "pnpm run typecheck" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  assert.match(
    input.command,
    /^'\/[^']*pi-subagent-extend-helper' '--spec' '\/[^']*spec-[0-9]+\.json' '--' 'bash' '-lc'/,
    "command is rewritten to run under the sandbox helper",
  )
  assert.match(input.command, /'bash' '-lc' 'pnpm run typecheck'$/, "original command preserved as the payload")
  const spec = specOf(input.command)
  assert.deepEqual(spec.read, ["/"], "everything stays readable")
  // The scratch dir plus the baseline devices are writable; nothing from the
  // task scope is, which is the point.
  assert.deepEqual(
    spec.write.filter((path) => !path.startsWith("/dev")),
    ["/tmp"],
    "only the scratch dir is writable by default",
  )
  assert.ok(spec.write.includes("/dev/null"), "the baseline devices stay writable, or 2>/dev/null fails")
  assert.equal(spec.offline, true, "the command is offline by default")
  assert.equal(spec.cwd, workdir, "the command keeps its working directory")

  const other = { command: "pnpm publish" }
  const denied = await h.call("bash", other)
  assert.equal(denied?.block, true, "unlisted command is denied")
  assert.match(denied.reason, /not in the allowlist/)
  assert.equal(other.command, "pnpm publish", "denied command is left untouched")

  const inject = { command: "pnpm test; cat /etc/passwd" }
  const meta = await h.call("bash", inject)
  assert.equal(meta?.block, true, "shell metacharacters are rejected even behind a listed prefix")

  const powershell = await h.call("powershell", { command: "dir" })
  assert.equal(powershell?.block, true, "powershell stays denied")
  h.restore()
  console.log("  ok   bash 白名单命中即放行并交给 helper 沙箱，其余拒绝")
}

// 13. bash without an allowlist stays closed, with a hint about bash.read/bash.write.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } }) })
  const denied = await h.call("bash", { command: "pnpm test" })
  assert.equal(denied?.block, true, "bash is denied when no allowlist is configured")
  assert.match(denied.reason, /bash\.read/, "denial explains how to open it")
  h.restore()
  console.log("  ok   没配 bash 白名单时 bash 仍然关闭，拒绝文案给出开法")
}

// 14. writable + network options, and a missing helper fails closed.
{
  mkdirSync(join(workdir, "src/auth"), { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: { write: ["node harness.mjs"], writable: true, network: true },
      },
    }),
  })
  const input = { command: "node harness.mjs" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.equal(spec.offline, false, "network stays on when requested")
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/src")),
    `the scope dir is writable through Landlock, got: ${spec.write.join(", ")}`,
  )
  h.restore()

  const previous = process.env.PI_SUBAGENT_EXTEND_HELPER
  process.env.PI_SUBAGENT_EXTEND_HELPER = "/nonexistent/pi-subagent-extend-helper"
  const h2 = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], bash: { write: ["node harness.mjs"] } } }),
  })
  const missing = await h2.call("bash", { command: "node harness.mjs" })
  assert.equal(missing?.block, true, "no helper means no bash, even for a listed command")
  assert.match(missing.reason, /build:helper/, "the denial says how to build the helper")
  h2.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENT_EXTEND_HELPER
  else process.env.PI_SUBAGENT_EXTEND_HELPER = previous
  console.log("  ok   writable/network 选项写进 spec；找不到 helper 时 fail closed")
}

// 15. Glob semantics regression: `**` must not be re-rewritten by the `*` rule.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["web/src/**", "lib/**/x.ts", "a?b", "one.ts"] },
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
  const all = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["**"] } }) })
  for (const path of ["README.md", "deep/dir/file.ts", "web/src/x/y.vue"]) {
    assert.equal(await all.call("ls", { path }), undefined, `"**" covers "${path}"`)
  }
  all.restore()
  // A trailing slash is just another way to write the directory.
  const slash = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/auth/"] } }) })
  for (const path of ["src/auth", "src/auth/login.ts", "src/auth/a/b/c.ts"]) {
    assert.equal(await slash.call("ls", { path }), undefined, `"${path}" is inside "src/auth/"`)
  }
  const narrow = await slash.call("ls", { path: "src/other.ts" })
  assert.equal(narrow?.block, true, "trailing-slash scope stays narrow")
  slash.restore()
  console.log("  ok   glob：** 覆盖整棵树，dir/** 与 dir/ 覆盖任意深度，* 不跨层")
}


// 16. bash patterns: literal prefixes and `re:` regexes, both lists authorize.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: { read: ["pnpm run typecheck", "re: ^tsc --noEmit$"], write: ["re: ^pnpm -r (test|build)"] },
      },
    }),
  })
  for (const command of ["pnpm run typecheck", "pnpm run typecheck --pretty false", "tsc --noEmit", "pnpm -r test", "pnpm -r build"]) {
    assert.equal(await h.call("bash", { command }), undefined, `"${command}" is allowed`)
  }
  for (const command of ["pnpm publish", "tsc --noEmit --watch", "pnpm -r lint"]) {
    const denied = await h.call("bash", { command })
    assert.equal(denied?.block, true, `"${command}" is denied`)
  }
  // A regex cannot smuggle a second command: metacharacters are still rejected first.
  const metachars = await h.call("bash", { command: "tsc --noEmit && cat /etc/passwd" })
  assert.equal(metachars?.block, true, "metacharacters win over regex")
  h.restore()
  console.log("  ok   bash 白名单支持字面量前缀与 re: 正则，元字符仍先拒")
}

// 17. Access classification: a write-listed command resets the idle probe, a read-listed one does not.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 1000 },
    readOnly: false,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  // Read-only command: idle window survives the call.
  p.noteBashStart("pnpm run typecheck", "read")
  clock.advance(1000)
  assert.equal(p.atToolBoundary()?.stop, false, "read-only bash does not count as write activity")
  // A write-listed command resets it.
  p.noteBashStart("pnpm test", "write")
  clock.advance(999)
  assert.equal(p.atToolBoundary(), undefined, "write-listed bash resets the idle window")
  p.dispose()
  console.log("  ok   read 列 bash 不重置空转计时器，write 列重置")
}

// 18. Idle probe: warn at the boundary, stop once the grace runs out.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const warned: string[] = []
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: false,
    hooks: { warn: (t: string) => warned.push(t) },
    host: clock.host,
  })
  clock.advance(1000)
  const warn = p.atToolBoundary()
  assert.equal(warn?.stop, false, "first boundary warns")
  assert.match(warn.reason, /criterion: idle/i)
  clock.advance(500)
  assert.equal(p.status().some((l: string) => l.includes("stopped")), true, "the probe is stopped after the grace")
  const after = p.atToolBoundary()
  assert.equal(after?.stop, true, "after the stop every boundary refuses the call")
  assert.match(after.reason, /stops here/, "and says the run is over")
  p.dispose()

  // Read-only tasks are exempt.
  const ro = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  clock.advance(5000)
  assert.equal(ro.atToolBoundary(), undefined, "review tasks are never idle-stopped")
  ro.dispose()
  console.log("  ok   只读空转：边界 warn → 宽限到期停止；只读任务豁免")
}

// 19. Repeat probe: same bash command warns then stops.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  p.noteBashStart("pnpm test", "write")
  p.noteBashStart("pnpm test", "write")
  assert.equal(p.atToolBoundary(), undefined, "below the threshold nothing happens")
  p.noteBashStart("pnpm test", "write")
  assert.equal(p.atToolBoundary()?.stop, false, "the Nth repeat warns")
  const stop = p.noteBashStart("pnpm test", "write")
  assert.equal(stop?.stop, true, "one more repeat stops the run")
  p.dispose()
  console.log("  ok   原地打转：第 3 次 warn，第 4 次停止")
}

// 20. Junk-file probe blocks probe artifacts; deny budget warns then stops.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        maxDenies: 2,
        probe: { forbidWritePatterns: ["_tmp-probe", ".*\\.tmp\\.tsx"] },
      },
    }),
  })
  const junk = await h.call("write", { path: "src/_tmp-probe.ts" })
  assert.equal(junk?.block, true, "probe artifact path is refused")
  assert.match(junk.reason, /junk files/)
  const junk2 = await h.call("write", { path: "src/snapshot.tmp.tsx" })
  assert.equal(junk2?.block, true, "regex pattern also refuses")
  assert.equal(await h.call("write", { path: "src/real.ts" }), undefined, "normal writes pass")

  const first = await h.call("read", { path: "outside/a.ts" })
  assert.equal(first?.block, true, "out-of-scope read denied")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.equal(second?.block, true, "second denial feeds the counter")
  assert.match(second.reason, /in a row/, "the budget warns about a bad grant")
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.equal(third?.block, true, "one more denial stops the run")
  assert.equal(third?.terminate, true, "the stop is hard: every result in the batch terminates")
  assert.match(third.reason, /denial budget/, "the stop names its criterion")
  const after = await h.call("read", { path: "src/real.ts" })
  assert.equal(after?.block, true, "once stopped, later calls are refused")
  assert.equal(after?.terminate, true, "refused terminally, not with a soft latch")
  assert.match(after.reason, /denial budget/, "the reason still names the stop, not this call's verdict")
  assert.ok(!/src\/real\.ts/.test(after.reason), "the stop reason does not pretend this call was out of scope")
  assert.equal(
    await h.call("contact_supervisor", { reason: "need_decision", message: "stuck" }),
    undefined,
    "the rescue channel survives the stop",
  )
  h.restore()
  console.log("  ok   造杂物：探针产物路径被拒；撞权限：计数到上限 warn，再撞 stop")
}

// 21. Repeat probe and deny budget are on by default; time-based probes are not.
{
  const { parseProbeConfig } = await import(join(repo, "src", "probe.ts"))
  const bare = parseProbeConfig(undefined)
  assert.equal(bare.repeatBash, 3, "repeat detection is on without any probe config")
  assert.equal(bare.idleWriteMs, 0, "idle detection stays off until configured")
  assert.equal(bare.successIdleMs, 0, "success-idle stays off until configured")
  assert.equal(parseProbeConfig(false), undefined, "probe: false turns everything off")
  assert.equal(parseProbeConfig({}).idleWriteMs, 6 * 60 * 1000, "an empty probe object opts into the defaults")

  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } },
    }),
  })
  const commands: Outcome[] = []
  for (let i = 0; i < 4; i += 1) commands.push(await h.call("bash", { command: "pnpm run typecheck" }))
  assert.ok(commands.slice(0, 2).every((r) => r === undefined), "the first two repeats run")
  const warned = commands[2]
  assert.ok(warned, "the 3rd identical command is refused")
  assert.match(warned.reason, /spinning/, "the 3rd identical command is refused with a warning")
  assert.equal(warned.block, true, "the warning refuses that call but keeps the run alive")
  const stopped = commands[3]
  assert.ok(stopped, "one more repeat is refused")
  assert.match(stopped.reason, /stops here/, "one more repeat stops the run")
  assert.equal(stopped.terminate, true, "the repeat stop is hard too")
  h.restore()
  console.log("  ok   打转与撞权限默认开启；时间判据需显式配置")
}

// 22. Worktree ergonomics: writablePaths, env injection, and a worktree root that is NOT granted.
{
  const store = join(workdir, "pnpm-store")
  mkdirSync(store, { recursive: true })
  const wt = join(workdir, "wt")
  mkdirSync(join(wt, "web/src"), { recursive: true })
  // A worktree has .git as a file pointing at the real gitdir.
  writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n")
  writeFileSync(join(wt, "mise.toml"), "[tools]\nnode = \"lts\"\n")

  const h = await handler({
    cwd: join(wt, "web"),
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: {
          write: ["pnpm install"],
          writable: true,
          writablePaths: [store],
          env: { FOO: "bar" },
        },
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/wt/web/src")),
    `scope dir inside the worktree is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    !spec.write.some((dir) => dir.endsWith("/wt")),
    `the worktree root itself is not writable (only the write scope is), got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/pnpm-store")),
    `writablePaths are writable, got: ${spec.write.join(", ")}`,
  )
  assert.equal(spec.env.FOO, "bar", "bash.env is injected")
  assert.match(
    spec.env.MISE_STATE_DIR ?? "",
    /mise$/,
    "mise state moves off the read-only root so trust registration is not needed",
  )
  assert.match(spec.env.XDG_RUNTIME_DIR ?? "", /runtime$/, "pnpm's runtime lock dir moves off the read-only root")
  h.restore()
  console.log("  ok   worktree 场景：writablePaths、env 注入、worktree 根不整体授权、mise 信任绕过")
}

// 23. Missing path must not read as "the child walked to the wrong directory".
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
  })
  const write = await h.call("write", { content: "x" })
  assert.equal(write?.block, true, "write without path is refused")
  assert.match(write.reason, /needs a path/, "write says the path argument is missing")
  assert.ok(!/outside the (read )?scope/.test(write.reason), "write does not blame the scope")

  const grep = await h.call("grep", { pattern: "foo" })
  assert.equal(grep?.block, true, "grep without path is refused")
  assert.match(grep.reason, /no path was given/, "grep says no path was given")
  assert.match(grep.reason, /working directory/, "grep says the cwd was used instead")

  // A missing path is a usage error, not a permission problem: it must not
  // count toward the deny budget, or a forgetful child gets stopped as
  // "the parent granted the wrong scope".
  for (let i = 0; i < 5; i += 1) await h.call("write", { content: "x" })
  const after = await h.call("read", { path: "src/real.ts" })
  assert.equal(after, undefined, "repeated missing-path refusals do not exhaust the deny budget")
  h.restore()
  console.log("  ok   缺 path 的拒绝文案说清原因，不误导成走错目录")
}

// 24. /permission reports the writable paths and the pnpm store probe.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: { read: ["pnpm run typecheck"], writable: true, writablePaths: ["/tmp"] },
      },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /Sandbox writable paths/, "the command lists the writable paths")
  assert.match(text, /pnpm store/, "the command probes the pnpm store")
  h.restore()
  console.log("  ok   /permission 列出可写路径并探测 pnpm store")
}

// 25. A denied bash command carries the pnpm store path, so the model can report it.
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] }, maxDenies: 0 },
    }),
  })
  const denied = await h.call("bash", { command: "pnpm install" })
  assert.equal(denied?.block, true, "unlisted command is denied")
  assert.match(denied.reason, /pnpm store/, "the refusal tells the model where the pnpm store is")
  assert.match(denied.reason, /writablePaths/, "and says how the parent would allow it")
  h.restore()
  console.log("  ok   bash 拒绝文案带上 pnpm store 路径")
}

// 26. node_modules is writable when the sandbox is writable; git excludes keep
// dependency directories out of the index.
{
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        bash: { write: ["pnpm install"], writable: true },
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  const spec = specOf(input.command)
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/node_modules")),
    `node_modules is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(
    spec.write.some((dir) => dir.endsWith("/src")),
    `the write scope is writable, got: ${spec.write.join(", ")}`,
  )
  assert.ok(!spec.write.includes(workdir), `the working directory is not writable by default, got: ${spec.write.join(", ")}`)
  assert.equal(spec.env.GIT_CONFIG_COUNT, "1", "git excludes are configured")
  assert.equal(spec.env.GIT_CONFIG_KEY_0, "core.excludesFile", "the exclude key is passed to git")
  assert.match(
    spec.env.GIT_CONFIG_VALUE_0 ?? "",
    /git-excludes$/,
    "the exclude file is readable from the sandbox (read covers all of /)",
  )
  h.restore()
  console.log("  ok   可写沙箱里 node_modules 也可写；git 排除规则防止依赖目录进索引")
}

// 27. The helper gates on kernel support: a kernel below Landlock ABI 7 means no bash.
{
  const fake = join(workdir, "fake-helper")
  writeFileSync(
    fake,
    `#!/bin/sh\necho '{"landlock":{"kernel_abi":3,"required_abi":7,"supported":false,"reason":"kernel Landlock ABI is 3, but ABI 7 is required"},"network_namespace":true,"resolver_sockets":[]}'\nexit 76\n`,
  )
  chmodSync(fake, 0o755)
  const previous = process.env.PI_SUBAGENT_EXTEND_HELPER
  process.env.PI_SUBAGENT_EXTEND_HELPER = fake
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"] } } }),
  })
  const denied = await h.call("bash", { command: "pnpm test" })
  assert.equal(denied?.block, true, "an unsupported kernel denies bash")
  assert.match(denied.reason, /ABI 7 is required/, "the denial names the ABI the plugin needs")
  h.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENT_EXTEND_HELPER
  else process.env.PI_SUBAGENT_EXTEND_HELPER = previous
  console.log("  ok   内核 ABI 不足时 bash 被拒绝，文案说清缺的版本")
}

// 28. A declared profile supplies defaults when the call passes no bindings: file access
// is denied (the role does not know the task's paths) but its bash allowlist still works.
{
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
  const h = await handler({ cwd: proj, profile: "impl" })
  const blocked = await h.call("read", { path: "src/a.ts" })
  assert.equal(blocked?.block, true, "a profile without scope denies file access")
  assert.match(blocked.reason, /profile impl/, "the denial names the profile as the source")
  const input = { command: "mise run test" }
  assert.equal(await h.call("bash", input), undefined, "the profile's allowlist applies with no bindings")
  assert.match(input.command, /--spec/, "allowed commands still run under the sandbox")
  const outside = await h.call("bash", { command: "curl https://example.com" })
  assert.equal(outside?.block, true, "commands outside the profile allowlist are denied")
  h.restore()
  console.log("  ok   profile 默认值：漏传 bindings 时文件全拒、命令只放白名单")
}

// 29. Profile defaults and the call's bindings merge per key.
{
  const proj = join(workdir, "proj-profile")
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
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

// 30. The call's bash replaces the profile's bash as a whole object (documented, so that
// a caller never silently inherits commands it did not write).
{
  const proj = join(workdir, "proj-profile")
  const h = await handler({
    cwd: proj,
    profile: "impl",
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 0, bash: { read: ["pnpm test"] } },
    }),
  })
  const input = { command: "pnpm test" }
  assert.equal(await h.call("bash", input), undefined, "the call's allowlist wins")
  const replaced = await h.call("bash", { command: "mise run test" })
  assert.equal(replaced?.block, true, "the profile's command is replaced, not merged")
  h.restore()
  console.log("  ok   调用方的 bash 整体覆盖 profile 的 bash")
}

// 31. `bash.deny` is a restriction: it unions across layers and no allowlist re-allows it.
{
  const proj = join(workdir, "proj-deny")
  mkdirSync(join(proj, ".pi"), { recursive: true })
  writeFileSync(
    join(proj, ".pi/subagent-bindings.json"),
    JSON.stringify({ default: { bash: { read: ["git diff"], deny: ["git stash", "git checkout"] } } }),
  )
  const h = await handler({
    cwd: proj,
    profile: "review",
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**"],
        maxDenies: 0,
        bash: { write: ["git stash", "git checkout --"] },
      },
    }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(stash?.block, true, "a deny entry cannot be re-allowed by the caller")
  assert.match(stash.reason, /blocked by the project profile/, "the denial says the command is forbidden")
  const checkout = await h.call("bash", { command: "git checkout -- src/a.ts" })
  assert.equal(checkout?.block, true, "deny entries use the same prefix matching")
  h.restore()

  // Without a call-side bash the profile's own allowlist survives, so its read entries work.
  const plain = await handler({ cwd: proj, profile: "review" })
  const diff = await plain.call("bash", { command: "git diff" })
  assert.equal(diff, undefined, "the profile's own read entry passes when the call sends no bash")
  const plainStash = await plain.call("bash", { command: "git stash" })
  assert.equal(plainStash?.block, true, "deny still applies")

  const messages: string[] = []
  await plain.commands.permission.handler("", { cwd: proj, ui: { notify: (m: string) => messages.push(m) } })
  assert.match(messages.join("\n"), /bash deny \(cannot be lifted\)/, "/permission shows the non-overridable list")
  plain.restore()
  console.log("  ok   bash.deny 不可被 bindings 放宽（含 /permission 可见）")
}

// 32. A declared profile that cannot be resolved fails closed instead of running open.
{
  const proj = join(workdir, "proj-missing")
  mkdirSync(proj, { recursive: true })
  const h = await handler({ cwd: proj, profile: "impl" })
  const blocked = await h.call("read", { path: "a.ts" })
  assert.equal(blocked?.block, true, "a broken profile denies everything")
  assert.match(blocked.reason, /not found/, "the denial says the profile file is missing")
  const brokenBash = await h.call("bash", { command: "ls" })
  assert.equal(brokenBash?.block, true, "bash is refused too")
  h.restore()
  console.log("  ok   profile 缺失时失败关闭，不是退回不设限")
}

// 33. 撞权限只统计「父代理放宽授权或调整设置能解决」的拒绝。
//     用法错误（元字符、缺 path）与硬规则（永久不开放的工具、profile 禁令）不消耗预算，
//     否则一次参数写错就能把长任务提前判死（现场：4 次计数里 1 次是 `cd X && git status`）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 2, bash: { read: ["pnpm run typecheck"] } },
    }),
  })
  const counted = (reason: string): boolean => /in a row|denial budget/.test(reason)

  // (a) 用法错误：shell 元字符，连撞 4 次也不该推进计数。
  for (let i = 0; i < 4; i += 1) {
    const r = await h.call("bash", { command: `pnpm run typecheck && echo ${i}` })
    assert.equal(r?.block, true, "a metacharacter command is refused")
    assert.equal(counted(r.reason), false, `metacharacters do not feed the counter (call ${i + 1})`)
  }

  // (b) 硬规则：范围放多宽都不会开放的工具。
  for (let i = 0; i < 3; i += 1) {
    const r = await h.call("powershell", { command: "dir" })
    assert.equal(r?.block, true, "powershell is refused")
    assert.match(r.reason, /never available/i, "the message says it is not a grant the parent can widen")
    assert.equal(counted(r.reason), false, "a never-available tool does not feed the counter")
  }

  // (c) 缺 path：用法错误，同样不计。
  const noPath = await h.call("grep", { pattern: "x" })
  assert.equal(noPath?.block, true, "pathless grep at an out-of-scope cwd is refused")
  assert.equal(counted(noPath.reason), false, "a usage error does not feed the counter")

  // (d) 真正的撞权限：上面一堆拒绝之后，计数仍从 0 开始。
  const first = await h.call("read", { path: "outside/a.ts" })
  assert.ok(first, "out-of-scope read is refused")
  assert.equal(counted(first.reason), false, "the budget is still untouched by the usage errors before it")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.ok(second, "the second refusal is refused")
  assert.match(second.reason, /in a row/, "the second counted refusal warns at maxDenies 2")
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.ok(third, "the third refusal is refused")
  assert.equal(third.terminate, true, "the third stops the run")
  assert.match(third.reason, /denial budget/)
  h.restore()
  console.log("  ok   撞权限只计授权类：用法错误与硬规则不消耗预算")
}

// 34. 拿仓库根当路径时，文案要说清「这是仓库根」，而不是让人以为 scope 有错。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } }) })
  const rootish = await h.call("grep", { pattern: "x", path: "." })
  assert.equal(rootish?.block, true, "the repository root is outside a src-only scope")
  assert.match(rootish.reason, /repository root/, "the message names what was given")
  assert.match(rootish.reason, /widen the scope/, "and says the parent can widen it")
  h.restore()
  console.log("  ok   仓库根当路径时说清缘由，不装成 scope 写法有误")
}

// 35. 撞权限的缺省预算：5 次计数拒绝才 warn，第 6 次才硬停。
//     缺省值本身就是决策（硬停判早一次就丢整轮任务），所以用行为钉住它。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } }) })
  const verdicts: Outcome[] = []
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    verdicts.push(await h.call("read", { path: `outside/${name}.ts` }))
  }
  const notes = verdicts.map((v) => v !== undefined && /in a row|denial budget/.test(v.reason))
  assert.deepEqual(
    notes,
    [false, false, false, false, true, true],
    "default budget of five: four silent refusals, a warning at the fifth, a stop at the sixth",
  )
  const fifth = verdicts[4]
  assert.ok(fifth, "the fifth refusal is refused")
  assert.equal(fifth.terminate, undefined, "the fifth only warns")
  assert.match(fifth.reason, /contact_supervisor/, "the warning names the escalation channel")
  const sixth = verdicts[5]
  assert.ok(sixth, "the sixth refusal is refused")
  assert.equal(sixth.terminate, true, "the sixth ends the run")
  assert.match(sixth.reason, /for the parent session/i, "the stop text is addressed to the parent, who can act on it")
  h.restore()
  console.log("  ok   撞权限缺省 5：第 5 次 warn（点名求援），第 6 次硬停")
}

// 36. linked worktree：git 的索引与 ref 在主仓 .git 里，那里必须可写。
//     Lab 实测（Lab/git-worktree/probe.sh）：只给 worktree 时 `git add`/`commit`/`stash`/
//     `switch -c` 全失败在 <common>/worktrees/<id>/index.lock 或 <common>/refs 上，
//     加上 common dir 才通。
{
  const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  if (!gitOk) {
    console.log("  skip  linked worktree（环境里没有 git）")
  } else {
    const repoDir = join(workdir, "gitrepo")
    const wtDir = join(workdir, "gitwt")
    mkdirSync(repoDir, { recursive: true })
    const gitEnv = {
      ...process.env,
      HOME: workdir,
      GIT_CONFIG_GLOBAL: join(workdir, "gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }
    const git = (...args: string[]): string => {
      const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] })
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`)
      return r.stdout.trim()
    }
    git("init", "-q", "-b", "main")
    writeFileSync(join(repoDir, "a.txt"), "one\n")
    git("add", "-A")
    git("commit", "-qm", "init")
    git("worktree", "add", "-q", wtDir, "-b", "wtbranch")
    let commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: wtDir, encoding: "utf8", env: gitEnv }).stdout.trim()
    if (!commonDir.startsWith("/")) commonDir = join(wtDir, commonDir)

    const bindings = (writable: boolean): string =>
      JSON.stringify({
        "pi-subagent-extend/1": { scope: ["**"], bash: { [writable ? "write" : "read"]: ["git status"], writable } },
      })

    const h = await handler({ cwd: wtDir, bindings: bindings(true) })
    const input = { command: "git status" }
    assert.equal(await h.call("bash", input), undefined, "a writable sandbox passes the listed command")
    const spec = specOf(input.command)
    assert.ok(
      spec.write.includes(commonDir),
      `the linked worktree's common git dir is writable, got: ${spec.write.join(", ")}`,
    )
    assert.ok(!spec.write.some((d) => d === join(repoDir, "a.txt")), "the main working tree is not granted")
    h.restore()

    // 不只是看 spec：让 helper 真的执行，文件必须真的进索引（修复前会失败在 index.lock）。
    writeFileSync(join(wtDir, "b.txt"), "two\n")
    const live = await handler({
      cwd: wtDir,
      bindings: JSON.stringify({
        "pi-subagent-extend/1": { scope: ["**"], bash: { write: ["git add b.txt"], writable: true } },
      }),
    })
    const liveInput = { command: "git add b.txt" }
    assert.equal(await live.call("bash", liveInput), undefined, "git add is allowlisted")
    if (liveSandbox) {
      const exec = spawnSync("/bin/sh", ["-c", liveInput.command], { cwd: wtDir, encoding: "utf8", env: gitEnv })
      assert.equal(exec.status, 0, `sandboxed git add failed: ${exec.stderr}`)
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: wtDir, encoding: "utf8", env: gitEnv })
      assert.match(staged.stdout, /b\.txt/, "the file is really staged inside the sandbox")
    } else {
      console.log("  skip  live git add: no real sandbox on this kernel")
    }
    live.restore()

    // 只读沙箱：父代理明确选了只读树，不因为「git 需要一个可写索引」偷偷放开主仓 .git。
    const ro = await handler({ cwd: wtDir, bindings: bindings(false) })
    const roInput = { command: "git status" }
    assert.equal(await ro.call("bash", roInput), undefined, "read-only passes the listed command")
    assert.equal(
      specOf(roInput.command).write.includes(commonDir),
      false,
      "a read-only sandbox does not get the common git dir",
    )
    ro.restore()

    // 普通仓库：cwd 不再整体授权，所以显式给 <repo>/.git（git add / commit 要写索引与 ref），
    // 但仓库根本身不给 —— 那等于把整个 checkout 打开。
    const plain = await handler({ cwd: repoDir, bindings: bindings(true) })
    const plainInput = { command: "git status" }
    assert.equal(await plain.call("bash", plainInput), undefined, "plain repo passes too")
    assert.equal(
      specOf(plainInput.command).write.some((d) => d.endsWith("/.git")),
      true,
      "a normal repository gets its .git granted",
    )
    plain.restore()
    console.log("  ok   linked worktree 的 common dir 可写；只读沙箱不给；普通仓只给 .git")
  }
}

// 37. 交接单提示（前台）：子代理 worktree 单返回 handoff 路径时，就地补「看哪个键」。
//     pi-subagents 捕获补丁后会删掉工作树与分支，父代理只拿到一行路径；
//     不点明 children[].patch 等于让父代理去猜。
{
  const h = await handler()
  const path = "/tmp/pi-subagents/async-subagent-runs/run-1/handoff.json"
  const out = await h.result("subagent", [
    { type: "text", text: `Worktree handoff: ${path} (1 children, 1 changed patches, cleanup complete)` },
  ])
  assert.ok(out, "the tool result is returned")
  assert.ok(Array.isArray(out.content), "the result content is patched")
  assert.equal(out.content.length, 2, "one text part is appended")
  const hint = out.content[1].text
  assert.match(hint, /\[worktree handoff\]/, "the hint is marked so it can be recognised")
  assert.ok(hint.includes(path), "the hint names the manifest path")
  assert.match(hint, /children\[\]\.patch/, "the hint names the key to read")
  assert.match(hint, /diffStat/, "the hint names the volume signal")
  assert.match(hint, /SHA quoted by the child no longer resolves/, "the hint says the child's SHA is dead")
  assert.match(hint, /Nothing was applied/, "the hint says nothing reached this checkout")
  assert.match(hint, /tasks\[\]\.reason/, "the hint says where the preserve reason lives")

  // 幂等：同一条消息再跑一次（tool_result 与 message_end 可能都命中）不应重复追加。
  const again = await h.result("subagent", out.content)
  assert.equal(again, undefined, "an already-annotated result is left alone")

  // 交接单写失败时没有路径，但工作树与分支是被保留下来的 —— 父代理必须知道这一点，
  // 否则会以为「没收到交接单 = 子代理什么都没做」。
  const unavailable = await h.result("subagent", [
    { type: "text", text: "Worktree handoff unavailable: EACCES" },
  ])
  const unavailableHint = unavailable?.content?.at(-1)?.text ?? ""
  assert.match(unavailableHint, /\[worktree handoff\]/, "the unavailable case is annotated too")
  assert.match(unavailableHint, /not deleted/, "it says the worktree was kept")
  assert.match(unavailableHint, /git worktree list/, "it says how to find it")
  assert.equal(unavailableHint.includes("children[].patch"), false, "it does not promise a manifest key")

  // 同一条消息再跑一次也不重复追加。
  assert.ok(unavailable, "the unavailable result is returned")
  assert.equal(
    await h.result("subagent", unavailable.content),
    undefined,
    "an already-annotated unavailable result is left alone",
  )

  // 普通工具结果、普通子代理结果（没有 worktree）都不动。
  assert.equal(await h.result("bash", [{ type: "text", text: "ok" }]), undefined, "other tools are untouched")
  assert.equal(
    await h.result("subagent", [{ type: "text", text: "child finished, no worktree" }]),
    undefined,
    "a subagent result without a worktree gets no hint",
  )
  h.restore()
  console.log("  ok   交接单提示（前台）：补出该看的键与失效的分支/SHA，幂等且不误伤")
}

// 38. 交接单提示（后台）：async 完成通知是注入到会话里的消息，实测 message_end 不为它
//     触发，所以走 context —— 每次 LLM 调用前拿到完整消息表，就地补一句。
{
  const h = await handler()
  const path = "/tmp/pi-subagents/async-subagent-runs/run-2/handoff.json"
  const injected = { role: "user", content: [{ type: "text", text: `run finished.\n\nParallel handoff: ${path}` }] }
  const out = await h.context([{ role: "system", content: "sys" }, injected])
  assert.ok(out, "the message list is replaced")
  const injectedContent = out.messages[1]?.content
  assert.ok(Array.isArray(injectedContent), "the injected notification keeps its content parts")
  const injectedParts = Array.isArray(injectedContent) ? injectedContent : []
  const injectedText = injectedParts.at(-1)?.text ?? ""
  assert.match(injectedText, /\[worktree handoff\]/, "the injected notification gets the hint")
  assert.ok(injectedText.includes(path), "and carries the manifest path")
  assert.equal(out.messages[0]?.content, "sys", "other messages pass through untouched")

  // 字符串形态的 content 也要能补。
  const asString = await h.context([{ role: "custom", customType: "subagent-notify", content: `Parallel handoff: ${path}` }])
  assert.ok(asString, "a string body is annotated too")
  assert.equal(typeof asString.messages?.[0]?.content, "string", "a string body stays a string")
  assert.match(String(asString.messages[0]?.content), /children\[\]\.patch/)

  // 没有交接单行的消息、以及 assistant 角色都不动。
  assert.equal(
    await h.context([{ role: "user", content: [{ type: "text", text: "just a prompt" }] }]),
    undefined,
    "no handoff line, no patch",
  )
  assert.equal(
    await h.context([{ role: "assistant", content: [{ type: "text", text: `Parallel handoff: ${path}` }] }]),
    undefined,
    "assistant messages are not annotated",
  )

  // 幂等：已经带标记的消息不再追加。
  assert.equal(await h.context(out.messages as unknown[]), undefined, "an already-annotated message is left alone")
  h.restore()
  console.log("  ok   交接单提示（后台）：context 里补上注入的通知，其它消息不动")
}

// 37. 离线沙箱里的网络失败要就地说明「主代理没授权」，否则子代理会当成机器坏了，
//     换 registry / 加 timeout 反复重试，把轮次全浪费掉。
{
  const netprobe = join(workdir, "netprobe.sh")
  writeFileSync(
    netprobe,
    [
      "#!/bin/sh",
      "node -e 'const s=require(\"net\").connect({host:\"1.1.1.1\",port:80});",
      "s.on(\"error\",e=>{console.error(e.code+\": \"+e.message);process.exit(1)});",
      "setTimeout(()=>process.exit(2),3000)'",
      "",
    ].join("\n"),
  )

  const offlineHandler = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["**"], bash: { read: ["sh netprobe.sh"] } } }),
  })
  const input = { command: "sh netprobe.sh" }
  assert.equal(await offlineHandler.call("bash", input), undefined, "the probe is allowlisted")
  assert.equal(specOf(input.command).offline, true, "bash is offline by default")

  if (liveSandbox) {
    const exec = spawnSync("/bin/sh", ["-c", input.command], { cwd: workdir, encoding: "utf8" })
    const output = `${exec.stdout}${exec.stderr}`
    // 建得出网络命名空间时报 ENETUNREACH；建不出来时由 Landlock 兜底，报连接 EACCES。
    assert.match(output, /ENETUNREACH|EACCES/u, "the command really fails on the network")

    const noted = await offlineHandler.result("bash", output)
    // 字符串 content 会被拼成字符串，parts 数组则多一个 text part；两种形状都取尾部。
    const note = typeof noted?.content === "string" ? noted.content : (noted?.content?.at(-1)?.text ?? "")
    assert.match(note, /\[sandbox\]/u, "the failure is annotated so it can be recognised")
    assert.match(note, /off per the parent/u, "it names the cause")
    assert.match(note, /not a broken machine/u, "it says this is not an environment fault")
    assert.match(note, /contact_supervisor/u, "it says which channel can widen the grant")
    assert.match(note, /"network": true/u, "it names what the parent would have to grant")

    // 同一份结果再走一次不重复追加。
    assert.ok(noted, "the network failure is annotated")
    assert.equal(await offlineHandler.result("bash", noted.content), undefined, "already annotated results are left alone")
  } else {
    console.log("  skip  live network probe: no real sandbox on this kernel")
  }

  // 本地连接被拒在沙箱里是正常测试结果，不能补这句提示（loopback 是通的）。
  assert.equal(
    await offlineHandler.result("bash", "Error: connect ECONNREFUSED 127.0.0.1:3000"),
    undefined,
    "ECONNREFUSED is a normal local result, not a permission problem",
  )
  assert.equal(await offlineHandler.result("bash", "FAIL src/a.test.ts > adds 1+1"), undefined, "unrelated failures are untouched")
  assert.equal(await offlineHandler.result("read", "ENETUNREACH"), undefined, "only bash results are annotated")
  offlineHandler.restore()

  // 开了网络的会话不补：那时网络失败确实是环境问题。
  const onlineHandler = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["**"], bash: { read: ["sh netprobe.sh"], network: true } },
    }),
  })
  assert.equal(
    await onlineHandler.result("bash", "Error: connect ENETUNREACH 1.1.1.1:80"),
    undefined,
    "an online sandbox is not annotated",
  )
  onlineHandler.restore()
  console.log("  ok   离线沙箱的网络失败被标注为「主代理未授权」，且不误报本地拒绝与在线会话")
}

// 38. 写越界：结果要说明「这个路径不在主代理给的写授权里」，而不是让子代理
//     以为文件系统坏了、去换目录或加 sudo。判据是路径 vs spec.write，不是文案猜。
{
  // 注意：spec.write 天然包含 tmpdir() 与 cwd，所以「授权外」的路径不能用 /tmp 下的。
  const outsidePath = `/var/tmp/pi-extend-write-${process.pid}.txt`
  const insidePath = join(workdir, "inside.txt")
  const script = join(workdir, "write.sh")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "node -e '",
      'const fs=require("fs");',
      'try { fs.writeFileSync(process.argv[1],"x"); console.log("wrote"); }',
      'catch (e) { console.error(e.code+": permission denied, open "+process.argv[1]); process.exit(1); }',
      "' \"$1\"",
      "",
    ].join("\n"),
  )

  const bindings = JSON.stringify({
    "pi-subagent-extend/1": { scope: ["**"], bash: { write: ["sh write.sh"], writable: true } },
  })

  // 授权外：命令真的被内核拒掉。
  const h = await handler({ bindings })
  const outInput = { command: `sh write.sh ${outsidePath}` }
  assert.equal(await h.call("bash", outInput), undefined, "the writer script is allowlisted")
  const outSpec = specOf(outInput.command)
  assert.equal(outSpec.write.includes(outsidePath), false, "the outside path is not granted")
  if (liveSandbox) {
    const outExec = spawnSync("/bin/sh", ["-c", outInput.command], { cwd: workdir, encoding: "utf8" })
    assert.match(`${outExec.stdout}${outExec.stderr}`, /EACCES|Permission denied/u, "the write really is refused")
    assert.equal(existsSync(outsidePath), false, "nothing was written outside the grant")

    const outNote = await h.result("bash", `${outExec.stdout}${outExec.stderr}`)
    const note = typeof outNote?.content === "string" ? outNote.content : (outNote?.content?.at(-1)?.text ?? "")
    assert.match(note, /\[sandbox\]/u, "the refusal is annotated")
    assert.ok(note.includes(outsidePath), "the note names the path that was refused")
    assert.match(note, /writablePaths/u, "the note says what the parent would have to grant")
    assert.match(note, /contact_supervisor/u, "the note names the channel")
    assert.equal(await h.result("bash", note), undefined, "already annotated results are left alone")
  } else {
    console.log("  skip  live write refusal: no real sandbox on this kernel")
  }

  // 授权内：同样的脚本写得进去，且不该有任何提示。
  const inInput = { command: `sh write.sh ${insidePath}` }
  assert.equal(await h.call("bash", inInput), undefined, "the writer script is allowlisted")
  if (liveSandbox) {
    const inExec = spawnSync("/bin/sh", ["-c", inInput.command], { cwd: workdir, encoding: "utf8" })
    assert.equal(inExec.status, 0, `writing inside the grant works: ${inExec.stderr}`)
    assert.ok(existsSync(insidePath), "the file really landed")
    assert.equal(await h.result("bash", `${inExec.stdout}${inExec.stderr}`), undefined, "a granted write is not annotated")
  }

  // 宿主权限被拒不能归因到沙箱：我们自己也读不到那个文件时，保持沉默。
  await h.call("bash", { command: `sh write.sh ${outsidePath}` })
  assert.equal(
    await h.result("bash", "cat: /etc/shadow: Permission denied"),
    undefined,
    "a host-permission refusal is not blamed on the sandbox",
  )
  // 文案里有权限拒绝但路径就在授权内 → 也不是越界写。
  await h.call("bash", { command: `sh write.sh ${outsidePath}` })
  assert.equal(
    await h.result("bash", `EACCES: permission denied, open '${insidePath}'`),
    undefined,
    "a refusal on a granted path is not reported as out of scope",
  )
  h.restore()
  console.log("  ok   写越界被标注为授权问题；授权内与宿主权限被拒都不误报")
}

// 41. writeScope: read the whole task scope, write only one directory.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src", "lib", ".pi/reports"], writeScope: [".pi/reports"], maxDenies: 0, maxWriteDenies: 0 },
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
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await h.call("write", { path: "src/a.ts", content: "x" }), undefined, "without writeScope, in-scope writes pass")
  h.restore()

  const empty = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], writeScope: [], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await empty.call("read", { path: "src/a.ts" }), undefined, "reads are unaffected by an empty writeScope")
  const blocked = await empty.call("write", { path: "src/a.ts", content: "x" })
  assert.equal(blocked?.block, true, "an empty writeScope refuses every write")
  assert.match(blocked.reason, /readable but not writable/, "and says it is a write refusal, not an unreadable path")
  empty.restore()
  console.log("  ok   writeScope 缺省等于 scope；空数组等于只读")
}

// 43. readOnly wins over writeScope.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], writeScope: ["src/**"], readOnly: true } }),
  })
  const edit = await h.call("edit", { path: "src/a.ts", content: "x" })
  assert.equal(edit?.block, true, "readOnly refuses the write even with a matching writeScope")
  assert.match(edit.reason, /read-only/, "and says the session is read-only")
  h.restore()
  console.log("  ok   readOnly 压过 writeScope")
}

// 44. Write refusals have their own budget: misuse must not become a grant error.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], writeScope: [".pi/reports"], maxDenies: 5, maxWriteDenies: 2 },
    }),
  })
  const first = await h.call("write", { path: "src/a.ts", content: "x" })
  assert.ok(first, "the first write refusal blocks")
  assert.equal(first.block, true, "the first write refusal blocks")
  assert.equal(first.terminate, undefined, "and does not stop the run")
  const second = await h.call("write", { path: "src/b.ts", content: "x" })
  assert.ok(second, "the second write refusal blocks")
  assert.match(second.reason, /one more refusal ends the run/, "the second write refusal warns")
  assert.match(second.reason, /write scope does not cover/, "the warning is about the write scope, not the grant")
  assert.match(second.reason, /report/, "and repeats the way out: deliver a report")
  assert.equal(second.terminate, undefined, "still no stop at the limit")

  // 读拒与写拒各算各的：一次范围外读不应把写预算推过阈值。
  const readDenial = await h.call("read", { path: "docs/x.md" })
  assert.ok(readDenial, "an out-of-scope read is refused")
  assert.equal(readDenial.block, true, "an out-of-scope read is refused")
  assert.doesNotMatch(readDenial.reason, /one more ends the run/, "the read refusal uses the other budget")
  assert.doesNotMatch(readDenial.reason, /write scope does not cover/, "and it is not described as a write problem")

  const third = await h.call("write", { path: "src/c.ts", content: "x" })
  assert.equal(third?.block, true, "the third write refusal blocks")
  assert.equal(third.terminate, true, "and hard-stops the run")
  h.restore()
  console.log("  ok   写拒单独计数：第 2 次警告、第 3 次硬停，不被读拒推高")
}

// 45. dir/** really covers files directly under dir (the shape a report suspected).
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["lib/router/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await h.call("write", { path: "lib/router/stream-limits.ts", content: "x" }), undefined, "a file directly under dir/** is writable")
  assert.equal(await h.call("read", { path: "lib/router" }), undefined, "the directory itself is in scope")
  const out = await h.call("read", { path: "lib/other.ts" })
  assert.equal(out?.block, true, "a sibling of the granted directory is refused")
  assert.match(out.reason, /"lib\/other\.ts" is outside the read scope/, "the refusal names the full path, not a truncated parent")
  h.restore()
  console.log("  ok   dir/** 覆盖其下文件；拒绝文案给全路径")
}

// 46. bash writable dirs follow writeScope, not the read scope.
{
  // 两个目录都要真实存在：writableDirs 只收录存在的目录，不存在的话「不给」不算证据。
  mkdirSync(join(workdir, "src"), { recursive: true })
  mkdirSync(join(workdir, "lib"), { recursive: true })
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagent-extend/1": {
        scope: ["src/**", "lib/**"],
        writeScope: ["src/**"],
        bash: { write: ["pnpm install"], writable: true },
      },
    }),
  })
  const input = { command: "pnpm install" }
  assert.equal(await h.call("bash", input), undefined, "the listed command passes")
  const spec = specOf(input.command)
  assert.ok(spec.write.some((dir) => dir.endsWith("/src")), `the write scope is writable, got: ${spec.write.join(", ")}`)
  assert.ok(!spec.write.some((dir) => dir.endsWith("/lib")), `a readable-only directory is not writable, got: ${spec.write.join(", ")}`)
  assert.ok(!spec.write.includes(workdir), `the working directory is not granted wholesale, got: ${spec.write.join(", ")}`)
  h.restore()
  console.log("  ok   bash 可写面跟随 writeScope，读范围不自动变可写")
}

// 47. Build/test artefact directories are derived from what the project uses.
{
  const bindings = (extra: Record<string, unknown>): string =>
    JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"], writable: true, ...extra } } })
  const grantedIn = (spec: SandboxSpec, ...parts: string[]): boolean => spec.write.some((d: string) => d.endsWith(`/${join(...parts)}`))

  // A Node project: the toolchain is recognised, but its output directory is not
  // created — only granted when the project already has one.
  const nodeRepo = join(workdir, "detect-node")
  mkdirSync(join(nodeRepo, "src"), { recursive: true })
  writeFileSync(join(nodeRepo, "package.json"), '{"name":"x"}\n')
  mkdirSync(join(nodeRepo, "coverage"), { recursive: true })
  writeFileSync(join(nodeRepo, "coverage", "l.txt"), "x\n")

  const h = await handler({ cwd: nodeRepo, bindings: bindings({}) })
  const input = { command: "pnpm test" }
  assert.equal(await h.call("bash", input), undefined, "the listed command passes")
  const spec = specOf(input.command)
  assert.ok(grantedIn(spec, "coverage"), `an existing artefact directory is writable, got: ${spec.write.join(", ")}`)
  assert.ok(!grantedIn(spec, "dist"), "a directory the project does not have is not invented")
  assert.equal(existsSync(join(nodeRepo, "dist")), false, "and nothing is created")
  h.restore()

  // A Rust project: target/ is that toolchain's main output, so it is created —
  // otherwise the first cargo test fails.
  const rustRepo = join(workdir, "detect-rust")
  mkdirSync(join(rustRepo, "src"), { recursive: true })
  writeFileSync(join(rustRepo, "Cargo.toml"), '[package]\nname="x"\n')
  const rust = await handler({ cwd: rustRepo, bindings: bindings({}) })
  const rustInput = { command: "pnpm test" }
  assert.equal(await rust.call("bash", rustInput), undefined, "the command passes in the rust repo")
  assert.ok(grantedIn(specOf(rustInput.command), "target"), "target/ is granted from Cargo.toml")
  assert.ok(existsSync(join(rustRepo, "target")), "and created, so the first run works")
  rust.restore()

  // A monorepo: a manifest one level down is found, and its directories resolve
  // next to that manifest rather than at the repository root.
  const mono = join(workdir, "detect-mono")
  mkdirSync(join(mono, "packages", "web", "coverage"), { recursive: true })
  writeFileSync(join(mono, "packages", "web", "package.json"), '{"name":"web"}\n')
  const mh = await handler({ cwd: mono, bindings: bindings({}) })
  const mInput = { command: "pnpm test" }
  assert.equal(await mh.call("bash", mInput), undefined, "the command passes in the monorepo")
  assert.ok(
    grantedIn(specOf(mInput.command), "packages", "web", "coverage"),
    `a nested project's artefacts are granted next to its manifest, got: ${specOf(mInput.command).write.join(", ")}`,
  )
  mh.restore()

  // Explicit override: false turns detection off, an array appends and creates.
  const off = await handler({ cwd: nodeRepo, bindings: bindings({ scratchPaths: false }) })
  const offInput = { command: "pnpm test" }
  assert.equal(await off.call("bash", offInput), undefined, "the command still passes")
  assert.ok(
    !specOf(offInput.command).write.some((d) => d.endsWith("/coverage")),
    `scratchPaths: false disables detection, got: ${specOf(offInput.command).write.join(", ")}`,
  )
  off.restore()

  const extra = await handler({ cwd: nodeRepo, bindings: bindings({ scratchPaths: ["out/generated"] }) })
  const extraInput = { command: "pnpm test" }
  assert.equal(await extra.call("bash", extraInput), undefined, "the command passes with extras")
  const extraSpec = specOf(extraInput.command)
  assert.ok(grantedIn(extraSpec, "out", "generated"), "an explicit scratch path is granted on top of detection")
  assert.ok(grantedIn(extraSpec, "coverage"), "detection still applies alongside it")
  assert.ok(existsSync(join(nodeRepo, "out", "generated")), "and is created")
  extra.restore()
  console.log("  ok   产物目录按项目清单探测；可显式关闭或追加")
}

// 48. /permission reports the artefact directories without creating them.
{
  const repo = join(workdir, "probeonly")
  mkdirSync(join(repo, "src"), { recursive: true })
  writeFileSync(join(repo, "Cargo.toml"), '[package]\nname="x"\n')
  writeFileSync(join(repo, "src", "a.ts"), "x\n")

  const h = await handler({
    cwd: repo,
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["src/**"], bash: { read: ["pnpm test"], writable: true } },
    }),
  })
  const notified: string[] = []
  await h.commands["permission"].handler("", { cwd: repo, ui: { notify: (m: string) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /target/, "the command lists the artefact directory")
  assert.equal(existsSync(join(repo, "target")), false, "but looking at the policy does not create it")
  h.restore()
  console.log("  ok   /permission 只报告产物目录，不创建")
}

// 50b. 软链是唯一能绕过词法比较的向量：`src/link` 指到树外时，词法上它仍在 `src/` 之下。
//      edit/write 在父进程里跑，没有 Landlock 兜底，所以判定必须看真实路径。
{
  const dir = join(workdir, "symlink-escape")
  const outside = join(workdir, "symlink-outside")   // workdir 之内、但不在 dir 之内
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(dir, "src", "link"))

  const narrow = await handler({ cwd: dir, bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], writeScope: ["src/**"] } }) })
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
  const whole = await handler({ cwd: dir, bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["."] } }) })
  const escaped = await whole.call("write", { path: "src/link/evil2.txt", content: "x" })
  assert.equal(escaped?.block, true, "a whole-tree scope still does not follow a symlink out of the tree")
  whole.restore()
  console.log("  ok   软链指到树外被真实路径判定拦下；树内软链仍放行")
}

// 52. 撞权限判据是「连续」而不是「累计」：文档、skill 与拒绝文案都这么写。
//      中间有一次放行的调用就重新计数，否则早期的一次误判会在几十轮之后把任务判死。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 2, maxWriteDenies: 2 } }) })
  mkdirSync(join(workdir, "src"), { recursive: true })
  writeFileSync(join(workdir, "src", "ok.ts"), "export {}\n")

  const first = await h.call("read", { path: "outside/a.ts" })
  assert.equal(first?.block, true, "the first refusal blocks")
  assert.equal(await h.call("read", { path: "src/ok.ts" }), undefined, "an allowed call in between")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.equal(second?.block, true, "the refusal after an allowed call blocks")
  assert.doesNotMatch(second.reason, /in a row/, "it is back to refusal 1, below the warning threshold")
  assert.equal(second.terminate, undefined, "an allowed call reset the counter: no warning, no stop")

  // 连续两次才到 warn，第三次才停 —— 和之前一样。
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.match(third?.reason ?? "", /in a row/, "two in a row now warns")
  assert.equal(third?.terminate, undefined, "the warning still does not stop")
  const fourth = await h.call("read", { path: "outside/d.ts" })
  assert.equal(fourth?.terminate, true, "three in a row ends the run")
  h.restore()
  console.log("  ok   撞权限按「连续」计：中间放行一次就重新计数")
}

// 53. 绑定写坏时不能变成「全拒但永不停止」：每个调用都被拒却永远不计满，子代理会磨到超时。
//      预算改成缺省值之后，拒几次就硬停，真实原因留在拒绝文案里。
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": {} }) })
  const first = await h.call("read", { path: "src/a.ts" })
  assert.equal(first?.block, true, "a broken binding refuses everything")
  assert.match(first.reason, /scope is missing/i, "and the reason names what is wrong with the binding")
  assert.equal(first.terminate, undefined, "the first refusal does not stop the run")

  let last: Outcome = first
  for (let i = 0; i < 5; i += 1) last = await h.call("read", { path: `src/${i}.ts` })
  assert.equal(last?.terminate, true, "a broken binding hard-stops instead of looping forever")
  h.restore()
  console.log("  ok   绑定写坏：拒绝文案点名原因，且会硬停而不是无限重试")
}

// 49. A real toolchain can write its own artefacts through the rewritten command.
// Guards: a real sandbox on this kernel, and the toolchain installed.
{
  const liveSandbox = described?.landlock?.supported === true
  const have = (bin: string): boolean => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }

  const runLive = async (dir: string, bindings: string, command: string): Promise<import("node:child_process").SpawnSyncReturns<string> | undefined> => {
    const h = await handler({ cwd: dir, bindings })
    const input = { command }
    assert.equal(await h.call("bash", input), undefined, `${command} is allowlisted`)
    const rewritten = input.command
    h.restore()
    if (!liveSandbox) return undefined
    return spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf8", env: gitEnv })
  }

  // Rust: `target/` does not exist yet, so the extension has to create and grant it.
  if (have("cargo")) {
    const dir = join(workdir, "live-rust")
    mkdirSync(join(dir, "src"), { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: dir, env: gitEnv })
    writeFileSync(join(dir, ".gitignore"), "target/\n")
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\nedition="2021"\n')
    writeFileSync(join(dir, "src", "lib.rs"), "pub fn add(a:i32,b:i32)->i32{a+b}\n#[test]\nfn t(){assert_eq!(add(1,2),3);}\n")
    spawnSync("git", ["add", "-A"], { cwd: dir, env: gitEnv })
    const out = await runLive(
      dir,
      JSON.stringify({
        "pi-subagent-extend/1": { scope: ["src/**"], bash: { write: ["cargo test"], writable: true } },
      }),
      "cargo test --offline",
    )
    if (out) {
      assert.equal(out.status, 0, `sandboxed cargo test failed: ${out.stderr}`)
      assert.ok(existsSync(join(dir, "target")), "cargo wrote target/ inside the sandbox")
    } else {
      console.log("  skip  live cargo test: no real sandbox on this kernel")
    }
  }

  // Go: writes nothing into the project, so this only proves a real toolchain runs
  // under the sandbox at all. The cache redirect itself is pinned by the spec
  // assertion above: it is not about go failing (it tolerates a read-only cache and
  // reads what the host already has) but about being able to write one — measured
  // 3.5s cold / 51ms warm with the redirect, against 158ms of read-only reuse.
  if (have("go")) {
    const dir = join(workdir, "live-go")
    mkdirSync(dir, { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: dir, env: gitEnv })
    spawnSync("go", ["mod", "init", "example.com/x"], { cwd: dir, env: gitEnv, encoding: "utf8" })
    writeFileSync(join(dir, "x.go"), "package x\nfunc Add(a, b int) int { return a + b }\n")
    writeFileSync(join(dir, "x_test.go"), 'package x\nimport "testing"\nfunc TestAdd(t *testing.T){ if Add(1,2)!=3 { t.Fatal("no") } }\n')
    spawnSync("git", ["add", "-A"], { cwd: dir, env: gitEnv })
    const out = await runLive(
      dir,
      JSON.stringify({
        "pi-subagent-extend/1": { scope: ["*.go"], bash: { write: ["go test"], writable: true } },
      }),
      "go test ./...",
    )
    if (out) {
      assert.equal(out.status, 0, `sandboxed go test failed: ${out.stderr}`)
      assert.ok(existsSync(join(homedir(), ".cache", "pi-subagent-extend", "xdg-cache")), "the build cache lives in ~/.cache")
    } else {
      console.log("  skip  live go test: no real sandbox on this kernel")
    }
  }
  console.log("  ok   真实工具链在沙箱里能写出自己的产物（cargo target/、go build cache）")
}

// 50. scope '.' means the whole repository, not nothing.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagent-extend/1": { scope: ["."], writeScope: [".pi/reports"], maxDenies: 0, maxWriteDenies: 0 },
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
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["./src/**"], maxDenies: 0, maxWriteDenies: 0 } }),
  })
  assert.equal(await dotted.call("read", { path: "src/auth/login.ts" }), undefined, "a scope written './src/**' covers src/**")
  const outside = await dotted.call("read", { path: "docs/x.md" })
  assert.equal(outside?.block, true, "and still confines reads outside it")
  dotted.restore()
  console.log("  ok   范围写 '.' 等于整棵树，'./x' 等于 'x'；写仍受 writeScope 限制")
}

rmSync(workdir, { recursive: true, force: true })
console.log("\npi-subagent-extend 测试通过")
