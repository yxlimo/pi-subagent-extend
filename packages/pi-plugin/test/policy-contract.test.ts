// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, workdir } from "./harness.ts"
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
console.log("\npolicy module tests passed")
