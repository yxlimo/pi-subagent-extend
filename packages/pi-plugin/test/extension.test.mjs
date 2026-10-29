// Offline test for the pi-allow-reads extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.mjs

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")

const { default: activate } = await import(join(repo, "src", "index.ts"))

/** Activate the extension with the given bindings env and return its tool_call handler. */
async function handler({ bindings, cwd = workdir }) {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = bindings

  const handlers = {}
  const ui = []
  activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  })

  const ctx = { cwd, ui: { notify: (message) => ui.push(message) } }
  if (handlers.session_start) {
    // session_start is async but only reports; flush it before returning.
    await handlers.session_start({ type: "session_start" }, ctx)
  }

  return {
    call: async (toolName, input) => handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx),
    ui,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

const workdir = mkdtempSync(join(tmpdir(), "pi-allow-reads-test-"))
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
    bindings: JSON.stringify({ "pi-allow-reads/1": { scope: ["src/auth/**", "src/**", "README.md"] } }),
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
  h.restore()
  console.log("  ok   范围内放行、范围外拒绝，执行器与未知工具 fail closed")
}

// 3. readOnly bindings block edit/write even inside the scope.
{
  const h = await handler({
    bindings: JSON.stringify({ "pi-allow-reads/1": { scope: ["src/**"], readOnly: true } }),
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
  const h = await handler({ bindings: JSON.stringify({ "pi-allow-reads/1": { scope: [] } }) })
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
    bindings: JSON.stringify({ "pi-allow-reads/1": { scope: ["src/**"], maxReads: 2 } }),
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
    bindings: JSON.stringify({ "pi-allow-reads/1": { scope: ["src/**"], allowTools: ["todo_write"] } }),
  })
  assert.equal(await h.call("todo_write", { items: [] }), undefined, "allowTools entry passes")
  assert.equal((await h.call("bash", { command: "ls" }))?.block, true, "allowTools cannot re-enable executors")
  h.restore()
  console.log("  ok   allowTools 放行点名工具，但执行器类仍拒绝")
}

// 9. Search tools without an explicit path default to cwd and get judged on it.
{
  const h = await handler({ bindings: JSON.stringify({ "pi-allow-reads/1": { scope: ["src/**"] } }) })
  const grep = await h.call("grep", { pattern: "x" })
  assert.equal(grep?.block, true, "pathless grep (cwd) is out of scope here")
  assert.match(grep.reason, /任务范围/, "block reason teaches the scope")
  h.restore()
  console.log("  ok   缺省 path 视为 cwd 并按范围判定")
}

// 10. The bundled usage skill ships with the extension via resources_discover.
{
  const handlers = {}
  activate({
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand() {},
  })
  assert.equal(typeof handlers.resources_discover, "function", "the extension registers resources_discover")
  const result = await handlers.resources_discover({ type: "resources_discover", cwd: workdir, reason: "startup" })
  const skillDir = result?.skillPaths?.[0]
  assert.ok(skillDir, "resources_discover returns a skill path")
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true, "the skill path holds a SKILL.md")
  const frontmatter = readFileSync(join(skillDir, "SKILL.md"), "utf8").slice(0, 200)
  assert.match(frontmatter, /name: pi-allow-reads/, "the skill is named pi-allow-reads")
  console.log("  ok   用法 skill 随扩展经 resources_discover 注册")
}

// 11. A scoped session does not advertise the delegation skill.
{
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-allow-reads/1": { scope: ["src/**"] } })
  const handlers = {}
  activate({
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

rmSync(workdir, { recursive: true, force: true })
console.log("\npi-allow-reads 测试通过")
