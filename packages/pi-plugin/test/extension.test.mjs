// Offline test for the pi-subagent-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.mjs

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

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
function helperAbi(bin) {
  const out = spawnSync(bin, ["--describe"], { encoding: "utf8" });
  try {
    return JSON.parse(out.stdout);
  } catch {
    return undefined;
  }
}

const described = helperAbi(helperBin);
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
function specOf(command) {
  const match = /'--spec' '([^']+)'/.exec(command)
  assert.ok(match, `no --spec in: ${command}`)
  return JSON.parse(readFileSync(match[1], "utf8"))
}

const ext = await import(join(repo, "src", "index.ts"))

/**
 * Activate the extension with the given bindings env and return its tool_call handler.
 * Pass `profile` to activate through the profile loader (per-role defaults).
 */
async function handler({ bindings, cwd = workdir, profile, profileFile } = {}) {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = bindings

  const handlers = {}
  const commands = {}
  const ui = []
  ext.activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }, profile ? { profileName: profile, profileFile } : {})

  const ctx = { cwd, ui: { notify: (message) => ui.push(message) }, actions: { abort: () => aborts.push("abort") } }
  const aborts = []
  if (handlers.session_start) {
    // session_start is async but only reports; flush it before returning.
    await handlers.session_start({ type: "session_start" }, ctx)
  }

  const call = async (toolName, input) =>
    handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx)
  const result = async (toolName, content) =>
    handlers.tool_result?.({ type: "tool_result", toolName, content }, ctx)

  return {
    call,
    result,
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
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const host = {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++seq
      timers.set(id, { at: now + delay, fn })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  }
  const advance = (ms) => {
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
  assert.match(outside.reason, /任务范围/, "block reason names the scope")
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
  assert.match(edit.reason, /只读/, "block reason says read-only")
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
  assert.match(read.reason, /不是合法 JSON/, "block reason names the parse error")
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
  assert.match(third.reason, /预算/, "block reason names the budget")
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
  assert.equal((await h.call("bash", { command: "ls" }))?.block, true, "allowTools cannot re-enable executors")
  h.restore()
  console.log("  ok   allowTools 放行点名工具，但执行器类仍拒绝")
}

// 9. Search tools without an explicit path default to cwd and get judged on it.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"] } }) })
  const grep = await h.call("grep", { pattern: "x" })
  assert.equal(grep?.block, true, "pathless grep (cwd) is out of scope here")
  assert.match(grep.reason, /任务范围/, "block reason teaches the scope")
  h.restore()
  console.log("  ok   缺省 path 视为 cwd 并按范围判定")
}

// 10. The bundled usage skill ships with the extension via resources_discover.
{
  const handlers = {}
  ext.activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  })
  assert.equal(typeof handlers.resources_discover, "function", "the extension registers resources_discover")
  const result = await handlers.resources_discover({ type: "resources_discover", cwd: workdir, reason: "startup" })
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
  const handlers = {}
  ext.activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  })
  const result = await handlers.resources_discover({ type: "resources_discover", cwd: workdir, reason: "startup" })
  assert.equal(result?.skillPaths, undefined, "a scoped session gets no skill path")
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
  assert.match(denied.reason, /不在白名单内/)
  assert.equal(other.command, "pnpm publish", "denied command is left untouched")

  const inject = { command: "pnpm test; cat /etc/passwd" }
  const meta = await h.call("bash", inject)
  assert.equal(meta?.block, true, "shell metacharacters are rejected even behind a listed prefix")

  assert.equal((await h.call("powershell", { command: "dir" }))?.block, true, "powershell stays denied")
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
    assert.equal((await h.call("ls", { path }))?.block, true, `"${path}" is outside the scope`)
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
  assert.equal((await slash.call("ls", { path: "src/other.ts" }))?.block, true, "trailing-slash scope stays narrow")
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
  assert.equal((await h.call("bash", { command: "tsc --noEmit && cat /etc/passwd" }))?.block, true, "metacharacters win over regex")
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
    hooks: { abort: () => {}, warn: () => {} },
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

// 18. Idle probe: warn at the boundary, abort once the grace runs out.
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const aborted = []
  const warned = []
  const p = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: false,
    hooks: { abort: () => aborted.push(1), warn: (t) => warned.push(t) },
    host: clock.host,
  })
  clock.advance(1000)
  const warn = p.atToolBoundary()
  assert.equal(warn?.stop, false, "first boundary warns")
  assert.match(warn.reason, /只读空转/)
  clock.advance(500)
  assert.equal(aborted.length, 0, "the grace timer does not hard-abort (the model keeps its chance to report)")
  assert.equal(p.status().some((l) => l.includes("已停止")), true, "the probe is stopped after the grace")
  const after = p.atToolBoundary()
  assert.equal(after?.stop, true, "after the stop every boundary refuses the call")
  assert.match(after.reason, /不要再调用工具/, "and asks for the report")
  p.dispose()

  // Read-only tasks are exempt.
  const ro = new Probe({
    config: { ...defaultProbe(), idleWriteMs: 1000, abortGraceMs: 500 },
    readOnly: true,
    hooks: { abort: () => {}, warn: () => {} },
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
    hooks: { abort: () => {}, warn: () => {} },
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
  assert.match(junk.reason, /造杂物/)
  const junk2 = await h.call("write", { path: "src/snapshot.tmp.tsx" })
  assert.equal(junk2?.block, true, "regex pattern also refuses")
  assert.equal(await h.call("write", { path: "src/real.ts" }), undefined, "normal writes pass")

  const first = await h.call("read", { path: "outside/a.ts" })
  assert.equal(first?.block, true, "out-of-scope read denied")
  const second = await h.call("read", { path: "outside/b.ts" })
  assert.equal(second?.block, true, "second denial feeds the counter")
  assert.match(second.reason, /撞权限|撞到任务范围/, "the budget warns about a bad grant")
  const third = await h.call("read", { path: "outside/c.ts" })
  assert.equal(third?.block, true, "one more denial stops the run")
  const after = await h.call("read", { path: "src/real.ts" })
  assert.equal(after?.block, true, "once stopped, every later call is refused")
  assert.match(after.reason, /不要再调用任何工具/, "and the model is told to write its report")
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
  const commands = []
  for (let i = 0; i < 4; i += 1) commands.push(await h.call("bash", { command: "pnpm run typecheck" }))
  assert.ok(commands.slice(0, 2).every((r) => r === undefined), "the first two repeats run")
  assert.match(commands[2].reason, /原地打转/, "the 3rd identical command is refused with a warning")
  assert.equal(commands[2].block, true, "the warning refuses that call but keeps the run alive")
  assert.match(commands[3].reason, /停止本轮/, "one more repeat stops the run")
  h.restore()
  console.log("  ok   打转与撞权限默认开启；时间判据需显式配置")
}

// 22. Worktree ergonomics: writablePaths, env injection, worktree root binding.
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
    spec.write.some((dir) => dir.endsWith("/wt")),
    `the worktree root itself is writable, got: ${spec.write.join(", ")}`,
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
  console.log("  ok   worktree 场景：writablePaths、env 注入、worktree 根可写、mise 信任绕过")
}

// 23. Missing path must not read as "the child walked to the wrong directory".
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 0 } }),
  })
  const write = await h.call("write", { content: "x" })
  assert.equal(write?.block, true, "write without path is refused")
  assert.match(write.reason, /必须给 path/, "write says the path argument is missing")
  assert.ok(!/不在任务范围内/.test(write.reason), "write does not blame the scope")

  const grep = await h.call("grep", { pattern: "foo" })
  assert.equal(grep?.block, true, "grep without path is refused")
  assert.match(grep.reason, /没有给 path/, "grep says no path was given")
  assert.match(grep.reason, /当前目录/, "grep says the cwd was used instead")

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
  const notified = []
  await h.commands["permission"].handler("", { cwd: workdir, ui: { notify: (m) => notified.push(m) } })
  const text = notified.join("\n")
  assert.match(text, /沙箱可写路径/, "the command lists the writable paths")
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
  assert.ok(spec.write.includes(workdir), `the working directory is writable, got: ${spec.write.join(", ")}`)
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
  assert.match(stash.reason, /禁掉/, "the denial says the command is forbidden")
  const checkout = await h.call("bash", { command: "git checkout -- src/a.ts" })
  assert.equal(checkout?.block, true, "deny entries use the same prefix matching")
  h.restore()

  // Without a call-side bash the profile's own allowlist survives, so its read entries work.
  const plain = await handler({ cwd: proj, profile: "review" })
  const diff = await plain.call("bash", { command: "git diff" })
  assert.equal(diff, undefined, "the profile's own read entry passes when the call sends no bash")
  const plainStash = await plain.call("bash", { command: "git stash" })
  assert.equal(plainStash?.block, true, "deny still applies")

  const messages = []
  await plain.commands.permission.handler("", { cwd: proj, ui: { notify: (m) => messages.push(m) } })
  assert.match(messages.join("\n"), /bash 禁（不可放宽）/, "/permission shows the non-overridable list")
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
  assert.match(blocked.reason, /找不到/, "the denial says the profile file is missing")
  const brokenBash = await h.call("bash", { command: "ls" })
  assert.equal(brokenBash?.block, true, "bash is refused too")
  h.restore()
  console.log("  ok   profile 缺失时失败关闭，不是退回不设限")
}

rmSync(workdir, { recursive: true, force: true })
console.log("\npi-subagent-extend 测试通过")
