// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CommandSpec,
  EventHandler,
  FakeExtensionApi,
  Harness,
  Outcome,
  SandboxSpec,
  SessionContext,
} from "./types.ts"
import { handler, writeAgentMd, childSystemPrompt, specOf, specPathOf, liveSandbox, fakeClock, defaultProbe, workdir, repo, ext } from "./harness.ts"
import { described, restoreState, testState } from "./support.ts"



/**
 * src/index.ts leaves a caller-supplied GIT_CONFIG_COUNT alone. A shell that exports it would
 * otherwise make the git-excludes assertion below fail for a reason unrelated to the change.
 */
async function withoutGitConfigCount<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_CONFIG_COUNT
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = previous
  }
}



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
      "pi-subagents-extend/1": { scope: ["src/auth/**", "src/**", "README.md"], maxDenies: 0 },
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
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], maxReads: 2 } }),
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
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], allowTools: ["todo_write"] } }),
  })
  assert.equal(await h.call("todo_write", { items: [] }), undefined, "allowTools entry passes")
  const executor = await h.call("bash", { command: "ls" })
  assert.equal(executor?.block, true, "allowTools cannot re-enable executors")
  h.restore()
  console.log("  ok   allowTools 放行点名工具，但执行器类仍拒绝")
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
    ["pi-subagents-extend", "pi-subagents-extend-context", "pi-subagents-extend-probes"],
    "scope, probe and context skills",
  )
  console.log("  ok   三个用法 skill 随扩展经 resources_discover 注册")
}

// 11. A scoped session does not advertise the delegation skill.
{
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"] } } })
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
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["pnpm run typecheck"], write: ["pnpm test"] },
      },
    }),
  })
  const input = { command: "pnpm run typecheck" }
  assert.equal(await h.call("bash", input), undefined, "listed command passes")
  assert.match(
    input.command,
    /^'\/[^']*pi-subagents-extend-helper' '--spec' '\/[^']*spec-[0-9]+-[0-9]+-[^']*\.json' '--' 'bash' '-lc'/,
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
  const h = await handler({ bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"] } }) })
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
      "pi-subagents-extend/1": {
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

  const previous = process.env.PI_SUBAGENTS_EXTEND_HELPER
  process.env.PI_SUBAGENTS_EXTEND_HELPER = "/nonexistent/pi-subagents-extend-helper"
  const h2 = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["node harness.mjs"] } } }),
  })
  const missing = await h2.call("bash", { command: "node harness.mjs" })
  assert.equal(missing?.block, true, "no helper means no bash, even for a listed command")
  assert.match(missing.reason, /build:helper/, "the denial says how to build the helper")
  h2.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER
  else process.env.PI_SUBAGENTS_EXTEND_HELPER = previous
  console.log("  ok   writable/network 选项写进 spec；找不到 helper 时 fail closed")
}



// 16. bash patterns: literal prefixes and `re:` regexes, both lists authorize.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
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
//     只数读类命令：写活动（edit/write 工具、命中 write 列的命令）算进展，计数会被清零，
//     见测试 57。这条判据的语义是「同一件事没有进展地重复」。
{
  const { Probe } = await import(join(repo, "src", "probe.ts"))
  const clock = fakeClock()
  const p = new Probe({
    config: { ...defaultProbe(), repeatBash: 3 },
    readOnly: true,
    hooks: { warn: () => {} },
    host: clock.host,
  })
  p.noteBashStart("pnpm test", "read")
  p.noteBashStart("pnpm test", "read")
  assert.equal(p.atToolBoundary(), undefined, "below the threshold nothing happens")
  p.noteBashStart("pnpm test", "read")
  assert.equal(p.atToolBoundary()?.stop, false, "the Nth repeat warns")
  const stop = p.noteBashStart("pnpm test", "read")
  assert.equal(stop?.stop, true, "one more repeat stops the run")
  p.dispose()
  console.log("  ok   原地打转：第 3 次 warn，第 4 次停止（只数读类命令）")
}

// 20. Junk-file probe blocks probe artifacts; deny budget warns then stops.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
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
	assert.match(
		after.reason,
		/stopped earlier/,
		// 原来是「重发停机理由」，而那条理由里带着触发停机的具体命令；实测中被判打转的子代理
		// 换去 `ls -la docs` 后仍收到点名 .pnpm 的旧文案，于是把新命令读成「也犯了那个错」。
		// 现在讲状态：原因在上一条消息里，模型手里有。
		"the reason says the run was stopped, without re-serving the old verdict",
	)
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
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } },
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
      "pi-subagents-extend/1": {
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


// 24. /permission reports the writable paths and the pnpm store probe.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
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
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] }, maxDenies: 0 },
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
await withoutGitConfigCount(async () => {
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
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
})

// 27. The helper gates on kernel support: a kernel below Landlock ABI 7 means no bash.
{
  const fake = join(workdir, "fake-helper")
  writeFileSync(
    fake,
    `#!/bin/sh\necho '{"landlock":{"kernel_abi":3,"required_abi":7,"supported":false,"reason":"kernel Landlock ABI is 3, but ABI 7 is required"},"network_namespace":true,"resolver_sockets":[]}'\nexit 76\n`,
  )
  chmodSync(fake, 0o755)
  const previous = process.env.PI_SUBAGENTS_EXTEND_HELPER
  process.env.PI_SUBAGENTS_EXTEND_HELPER = fake
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"] } } }),
  })
  const denied = await h.call("bash", { command: "pnpm test" })
  assert.equal(denied?.block, true, "an unsupported kernel denies bash")
  assert.match(denied.reason, /ABI 7 is required/, "the denial names the ABI the plugin needs")
  h.restore()
  if (previous === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER
  else process.env.PI_SUBAGENTS_EXTEND_HELPER = previous
  console.log("  ok   内核 ABI 不足时 bash 被拒绝，文案说清缺的版本")
}

/**
 * A child whose policy comes from a role md instead of bindings. The role wiring runs in
 * before_agent_start, which `handler()` never emits, and this suite may only touch this file —
 * so the two events are driven here, mirroring handler()'s activation exactly. `bindings` is
 * the env value verbatim, already in the documented dispatch shape.
 */
interface MdChild {
  call(toolName: string, input?: Record<string, unknown>): Promise<Outcome>
  commands: Record<string, CommandSpec>
  restore(): void
}

async function mdChild({ cwd, prompt, bindings }: { cwd: string; prompt: string; bindings?: string }): Promise<MdChild> {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  if (bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = bindings
  const handlers: Record<string, EventHandler> = {}
  const commands: Record<string, CommandSpec> = {}
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn
    },
    registerCommand(name, spec) {
      commands[name] = spec
    },
  }
  ext.activate(api)
  const ctx: SessionContext = { cwd, ui: { notify() {} }, actions: { abort() {} } }
  if (handlers.session_start) await handlers.session_start({ type: "session_start" }, ctx)
  if (handlers.before_agent_start) await handlers.before_agent_start({ type: "before_agent_start", systemPrompt: prompt }, ctx)
  let seq = 0
  return {
    call: async (toolName, input) =>
      (await handlers.tool_call({ type: "tool_call", toolCallId: `t${++seq}`, toolName, input }, ctx)) as Outcome,
    commands,
    restore: () => {
      if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous
    },
  }
}

// 28. A role md whose extend block has no scope denies file access (the role does not know the
//     task's paths), but its bash allowlist still applies when the dispatch passes no bindings:
//     the md is the only policy source left.
{
  const proj = join(workdir, "proj-role-md")
  mkdirSync(join(proj, "src"), { recursive: true })
  const body = "Role policy for impl: run the listed commands; report instead of writing files."
  writeAgentMd({ cwd: proj, role: "impl", extend: { permissions: { bash: { allow: ["mise run test"] } } }, body })
  const h = await mdChild({ cwd: proj, prompt: childSystemPrompt("impl", body) })
  const blocked = await h.call("read", { path: "src/a.ts" })
  assert.equal(blocked?.block, true, "a role md without scope denies file access")
  assert.match(blocked.reason, /role md/, "the denial names the role md as the source")
  const input = { command: "mise run test" }
  assert.equal(await h.call("bash", input), undefined, "the md's allowlist applies with no bindings")
  assert.match(input.command, /--spec/, "allowed commands still run under the sandbox")
  const outside = await h.call("bash", { command: "curl https://example.com" })
  assert.equal(outside?.block, true, "commands outside the md allowlist are denied")
  h.restore()
  console.log("  ok   角色 md 默认值：漏传 bindings 时文件全拒、命令只放白名单")
}


// 31. `bash.deny` is a restriction: it applies however the session is configured, and no
//     allowlist re-allows it. The dispatch may carry scope and budgets, but the deny itself
//     lives in the role md.
{
  const proj = join(workdir, "proj-deny")
  const body = "Role policy for review: inspect with git; the deny list is a hard floor."
  writeAgentMd({
    cwd: proj,
    role: "review",
    extend: { permissions: { bash: { allow: ["git diff"], deny: ["git stash", "git checkout"] } } },
    body,
  })
  const h = await mdChild({
    cwd: proj,
    prompt: childSystemPrompt("review", body),
    bindings: JSON.stringify({ "pi-subagents-extend/1": { permissions: { scope: ["src/**"], maxDenies: 0 } } }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(stash?.block, true, "a deny entry from the role md blocks the command")
  assert.match(stash.reason, /blocked by a deny entry/, "the denial says the command is forbidden")
  const checkout = await h.call("bash", { command: "git checkout -- src/a.ts" })
  assert.equal(checkout?.block, true, "deny entries use the same prefix matching")
  h.restore()

  // Without call-side bindings the md's own allowlist survives, so its read entry works.
  const plain = await mdChild({ cwd: proj, prompt: childSystemPrompt("review", body) })
  const diff = await plain.call("bash", { command: "git diff" })
  assert.equal(diff, undefined, "the md's own read entry passes when the call sends no bindings")
  const plainStash = await plain.call("bash", { command: "git stash" })
  assert.equal(plainStash?.block, true, "deny still applies")

  const messages: string[] = []
  await plain.commands.permission.handler("", { cwd: proj, ui: { notify: (m: string) => messages.push(m) } })
  assert.match(messages.join("\n"), /bash deny \(cannot be lifted\)/, "/permission shows the non-overridable list")
  plain.restore()
  console.log("  ok   bash.deny 是硬底线（含 /permission 可见），md 自己的白名单照常生效")
}



// 36. linked worktree：索引与 HEAD 在 worktree 自己的 gitdir 里，ref 与对象在主仓 common dir
//     的 refs / objects / logs 里，两处都得给；hooks 与 config 长在 common dir 根上，所以那里
//     不整目录授权（整目录授权 = 子代理能植入 hook 或改 core.hooksPath，之后以父代理身份执行）。
//     Lab 实测：只给 worktree 时 `git add`/`commit`/`stash`/`switch -c` 全失败在
//     <common>/worktrees/<id>/index.lock 上；再逐个去掉 common 的三个子目录，分别在对象库、
//     ref 锁、reflog 上失败 —— 四个路径都有具体命令在使用。
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
        "pi-subagents-extend/1": { scope: ["**"], bash: { [writable ? "write" : "read"]: ["git status"], writable } },
      })

    const h = await handler({ cwd: wtDir, bindings: bindings(true) })
    const input = { command: "git status" }
    assert.equal(await h.call("bash", input), undefined, "a writable sandbox passes the listed command")
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: wtDir, encoding: "utf8", env: gitEnv }).stdout.trim()
    // .git 是文件时 rev-parse 给的是 worktree 自己的 gitdir，不是主仓 common dir。
    assert.match(gitDir, /\/worktrees\/[^/]+$/, `the worktree has its own gitdir, got: ${gitDir}`)
    const spec = specOf(input.command)
    assert.ok(
      spec.write.includes(gitDir),
      `the worktree's own gitdir is writable (index.lock / HEAD.lock land there), got: ${spec.write.join(", ")}`,
    )
    for (const name of ["objects", "refs", "logs"]) {
      assert.ok(
        spec.write.includes(join(commonDir, name)),
        `the common ${name} directory is writable, got: ${spec.write.join(", ")}`,
      )
    }
    assert.equal(
      spec.write.includes(commonDir),
      false,
      `the common git dir is not granted wholesale — that is what opens hooks/ and config, got: ${spec.write.join(", ")}`,
    )
    assert.equal(spec.write.includes(join(commonDir, "hooks")), false, "hooks stay out of the grant")
    assert.equal(spec.write.includes(join(commonDir, "config")), false, "the repository config stays out of the grant")
    assert.ok(!spec.write.some((d) => d === join(repoDir, "a.txt")), "the main working tree is not granted")
    h.restore()

    // 不只是看 spec：让 helper 真的执行，文件必须真的进索引（修复前会失败在 index.lock）。
    writeFileSync(join(wtDir, "b.txt"), "two\n")
    const live = await handler({
      cwd: wtDir,
      bindings: JSON.stringify({
        "pi-subagents-extend/1": { scope: ["**"], bash: { write: ["git add b.txt"], writable: true } },
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
    console.log("  ok   linked worktree 给 gitdir 与 common 的 objects/refs/logs，hooks/config 不给；只读沙箱全不给；普通仓只给 .git")
  }
}





// 46. bash writable dirs follow writeScope, not the read scope.
{
  // 两个目录都要真实存在：writablePaths 只收录存在的路径，不存在的话「不给」不算证据。
  mkdirSync(join(workdir, "src"), { recursive: true })
  mkdirSync(join(workdir, "lib"), { recursive: true })
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
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
    JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["pnpm test"], writable: true, ...extra } } })
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
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm test"], writable: true } },
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



// 49. A real toolchain can write its own artefacts through the rewritten command.
// Guards: a real sandbox on this kernel, and the toolchain installed.
{
  const liveSandbox = described()?.landlock?.supported === true
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
        "pi-subagents-extend/1": { scope: ["src/**"], bash: { write: ["cargo test"], writable: true } },
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
        "pi-subagents-extend/1": { scope: ["*.go"], bash: { write: ["go test"], writable: true } },
      }),
      "go test ./...",
    )
    if (out) {
      assert.equal(out.status, 0, `sandboxed go test failed: ${out.stderr}`)
      assert.ok(existsSync(join(testState, "xdg-cache")), "the build cache lives in the state directory")
    } else {
      console.log("  skip  live go test: no real sandbox on this kernel")
    }
  }
  console.log("  ok   真实工具链在沙箱里能写出自己的产物（cargo target/、go build cache）")
}


// 56. 元字符判定要看引号：命令最终以 `bash -lc <command>` 执行，单引号内一切惰性，
//      双引号内只有 $ / 反引号 / 反斜杠仍展开。纯文本匹配会连引号内的括号一起拒，
//      dogfooding 时一个子代理因此无法自验 YAML（python3 -c "print(1)" 被拒）。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["python3", "echo", "node"] } },
    }),
  })
  const allowed = async (command: string, why: string): Promise<void> => {
    assert.equal(await h.call("bash", { command }), undefined, why)
  }
  const refused = async (command: string, why: string): Promise<void> => {
    const r = await h.call("bash", { command })
    assert.equal(r?.block, true, why)
    assert.match(r.reason, /metacharacters/, `${why} (names the cause)`)
  }

  // 引号内的控制字符是普通字符，不该被拒
  await allowed('python3 -c "print(1)"', "parentheses inside double quotes are inert")
  await allowed('echo "a|b"', "a pipe inside double quotes is inert")
  await allowed('echo "a; b"', "a semicolon inside double quotes is inert")
  await allowed("echo 'a;b'", "single quotes make everything inert")
  // 单引号内惰性：这等于「允许白名单里的解释器执行任意代码」。这是刻意接受的：
  // 沙箱边界是 Landlock 与命名空间，不是命令文本；解释器能不能用由 profile 决定。
  await allowed("python3 -c 'import os; os.system(\"id\")'", "single quotes are inert even for an interpreter")

  // 引号外的一律拒
  await refused("echo a; b", "an unquoted semicolon is refused")
  await refused("echo a && b", "an unquoted && is refused")
  await refused("echo $(id)", "command substitution is refused")
  await refused('echo "x$(id)"', "command substitution expands inside double quotes too")
  await refused("echo `id`", "a backtick is refused")
  await refused('echo "unclosed', "an unterminated quote is refused")
  h.restore()
  console.log("  ok   元字符判定看引号：引号内惰性放行，引号外与命令替换一律拒")
}

// 57. 打转判据是「同一件事没有进展地重复」：写活动就是进展，计数清零、已发出的 warn 撤掉。
//      dogfooding 实测的误杀：一个 coder 子代理第 3 次跑同一条测试收到 warn，中途改了代码，
//      宽限到期照样被停。写类命令按定义就是改动，因此不再受这条判据约束。
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["node test/x.ts"], write: ["pnpm run fix"] },
      },
    }),
  })

  // 写类命令反复执行：每一次都是改动，不算打转
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await h.call("bash", { command: "pnpm run fix" }), undefined, `write-class repeat ${i + 1} runs`)
  }

  // 读类命令之间做一次改动（编辑文件），也不该被判打转
  for (let i = 0; i < 4; i += 1) {
    assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, `test run ${i + 1} runs after a change`)
    assert.equal(await h.call("edit", { path: "src/a.ts", content: "x" }), undefined, "the edit between runs is allowed")
  }

  // 对照：没有改动时原地重复，判据照旧生效
  assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, "first bare repeat runs")
  assert.equal(await h.call("bash", { command: "node test/x.ts" }), undefined, "second bare repeat runs")
  const warned = await h.call("bash", { command: "node test/x.ts" })
  assert.match(warned?.reason ?? "", /spinning/, "without a change in between, the third repeat still warns")
  h.restore()
  console.log("  ok   打转判据把写活动算作进展；无改动的原地重复照旧拦截")
}

// 54. git 的 hooks 与 config 不能让沙箱子进程写。植入一个 hook、或把 core.hooksPath 改到别处，
//     都会在父代理之后于这个 checkout 里跑 git 时以父代理身份执行 —— 这是从「能写 git 目录」
//     到手「以父代理身份执行」的一步。linked worktree 里 hooks/config 长在 common dir 根上，
//     而 git 真正要写的只有 worktree 自己的 gitdir 与 common 的 objects/refs/logs，所以那两处
//     必须留在授权之外，同时 git add 仍然要能成功。
{
  const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  if (!gitOk) {
    console.log("  skip  git hooks are out of reach（环境里没有 git）")
  } else {
    // 仓库不能放在 tmpdir() 下：spec.write 天然包含 tmpdir()，那里什么都能写，「写不进去」
    // 就永远测不出来。放在项目目录下的临时目录里，跑完删掉。
    const outside = mkdtempSync(join(repo, ".test-git-hooks-"))
    try {
      const repoDir = join(outside, "repo")
      const wtDir = join(outside, "wt")
      mkdirSync(repoDir, { recursive: true })
      const gitEnv = {
        ...process.env,
        HOME: outside,
        GIT_CONFIG_GLOBAL: join(outside, "gitconfig"),
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      }
      const git = (...args: string[]): string => {
        const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv })
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
      const hookPath = join(commonDir, "hooks", "pre-commit")
      const configPath = join(commonDir, "config")
      const configBefore = readFileSync(configPath, "utf8")
      writeFileSync(join(wtDir, "b.txt"), "two\n")

      // 正控目标单独放在一个只属于它的子目录里：这条用例要钉的是 git 的授权面，
      // 所以写授权用一份两个版本都认的写法（纯路径 → 目录本身），不靠 `**` 的解析。
      const plantedDir = join(wtDir, "planted")
      mkdirSync(plantedDir, { recursive: true })
      const planted = join(plantedDir, "planted.txt")
      writeFileSync(join(wtDir, "write.sh"), "#!/bin/sh\nprintf 'x\\n' > \"$1\"\n")
      const h = await handler({
        cwd: wtDir,
        bindings: JSON.stringify({
          "pi-subagents-extend/1": {
            scope: ["**"],
            writeScope: ["planted"],
            bash: { write: ["git add b.txt", "sh write.sh"], writable: true },
          },
        }),
      })
      // spec 按 toolCallId 存，所以每条命令都要各自经过一次 tool_call。id 必须各不相同：
      // 重复 id 会让前一次调用的 spec 文件在覆盖时被清掉（真 pi 每次调用都是新 id）。
      const sandboxed = async (command: string, toolCallId: string): Promise<string> => {
        const input = { command }
        assert.equal(await h.call("bash", input, toolCallId), undefined, `allowlisted: ${command}`)
        return input.command
      }
      const addCommand = await sandboxed("git add b.txt", "add")
      const controlCommand = await sandboxed(`sh write.sh ${planted}`, "control")
      const hookCommand = await sandboxed(`sh write.sh ${hookPath}`, "hook")
      const configCommand = await sandboxed(`sh write.sh ${configPath}`, "config")
      h.restore()

      // 授权面：hooks 与 config 都不在清单里（否则下面的真实执行只是在验证另一个事实）。
      const spec = specOf(addCommand)
      assert.equal(spec.write.includes(join(commonDir, "hooks")), false, `hooks are outside the grant, got: ${spec.write.join(", ")}`)
      assert.equal(spec.write.includes(configPath), false, `config is outside the grant, got: ${spec.write.join(", ")}`)

      if (liveSandbox) {
        const add = spawnSync("/bin/sh", ["-c", addCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.equal(add.status, 0, `sandboxed git add failed: ${add.stderr}`)
        const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.match(staged.stdout, /b\.txt/, "the file is really staged inside the sandbox")

        // 正控：同一份脚本在授权目录里写得进去。
        const control = spawnSync("/bin/sh", ["-c", controlCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.equal(control.status, 0, `the same script writes inside its granted directory: ${control.stderr}`)
        assert.ok(existsSync(planted), "the positive control really wrote its file")

        const hook = spawnSync("/bin/sh", ["-c", hookCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.notEqual(hook.status, 0, "planting a hook is refused by the kernel")
        assert.match(`${hook.stdout}${hook.stderr}`, /permission denied/i, "the refusal is a permission denial")
        assert.equal(existsSync(hookPath), false, "no hook file was created")

        const config = spawnSync("/bin/sh", ["-c", configCommand], { cwd: wtDir, encoding: "utf8", env: gitEnv })
        assert.notEqual(config.status, 0, "rewriting the repository config is refused")
        assert.equal(readFileSync(configPath, "utf8"), configBefore, "the config is byte-for-byte unchanged")
      } else {
        console.log("  skip  live git hooks/config: no real sandbox on this kernel")
      }
      console.log("  ok   沙箱写不进 worktree 的 .git/hooks 与 config，git add 仍成功")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  }
}

// 55. 文件级 glob 不能把父目录整片打开：旧做法在第一个通配符处截断，于是
//     writeScope ["src/auth/*.ts"] 让整个 src/auth/ 对 bash 可写，["src/*/index.ts"] 让 src/ 可写。
//     Landlock 只能正向授权，所以「授权目录」必须恰好等于「这条 glob 覆盖的范围」：文件级写法
//     展开成实际存在的文件，只有覆盖整棵子树的写法（dir、dir/**）才授权目录本身。
{
  const outside = mkdtempSync(join(repo, ".test-glob-scope-"))
  try {
    const authDir = join(outside, "src", "auth")
    const matched = join(authDir, "session.ts")
    const sibling = join(authDir, "notes.md")
    const deepIndex = join(authDir, "index.ts")
    mkdirSync(authDir, { recursive: true })
    writeFileSync(matched, "export {}\n")
    writeFileSync(sibling, "notes\n")
    writeFileSync(deepIndex, "export {}\n")
    writeFileSync(join(outside, "write.sh"), "#!/bin/sh\nprintf 'w\\n' > \"$1\"\n")

    const bindingsFor = (writeScope: string[]): string =>
      JSON.stringify({
        "pi-subagents-extend/1": { scope: ["src/**"], writeScope, bash: { write: ["sh write.sh"], writable: true } },
      })
    const sandboxed = async (h: Harness, command: string): Promise<string> => {
      const input = { command }
      assert.equal(await h.call("bash", input), undefined, `allowlisted: ${command}`)
      return input.command
    }

    // 文件级 glob：只授权匹配到的文件。
    // spec 文件按 pid 共用，每次 tool_call 覆写一次，所以「取 spec」与「真实执行」都要紧跟在
    // 自己那次调用后面 —— 否则拿到的是下一个激活的授权，测的就不是这件事了。
    const fileScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/auth/*.ts"]) })
    const matchedCommand = await sandboxed(fileScoped, `sh write.sh ${matched}`)
    const spec = specOf(matchedCommand)
    const siblingCommand = await sandboxed(fileScoped, `sh write.sh ${sibling}`)
    if (liveSandbox) {
      const write = spawnSync("/bin/sh", ["-c", matchedCommand], { cwd: outside, encoding: "utf8" })
      assert.equal(write.status, 0, `the matched file is writable: ${write.stderr}`)
      assert.equal(readFileSync(matched, "utf8"), "w\n", "the write really landed on the matched file")

      const blocked = spawnSync("/bin/sh", ["-c", siblingCommand], { cwd: outside, encoding: "utf8" })
      assert.notEqual(blocked.status, 0, "a sibling the glob does not match is refused")
      assert.equal(readFileSync(sibling, "utf8"), "notes\n", "and left untouched")
    } else {
      console.log("  skip  live file-glob writes: no real sandbox on this kernel")
    }
    fileScoped.restore()
    assert.equal(spec.write.includes(authDir), false, `the whole src/auth directory is not granted, got: ${spec.write.join(", ")}`)
    assert.equal(spec.write.includes(matched), true, `the file the glob matches is granted, got: ${spec.write.join(", ")}`)
    assert.equal(spec.write.includes(sibling), false, `a sibling the glob does not match is not granted, got: ${spec.write.join(", ")}`)

    // 通配符在中间层：同样不能把 src/ 打开。
    const midScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/*/index.ts"]) })
    const midCommand = await sandboxed(midScoped, `sh write.sh ${deepIndex}`)
    const midSpec = specOf(midCommand)
    midScoped.restore()
    assert.equal(midSpec.write.includes(join(outside, "src")), false, `the whole src directory is not granted, got: ${midSpec.write.join(", ")}`)
    assert.equal(midSpec.write.includes(deepIndex), true, `the nested file the glob matches is granted, got: ${midSpec.write.join(", ")}`)

    // 整棵子树写法照旧授权目录本身：不然新建文件就没法写。
    const subtreeScoped = await handler({ cwd: outside, bindings: bindingsFor(["src/**"]) })
    const fresh = join(authDir, "brand-new.ts")
    const freshCommand = await sandboxed(subtreeScoped, `sh write.sh ${fresh}`)
    const subtreeSpec = specOf(freshCommand)
    if (liveSandbox) {
      const create = spawnSync("/bin/sh", ["-c", freshCommand], { cwd: outside, encoding: "utf8" })
      assert.equal(create.status, 0, `a new file under a subtree glob is writable: ${create.stderr}`)
      assert.ok(existsSync(fresh), "the new file really landed")
    }
    subtreeScoped.restore()
    assert.equal(subtreeSpec.write.includes(join(outside, "src")), true, "a subtree glob grants the directory itself")
    assert.equal(subtreeSpec.write.includes(sibling), false, "and it is the only thing that grants a directory")
    console.log("  ok   文件级 glob 只授权匹配到的文件，子树 glob 仍授权目录（新建文件可用）")
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}


// 58. A temporary directory outside /tmp has to be privatized, not just granted. The
// extension used to grant os.tmpdir() while the helper only ever mounted a tmpfs on the
// hard-coded /tmp, so a host with TMPDIR set elsewhere got a directory that was writable
// through Landlock with no mount over it: temp files landed on the host, outside the
// sandbox. The spec now names that directory, and the helper mounts on what it names.
{
  const previousTmpdir = process.env.TMPDIR
  const scratch = join(workdir, "scratch-outside-tmp")
  mkdirSync(scratch, { recursive: true })
  process.env.TMPDIR = scratch
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const input = { command: "pnpm run typecheck" }
  assert.equal(await h.call("bash", input), undefined, "a listed command still passes with a custom TMPDIR")
  const spec = specOf(input.command)
  assert.equal(
    spec.tmp,
    scratch,
    "the spec names the directory the command's temp files land in, so the helper puts its tmpfs there",
  )
  assert.ok(spec.write.includes(scratch), "that directory is writable, which is only safe together with the mount above")
  assert.ok(spec.write.includes("/tmp"), "the conventional /tmp stays writable: XDG_RUNTIME_DIR and MISE_STATE_DIR point into it")
  h.restore()
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir

  // 没有自定义 TMPDIR 时字段省略：/tmp 本来就是 helper 的默认值，而不带这个字段的 spec
  // 仍能被旧版 helper 解开（它的 spec 解析是 deny_unknown_fields）。
  delete process.env.TMPDIR
  const plain = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const plainInput = { command: "pnpm run typecheck" }
  assert.equal(await plain.call("bash", plainInput), undefined, "listed command passes")
  assert.equal(
    specOf(plainInput.command).tmp,
    tmpdir() === "/tmp" ? undefined : tmpdir(),
    "only a scratch dir that differs from the helper's default is spelled out",
  )
  plain.restore()
  if (previousTmpdir !== undefined) process.env.TMPDIR = previousTmpdir
  console.log("  ok   TMPDIR 不在 /tmp 下时，那个目录也写进 spec 并被私有化；默认值时不写")
}



// 63. 启动前的依赖完整性闸门：有 lockfile 却没有 node_modules/.bin 的目录，构建/测试命令直接失败并点名。
//     代价是每个目录一次 readdir；换来的是第一条构建命令不会在沙箱里自己去装依赖然后卡住。
//     计数归属：它拒的是环境，不是授权 —— 重试也不会变好，所以不进任何预算。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "web"), { recursive: true })
  writeFileSync(join(tree, "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        maxDenies: 1,
        bash: { read: ["git status", "rg"], write: ["git commit", "pnpm test", "mise run test", "mkdir docs"] },
      },
    }),
  })
  const first = await h.call("bash", { command: "pnpm test" })
  assert.equal(first?.block, true, "a build is refused while a lockfile directory has no node_modules")
  assert.match(first.reason, /web/, "the refusal names the directory that is missing")
  assert.match(first.reason, /node_modules\/\.bin/, "and names what is missing in it")
  assert.match(first.reason, /contact_supervisor/, "and the way out")
  assert.equal(first.terminate, undefined, "the first refusal does not stop the run")

  // 判别式：授权预算压到 1。若这类拒绝记在预算上，第二次就 warn、第三次就硬停。
  const second = await h.call("bash", { command: "pnpm test" })
  assert.doesNotMatch(String(second?.reason), /in a row/, "an uninstalled dependency is not an authorisation refusal")
  const third = await h.call("bash", { command: "pnpm test" })
  assert.equal(third?.terminate, undefined, "retrying never reaches a hard stop: retrying cannot install anything")

  // git 不受闸门管：它不需要 node_modules，而「先落任务日志再提交」的保树纪律
  // 恰恰在依赖缺失时最要用得上。只读命令同理。
  // 判据是「写类」还是「包管理器」，不是名字里有没有 pnpm：写类但非包管理器的
  // 构建入口（mise run test）与写类命令（mkdir）同样会对着没装好的依赖去跑。
  const mise = await h.call("bash", { command: "mise run test" })
  assert.equal(mise?.block, true, "a write-classified build entry is gated though it is not a package manager")
  const mkdir = await h.call("bash", { command: "mkdir docs" })
  assert.equal(mkdir?.block, true, "so is an ordinary write command")

  const gitRead = await h.call("bash", { command: "git status" })
  assert.notEqual(gitRead?.block, true, "a read-class git command passes the gate")
  const gitWrite = await h.call("bash", { command: "git commit" })
  assert.notEqual(gitWrite?.block, true, "even a write-class git command passes it")
  const readOnly = await h.call("bash", { command: "rg foo" })
  assert.notEqual(readOnly?.block, true, "a read-class non-git command passes too")

  // 包管理器即使被写在 read 列也拦：那条路就是去装依赖。
  const pm = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm typecheck"] } } }),
  })
  const install = await pm.call("bash", { command: "pnpm typecheck" })
  assert.equal(install?.block, true, "a package manager is gated even when the allowlist calls it read-only")
  pm.restore()

  // 补上 .bin 之后立刻可用（目录清单有缓存，缺的那一项每轮重查）。
  mkdirSync(join(tree, "web", "node_modules", ".bin"), { recursive: true })
  const allowed = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(allowed?.block, true, "once every lockfile directory has node_modules/.bin the gate opens")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门：缺 node_modules/.bin 拦构建与包管理器，放行 git 与只读命令，且不占任何预算")
}

// 64. 闸门可以关掉：任务可能只需要读文件，装依赖本就是另一件事。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-off-"))
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: false } },
    }),
  })
  const out = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(out?.block, true, "dependencyGate: false turns the gate off")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门可以关：bash.dependencyGate=false 时不检查")
}

// 65. 只有 package.json 的目录不算依赖根：那可能只是个配置包，永远不会装依赖。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-nolock-"))
  writeFileSync(join(tree, "package.json"), "{}")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["git status"] } } }),
  })
  const out = await h.call("bash", { command: "git status" })
  assert.notEqual(out?.block, true, "no lockfile means no dependency root, so the gate stays out of the way")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门只认 lockfile：只有 package.json 的目录不触发")
}

// 66. 包装器不能从侧面跳过闸门：`sh -c "pnpm test"`、`env pnpm test` 的载荷里是包管理器，
//     只看第一个词会把它们当成阅读类放过去。反过来，`rg pnpm` 是搜这个词，不该被拦。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-wrap-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        bash: { read: ["sh", "env", "exec", "rg", "command"], write: ["/usr/bin/pnpm test", "env git commit"] },
      },
    }),
  })
  for (const cmd of ['sh -c "pnpm test"', "env pnpm test", "exec pnpm test", "/usr/bin/pnpm test"]) {
    const out = await h.call("bash", { command: cmd })
    assert.equal(out?.block, true, `the gate sees the package manager through ${cmd}`)
    assert.match(String(out?.reason), /node_modules\/\.bin/, "and refuses for the documented reason")
  }
  const searching = await h.call("bash", { command: "rg pnpm" })
  assert.notEqual(searching?.block, true, "mentioning the word is not invoking it")
  const wrappedSearch = await h.call("bash", { command: 'sh -c "rg pnpm"' })
  assert.notEqual(wrappedSearch?.block, true, "a wrapper does not turn a search into an install")
  const lookup = await h.call("bash", { command: "command -v pnpm" })
  assert.notEqual(lookup?.block, true, "asking whether a tool exists is not running it")
  const gitInWrapper = await h.call("bash", { command: "env git commit" })
  assert.notEqual(gitInWrapper?.block, true, "the git exemption survives a wrapper")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门穿透包装器，但不误伤提到包管理器名字的搜索")
}

// 67. 深度要与工具链探测一致：lockfile 在第二代子目录（apps/web）里同样算依赖根。
//     只查一代的话，标准 monorepo 与「lockfile 在 packages/* 里」的仓库完全逃过闸门。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-depth-"))
  writeFileSync(join(tree, "package.json"), "{}")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })
  mkdirSync(join(tree, "apps", "web"), { recursive: true })
  writeFileSync(join(tree, "apps", "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"] } } }),
  })
  const out = await h.call("bash", { command: "pnpm test" })
  assert.equal(out?.block, true, "a lockfile one generation deeper is still a dependency root")
  assert.match(String(out?.reason), /apps\/web/, "and the refusal names it")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门看两层：apps/web 这种第二代目录不会漏")
}

// 68. Yarn 2+ 的 PnP 不建 node_modules，装好的凭据是 .pnp.cjs。
//     只认 node_modules/.bin 会把整套 PnP 仓库永久判成「没装」，每条写命令都被拒。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-pnp-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "yarn.lock"), "")
  writeFileSync(join(tree, ".pnp.cjs"), "// pnp\n")
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["yarn test"] } } }),
  })
  const out = await h.call("bash", { command: "yarn test" })
  assert.notEqual(out?.block, true, "a PnP install counts as installed")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门认 Yarn PnP：.pnp.cjs 等于装好了")
}

// 69. 没人安装的 lockfile 目录可以点名忽略。树上常年躺着 fixtures/ 这种样例工程、或者
//     vendored 了一份样例仓库，一纸没人会去安装的 lockfile 于是把所有写类命令都挡了；
//     只关整道闸门等于把真包也一起交出去。忽略的是目录前缀：按 cwd 解析、对齐目录边界，
//     被忽略的那棵树里第一代与第二代目录都不再贡献拒绝，而名字相近的邻居不算被忽略。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-ignore-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })
  // 被忽略的样例工程：自己一层和下一代目录都有 lockfile，都没装。
  mkdirSync(join(tree, "fixtures", "sample"), { recursive: true })
  writeFileSync(join(tree, "fixtures", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  writeFileSync(join(tree, "fixtures", "sample", "package-lock.json"), "{}\n")
  // 真包：没人忽略它，它缺安装就应该继续拦。
  mkdirSync(join(tree, "apps", "web"), { recursive: true })
  writeFileSync(join(tree, "apps", "web", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures"] } },
    }),
  })
  const blocked = await h.call("bash", { command: "pnpm test" })
  assert.equal(blocked?.block, true, "a directory nobody ignores still blocks the write")
  assert.match(String(blocked?.reason), /apps\/web/, "and it is still named")
  assert.doesNotMatch(
    String(blocked?.reason),
    /fixtures/,
    "the ignored tree is not named, neither its first nor its second generation",
  )

  // 边界对齐：前缀是目录，不是字符串开头。
  mkdirSync(join(tree, "fixtures-old"), { recursive: true })
  writeFileSync(join(tree, "fixtures-old", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  const neighbour = await h.call("bash", { command: "pnpm test" })
  assert.equal(neighbour?.block, true, "an ignored prefix does not swallow a directory that merely starts the same")
  assert.match(String(neighbour?.reason), /fixtures-old/, "the neighbour outside the prefix is named")

  // 装上真包之后，被忽略的那棵树照旧没装，写类命令应当畅通：这就是这条配置的全部意义。
  mkdirSync(join(tree, "apps", "web", "node_modules", ".bin"), { recursive: true })
  mkdirSync(join(tree, "fixtures-old", "node_modules", ".bin"), { recursive: true })
  const allowed = await h.call("bash", { command: "pnpm test" })
  assert.notEqual(allowed?.block, true, "an uninstalled ignored directory does not block a write once the real ones are installed")
  h.restore()

  // cwd 自己落在被忽略的前缀里（任务被限制在那个样例目录内）同样不查。
  // 这一条只能用**绝对**前缀表达：相对前缀永远在 cwd 之下，包含不了 cwd。
  const inner = await handler({
    cwd: join(tree, "fixtures", "sample"),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: [join(tree, "fixtures")] } },
    }),
  })
  const atCwd = await inner.call("bash", { command: "pnpm test" })
  assert.notEqual(atCwd?.block, true, "an absolute prefix containing the cwd means nothing is gated")
  inner.restore()

  // 同一个目录，同一份 lockfile，只把前缀换成相对写法：这一次必须被拦。
  // 这条钉住「相对前缀在 cwd 之下」，否则上面那条会被误读成「任意写法都行」。
  const relInner = await handler({
    cwd: join(tree, "fixtures", "sample"),
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures"] } },
    }),
  })
  const relCwd = await relInner.call("bash", { command: "pnpm test" })
  assert.equal(relCwd?.block, true, "a relative prefix cannot contain the cwd, so this one still blocks")
  relInner.restore()

  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门可忽略目录前缀：忽略的树不贡献拒绝，真包照拦，cwd 同样适用")
}

// 81. 闸门的扫描同样停在 200 个目录，而且忽略项写成 glob 会被点名。
//     缺陷一：`dependencyScope` 只有内层 break，外层 frontier 里每个剩余目录还会各推一个子
//     目录，250 个目录的树能得 246 个 root，而文档说的是 200。
//     缺陷二：忽略项是字面路径，`fixtures/*` 静默匹配不到任何目录，正是文档自称要避免的调试题。
{
  // 25 × 10 = 250 个第二代目录，加树根与 25 个第一代目录共 276 个名额，上限 200。
  // 判别点放在 a24/b0：内层 break 一旦在 200 处停住，外层若不断，frontier 里剩下的每个
  // 第一代目录还会各推一个 b0 进来（a18..a24），a24/b0 就落到范围内；外层断了就不会。
  // 所以这里放 lockfile 且不装依赖：上限生效 → 放行，上限失效 → 被拦。名字补零，字典序即自然序。
  // 25 × 10 = 250 个第二代目录，加树根与 25 个第一代目录共 276 个候选名额，上限 200。
  // 直接测扫描结果本身：内层 break 只退出当前目录，外层若不断，frontier 里剩下的每个
  // 第一代目录还会各推一个 b0 进来，总数会变成 207 而不是 200。
  const wide = mkdtempSync(join(tmpdir(), "pi-subagents-extend-cap-"))
  for (let a = 0; a < 25; a += 1) {
    for (let b = 0; b < 10; b += 1) mkdirSync(join(wide, `a${String(a).padStart(2, "0")}`, `b${b}`), { recursive: true })
  }
  const scanned = ext.dependencyScope(wide, [])
  assert.equal(scanned.length, 200, "the scan stops at the 200-directory cap")
  assert.ok(!scanned.includes(join(wide, "a24", "b0")), "and the directories beyond it are not scanned")
  assert.ok(scanned.includes(join(wide, "a00", "b0")), "while the early ones are")
  rmSync(wide, { recursive: true, force: true })

  // glob 写成忽略项：闸门照旧拒绝，但文案要点名它匹配不到任何目录。
  // 必须是「有 lockfile、没装依赖」的目录，闸门才会真的拒绝并给出提示。
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-glob-"))
  mkdirSync(join(tree, "fixtures"), { recursive: true })
  writeFileSync(join(tree, "fixtures", "package.json"), "{}")
  writeFileSync(join(tree, "fixtures", "pnpm-lock.yaml"), "lockfileVersion: 9\n")
  const globH = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: ["fixtures/*"] } },
    }),
  })
  const globbed = await globH.call("bash", { command: "pnpm test" })
  assert.equal(globbed?.block, true, "a glob ignore entry matches nothing, so the gate still refuses")
  assert.match(globbed.reason, /literal paths, not globs/, "and says so instead of leaving it to be discovered")
  assert.match(globbed.reason, /fixtures\/\*/, "naming the entry that did not apply")
  globH.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   闸门扫描封在 200 个目录；忽略项写成 glob 会被点名")
}

// 70. 数组写法不能顺手改掉两个老含义：`false` 仍是整道闸门的开关，显式 `true` 仍是「查全部」。
//     把 false 解析成「空清单」、或把 true 当成清单，闸门都会静默失效或静默全开。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deps-switch-"))
  writeFileSync(join(tree, "package.json"), "{}")
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")

  const bind = (gate: unknown) =>
    JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { write: ["pnpm test"], dependencyGate: gate } } })

  const off = await handler({ cwd: tree, bindings: bind(false) })
  const unchecked = await off.call("bash", { command: "pnpm test" })
  assert.notEqual(unchecked?.block, true, "false still means check nothing, not an empty ignore list")
  off.restore()

  const on = await handler({ cwd: tree, bindings: bind(true) })
  const checked = await on.call("bash", { command: "pnpm test" })
  assert.equal(checked?.block, true, "explicit true still checks every directory")
  assert.match(String(checked?.reason), /node_modules\/\.bin/, "and refuses for the documented reason")
  on.restore()

  // 空清单是「不忽略任何目录」，不是「不查」：两个含义只差一个词，后果却是闸门全关。
  const empty = await handler({ cwd: tree, bindings: bind([]) })
  const stillChecked = await empty.call("bash", { command: "pnpm test" })
  assert.equal(stillChecked?.block, true, "an empty ignore list still checks every directory")
  empty.restore()

  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   依赖闸门开关没变：false 全不查，true 查全部")
}

// 71. 缺陷：两处广度优先扫描（工具链探测、依赖闸门）都按 readdir 的顺序取前
// DETECT_MAX_ROOTS 个目录，而这个顺序由文件系统决定 —— 这台机器上 tmpfs 给的是排序
// 结果，ext4 的 dir_index、XFS、NFS 给的是哈希序。同一个仓库在两台机器上因此可能扫到
// 不同的目录，闸门在一台机器上放行、在另一台上拒绝，而且没有任何日志能看出差别。
// 磁盘上的顺序在本机造不出来（readdir 已经是有序的），所以这里钉的是比较器本身：
// 扫描用的排序必须是字典序、且不受 locale 影响。
{
  const shuffled = ["mike", "alpha", "zeta", "delta", "Bravo"].map((name) => ({ name }))
  const sorted = ext.sortByName(shuffled).map((entry) => entry.name)
  assert.deepEqual(
    sorted,
    ["Bravo", "alpha", "delta", "mike", "zeta"],
    "the scan sorts by code unit, so the same tree yields the same directories on any filesystem",
  )

  // 排序不能是 localeCompare：在 sv-SE 之类的 locale 下 "zeta" 会排到 "Bravo" 前面，
  // 那样顺序又变成了环境依赖。
  const pairs = ["zeta", "Bravo", "ä", "A"].map((name) => ({ name }))
  assert.deepEqual(
    ext.sortByName(pairs).map((entry) => entry.name),
    ["A", "Bravo", "zeta", "ä"],
    "sorting is not locale-sensitive",
  )
  console.log("  ok   扫描顺序是字典序，不随文件系统与 locale 变化")
}



// 82. bash 配了却跑不起来时，开场就说，而不是让子代理撞几次墙再自己推断。
//     （实测过：helper 没装时子代理连跑四条命令，每条都拿到同一句「helper not found」，
//     它最后自己得出了这个结论 —— 但那是四次调用换来的。）
{
  const real = process.env.PI_SUBAGENTS_EXTEND_HELPER
  process.env.PI_SUBAGENTS_EXTEND_HELPER = "/nonexistent/pi-subagents-extend-helper"

  const missing = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const said = missing.ui.join("\n")
  assert.match(said, /no sandbox helper found/, "a missing helper is announced when the session starts")
  assert.match(said, /build:helper/, "and it names the command that fixes it")
  const refused = await missing.call("bash", { command: "ls" })
  assert.equal(refused?.block, true, "bash is refused rather than attempted")
  missing.restore()

  // 没开 bash 的会话不该被这条告警打扰。
  const noBash = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."] } }),
  })
  assert.doesNotMatch(noBash.ui.join("\n"), /sandbox helper/, "a session with bash off says nothing")
  noBash.restore()

  if (real === undefined) delete process.env.PI_SUBAGENTS_EXTEND_HELPER
  else process.env.PI_SUBAGENTS_EXTEND_HELPER = real

  // 候选顺序：包装好的 bin/ 优先，其次是仓内 cargo 产物 —— 后者正是「建好了但没拷」的兜底。
  const candidates = ext.helperCandidates("/x/packages/pi-plugin/src")
  assert.equal(candidates[0], "/x/packages/pi-plugin/bin/pi-subagents-extend-helper")
  assert.equal(
    candidates[1],
    "/x/packages/helper/target/release/pi-subagents-extend-helper",
    "the cargo artifact is a runtime candidate",
  )
  assert.ok(
    !candidates.some((c) => c.includes("subagent-permission")),
    "the pre-rename cache directory is not a candidate",
  )
  console.log("  ok   缺 helper 开场告警；候选含仓内 cargo 产物，旧目录已移除")
}

// 83. 拒绝文案必须点名「被拒的命令」。早先只印允许列表，实测被读成
//     「command not in the allowlist: ls」→「ls 不被接受」，而真正被拒的是别的命令。
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const refused = await h.call("bash", { command: "pwd" })
  assert.equal(refused?.block, true, "a command outside the list is refused")
  assert.match(refused.reason, /not in the allowlist: "pwd"/, "the message names the command that was refused")
  assert.match(refused.reason, /allowed: ls/, "and keeps listing what is allowed")
  h.restore()
  console.log("  ok   拒绝文案点名被拒的命令，并附允许列表")
}

// 84. 并行 bash 必须各用各的 spec 文件。早先文件名是 spec-<pid>.json（一进程一个），
//     pi 并行发工具调用时会互相覆盖：先起的 helper 可能读到后一条的 spec，拿到错的
//     写清单与 cwd。这里在同一进程里连发两次调用、都不等结果，然后比对两份文件。
//
//     说清能钉住什么：文件名与生命周期可以（下面这些断言）；**内容归属**不行 —— rule
//     来自 policy 而不是来自某一次调用，同一 handler 下两份 spec 的 cwd/offline/write
//     按构造必然相同，用 deepEqual 比较只会得到「它们一样」，实现退回单文件时那句也
//     照样通过（早先就是这么写的）。归属靠文件名区分加用例 85 的覆盖/清理行为来钉。
{
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls", "git status"], writable: true } },
    }),
  })
  const first = { command: "ls" }
  const second = { command: "git status" }
  const firstOutcome = await h.call("bash", first, "c1")
  assert.equal(firstOutcome?.block ?? false, false, "first call is allowed")
  const secondOutcome = await h.call("bash", second, "c2")
  assert.equal(secondOutcome?.block ?? false, false, "second call is allowed")
  const firstSpec = specPathOf(first.command)
  const secondSpec = specPathOf(second.command)
  assert.notEqual(firstSpec, secondSpec, "concurrent calls get distinct spec files")
  // 两份都还在（结果还没回来），而且都能整份解析 —— 半截 JSON 会在 specOf 里抛。
  assert.ok(existsSync(firstSpec), "the first spec survives the second call")
  const a = specOf(first.command)
  const b = specOf(second.command)
  assert.equal(a.cwd, workdir, "the first spec carries its own cwd")
  assert.equal(b.cwd, workdir, "the second spec carries its own cwd")
  assert.ok(a.write.length > 0 && b.write.length > 0, "both specs carry a resolved write list")
  // 结果回来后清掉，避免每个 bash 调用留一份垃圾。
  await h.result("bash", "ok", false, "c1")
  await h.result("bash", "ok", false, "c2")
  assert.equal(existsSync(firstSpec), false, "the first spec is removed once its result is in")
  assert.equal(existsSync(secondSpec), false, "the second spec is removed too")
  h.restore()
  console.log("  ok   并行调用各用各的 spec 文件，结果回来后清理")
}

// 85. spec 文件的生命周期：结果回来删自己的；重复 id 留下的孤儿与陈旧的交给会话结束清扫。
//     早先只在 tool_result 里删，其余路径全部遗留 —— 实测这台机器上堆了 2993 份，
//     因为「每次调用一份文件名」把「互相覆盖」换成了「互相累积」。
{
  // (a) 同一 toolCallId 又来一次：只覆盖条目，旧文件**不能**删 —— 我们判断不出先那次是否
  //     已经启动，删掉会让一个在途 helper 以 exit 77 死在「读不到 spec」上；孤儿交给清扫。
  //     两个方向都断言，否则实现改成「删」或「不删」都能过。
  const h = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const first = { command: "ls" }
  await h.call("bash", first, "dup")
  const firstSpec = specPathOf(first.command)
  assert.ok(existsSync(firstSpec), "the first spec is written")
  const second = { command: "ls" }
  await h.call("bash", second, "dup")
  const secondSpec = specPathOf(second.command)
  assert.notEqual(secondSpec, firstSpec, "the repeat gets its own file")
  assert.ok(existsSync(firstSpec), "the superseded spec is left to the sweep instead of deleted under a live helper")
  assert.ok(existsSync(secondSpec), "the live one stays until its result arrives")
  await h.result("bash", "ok", false, "dup")
  assert.equal(existsSync(secondSpec), false, "and is removed when the result arrives")
  h.restore()

  // (b) session_shutdown 按年龄清扫：陈旧的清掉，新的留着（别的进程可能正在用），
  //     同一目录里的 git-excludes 绝不能碰。清扫读的是状态目录，所以把它指到临时目录。
  const h2 = await handler({
    cwd: workdir,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["ls"] } } }),
  })
  const fakeState = mkdtempSync(join(tmpdir(), "pi-specsweep-"))
  const cache = fakeState
  mkdirSync(cache, { recursive: true })
  const staleSpec = join(cache, "spec-1-1-t1.json")
  const staleTemp = join(cache, "spec-1-3-t3.json.tmp")
  const freshSpec = join(cache, "spec-1-2-t2.json")
  const excludes = join(cache, "git-excludes")
  for (const path of [staleSpec, staleTemp, freshSpec]) writeFileSync(path, "{}")
  writeFileSync(excludes, "*.log\n")
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(staleSpec, old, old)
  utimesSync(staleTemp, old, old)
  // git-excludes 也改老：否则「年龄闸门」本身就保住了它，前缀过滤那条守卫就没人钉。
  utimesSync(excludes, old, old)
  const previousState = process.env.PI_SUBAGENTS_EXTEND_STATE
  process.env.PI_SUBAGENTS_EXTEND_STATE = fakeState
  try {
    await h2.shutdown()
  } finally {
    if (previousState === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
    else process.env.PI_SUBAGENTS_EXTEND_STATE = previousState
  }
  assert.equal(existsSync(staleSpec), false, "a stale spec is swept at shutdown")
  assert.equal(existsSync(staleTemp), false, "a stale half-written temp file is swept too")
  assert.equal(existsSync(freshSpec), true, "a fresh spec is left alone for its own process")
  assert.equal(existsSync(excludes), true, "git-excludes in the same directory is untouched")
  h2.restore()
  rmSync(fakeState, { recursive: true, force: true })
  console.log("  ok   spec 生命周期：结果回来删自己的、重复 id 的孤儿留给清扫、别的文件不碰")
}

// 86. 前置环境变量赋值不该让白名单失效：`HOME=/tmp/x node a.ts` 跑的就是 `node a.ts`。
//     实测撞到过——同一个被允许的 `node` 被拒成「command not in the allowlist」，而那行文案里
//     恰好列着 node，看起来像自相矛盾。三个方向都要钉住，否则「剥太多」也能全绿：
//       (a) 只剥最前面连续的赋值，命令中间的 `A=1` 不动；
//       (b) 带引号的值、`+=` 追加赋值同样算赋值（按空白切词会把它们切坏、误拒）；
//       (c) 能改变「跑哪个程序 / 加载哪段代码」的名字必须拒 —— 带上它，被允许的命令
//           就等于跑任意代码（`NODE_OPTIONS=--require=/tmp/x.js node` 实测会执行 /tmp/x.js）。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-assign-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["."],
        bash: { read: ["git status", "node", "re:^ls -la$"] },
      },
    }),
  })
  const assigned = await h.call("bash", { command: "HOME=/tmp/pi-home node script.mjs" })
  assert.notEqual(assigned?.block, true, "an assignment prefix does not defeat a plain entry")
  const twoAssignments = await h.call("bash", { command: "A=1 B=2 git status" })
  assert.notEqual(twoAssignments?.block, true, "several assignments are stripped too")
  const stillRefused = await h.call("bash", { command: "HOME=/tmp/pi-home rm -rf src" })
  assert.equal(stillRefused?.block, true, "stripping the prefix does not allow a command that is not listed")
  // (a) 命令中间的赋值不是前缀：`git A=1 status` 的真实 argv 是 [git, A=1, status]，不是 git status。
  //     换成「剥掉所有赋值形状的 token」时这条会变成允许 —— 正是这里要挡的过度剥离。
  const midCommandAssignment = await h.call("bash", { command: "git A=1 status" })
  assert.equal(midCommandAssignment?.block, true, "only leading assignments are stripped")
  // (b) 带引号的空格值、`+=` 追加赋值：bash 都当赋值，按空白切词会切坏。
  const quotedValue = await h.call("bash", { command: 'HOME="/tmp/my home" node script.mjs' })
  assert.notEqual(quotedValue?.block, true, "a quoted value with spaces is still one assignment")
  const appendAssignment = await h.call("bash", { command: "A+=1 node script.mjs" })
  assert.notEqual(appendAssignment?.block, true, "an append assignment (+=) is an assignment")
  // (c) 注入入口：这些名字一旦放行，白名单就形同虚设，所以命中即拒并点名。
  const nodeOptions = await h.call("bash", { command: "NODE_OPTIONS=--require=/tmp/evil.js node -e ''" })
  assert.equal(nodeOptions?.block, true, "NODE_OPTIONS is refused: it preloads code into an allowed node")
  assert.match(String(nodeOptions?.reason), /NODE_OPTIONS/, "the note names the offending variable")
  const gitExternalDiff = await h.call("bash", { command: "GIT_EXTERNAL_DIFF=/tmp/evil git status" })
  assert.equal(gitExternalDiff?.block, true, "GIT_* is refused: git runs it as a subcommand")
  const pathSwap = await h.call("bash", { command: "PATH=/tmp/evil git status" })
  assert.equal(pathSwap?.block, true, "PATH is refused: it swaps which program runs")
  // 正向控制：同样的命令去掉注入名字后仍然放行，否则上面三条可以靠「一律拒绝」骗过去。
  const benignAgain = await h.call("bash", { command: "HOME=/tmp/x node script.mjs" })
  assert.notEqual(benignAgain?.block, true, "a benign name is still allowed after the denied ones are refused")
  // 正则条目仍是整串匹配：作者写的是真实命令行，赋值前缀该由作者自己决定要不要认。
  const regexStillSeesAssignment = await h.call("bash", { command: "HOME=/tmp/x ls -la" })
  assert.equal(regexStillSeesAssignment?.block, true, "re: entries keep matching the command as written")
  const regexPlain = await h.call("bash", { command: "ls -la" })
  assert.notEqual(regexPlain?.block, true, "the same re: entry still matches the bare command")
  h.restore()
  console.log("  ok   前置赋值：只剥前缀、引号与 += 也算、注入名字拒绝，正则条目仍按原文匹配")
}

// 87. 锚点编辑族按写工具判：本条只用 `replace` 验证「进了 allowTools 也绕不开写范围」，
//     其余成员在 87（缺目标）、88（undo_last_change）、94（copy/move 两侧）、97（显式 path）分别钉。
//     宿主上 pi-hashline-edit-pro 会把内置 edit 从活动工具集里删掉，只认 edit 的名字表在
//     那里等于「整套编辑能力都是未知工具」。同时钉住顺序：allowTools 不能成为绕过路径判定的
//     后门——把 replace 写进 allowTools 之后仍必须受写范围约束。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-hashline-"))
  mkdirSync(join(tree, "src"), { recursive: true })
  writeFileSync(join(tree, "src", "a.ts"), "a\n")

  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["src/**"], allowTools: ["replace"], bash: false },
    }),
  })
  const inside = await h.call("replace", { path: "src/a.ts", remove_from: "x", text: "y" })
  assert.notEqual(inside?.block, true, "replace inside the scope is allowed")
  const outside = await h.call("replace", { path: "outside/b.ts", remove_from: "x", text: "y" })
  assert.equal(outside?.block, true, "replace outside the scope is refused")
  assert.match(
    String(outside?.reason),
    /outside the scope|not writable/,
    "refused by the scope, not waved through by allowTools",
  )
  h.restore()
  console.log("  ok   hashline 编辑族按写工具判，allowTools 不能绕过写范围")
}







// 99. 写授权落在私有 tmpfs 之下时剔掉，而不是让 helper 拒掉整份 spec。
//     helper 在 /tmp（和 spec 的 tmp）上挂私有 tmpfs，挂载之后落在其下的授权路径从它的视图里
//     消失，于是整份 spec 被拒（exit 77）—— 一条命令都跑不了。授权那个目录本身仍有效（挂载点还在），
//     所以只剔严格在下的，并且把这件事告诉父代理一次（静默丢弃会让子代理反复撞「写不进去」）。
//     真实触发面不是 writeScope 的绝对授权（它走 absoluteWrite，不进 bash 的可写面），而是
//     bash.writablePaths，以及 HOME 落在 /tmp 下的 toolchainCacheDir()（容器与 CI 就是这样）。
{
  const grant = join(tmpdir(), `pi-hidden-grant-${process.pid}`)
  // cwd 必须不在 /tmp 下：helper 只在 cwd 不落在该目录时才挂私有 tmpfs（否则会盖住工作目录），
  // 而测试的 workdir 本身就在 tmpdir() 里。`.test-*` 已在 .gitignore 里，不会污染工作树。
  const outsideTmp = mkdtempSync(join(repo, ".test-cwd-"))
  mkdirSync(grant, { recursive: true })
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grant] },
      },
    }),
    cwd: outsideTmp,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "命令本身照旧放行：配置问题不该让 bash 全灭")
  const spec = specOf(input.command)
  assert.ok(!spec.write.includes(grant), "落在私有 tmpfs 之下的授权被剔掉")
  assert.ok(spec.write.includes(tmpdir()), "被私有化的目录本身仍可写，否则 /tmp 上的任何写入都用不了")
  assert.equal(
    h.ui.filter((m) => m.includes(grant)).length,
    1,
    "剔掉这件事告诉父代理一次：不说的话，子代理只看到写被拒",
  )
  // 同一条命令再来一次不该重复提示 —— 每条命令一份 spec，否则警告会淹没整个会话。
  await h.call("bash", { command: "git status" })
  assert.equal(
    h.ui.filter((m) => m.includes(grant)).length,
    1,
    "第二次调用不重复提示",
  )
  // 同一个进程里的**下一个会话**必须重新提示：提示状态是模块级的，若不在 session_start 重置，
  // 新会话会静默吞掉本该发出的告警（丢了，不是重复）。用同一条授权路径才钉得住这一点。
  const nextSession = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grant] },
      },
    }),
    cwd: outsideTmp,
  })
  const nextInput = { command: "git status" }
  assert.equal(await nextSession.call("bash", nextInput), undefined, "下一个会话的命令照旧放行")
  assert.equal(
    nextSession.ui.filter((m) => m.includes(grant)).length,
    1,
    "下一个会话重新提示一次：模块级状态不重置就会永久吞掉这条告警",
  )
  nextSession.restore()
  h.restore()

  // 正控：树内的授权照旧写进 spec —— 否则「一律剔掉」也能过上面几条。
  const inside = join(outsideTmp, "inside-grant")
  mkdirSync(inside, { recursive: true })
  const tree = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [inside] },
      },
    }),
    cwd: outsideTmp,
  })
  const command = { command: "git status" }
  assert.equal(await tree.call("bash", command), undefined, "树内授权的命令放行")
  assert.ok(specOf(command.command).write.includes(inside), "树内的写授权仍然进 spec")
  assert.equal(tree.ui.filter((m) => m.includes("write grant(s) dropped")).length, 0, "树内授权不触发丢弃提示")
  tree.restore()
  rmSync(grant, { recursive: true, force: true })
  rmSync(outsideTmp, { recursive: true, force: true })
  console.log("  ok   落在私有 tmpfs 之下的写授权被剔掉，并提示父代理一次")
}

// 100. 经软链指向私有化目录的授权同样要剔掉。
//      helper 把两边都解析软链后比较（resolve_comparable），插件若按原字符串比就会保留这条授权，
//      而 helper 会因它拒掉整份 spec —— 又回到「一条命令都跑不了」。反方向同样有害：插件比 helper
//      更激进时，一条本来能用的授权会被白白剔掉。
{
  const outsideTmp = mkdtempSync(join(repo, ".test-cwd-"))
  // 指向 tmpdir()（私有化目录）的软链：插件按原字符串看不在 /tmp 下，按真实路径看在。
  const toTmp = join(outsideTmp, "link-to-tmp")
  symlinkSync(tmpdir(), toTmp)
  const grantViaLink = join(toTmp, "pi-hidden-target")
  mkdirSync(grantViaLink, { recursive: true })

  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grantViaLink] },
      },
    }),
    cwd: outsideTmp,
  })
  const input = { command: "git status" }
  assert.equal(await h.call("bash", input), undefined, "命令照旧放行")
  assert.ok(
    !specOf(input.command).write.includes(grantViaLink),
    "经软链指向私有化目录的授权被剔掉：helper 解析软链后会拒绝整份 spec",
  )
  assert.equal(
    h.ui.filter((m) => m.includes(grantViaLink)).length,
    1,
    "并且点名提示了这条软链授权",
  )
  // 缺失的尾巴必须原样保留、祖先软链必须解析：helper 的 resolve_comparable 就是这个语义，而
  // buildSpec 能产出的授权都真实存在，所以这一段是直接钉函数本身，补上「缺失尾巴」这条覆盖缺口。
  assert.equal(
    ext.resolveComparable(join(toTmp, "not-created-yet")),
    join(tmpdir(), "not-created-yet"),
    "缺失尾巴保留、祖先软链解析：与 helper 一致，否则『命令即将创建的目录』会被判成另一条路径",
  )
  // `..` 原样保留，不归一化：Rust 那边是 push 进去的，归一化会让两边对同一条授权给出不同结论。
  assert.equal(
    ext.resolveComparable(`${tmpdir()}/pi-nx/../x`),
    `${tmpdir()}/pi-nx/../x`,
    "缺失段里的 `..` 原样保留，与 helper 逐字节一致",
  )
  h.restore()

  // 正控：软链指向树内目录时，授权照旧保留 —— 否则「看见软链就剔」也能过上面几条。
  const insideTarget = join(outsideTmp, "real-inside")
  mkdirSync(join(insideTarget, "build"), { recursive: true })
  const toInside = join(outsideTmp, "link-to-inside")
  symlinkSync(insideTarget, toInside)
  const grantInside = join(toInside, "build")
  const tree = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": {
        scope: ["src/**"],
        bash: { read: ["git status"], writable: true, writablePaths: [grantInside] },
      },
    }),
    cwd: outsideTmp,
  })
  const inside = { command: "git status" }
  assert.equal(await tree.call("bash", inside), undefined, "树内软链授权的命令放行")
  assert.ok(
    specOf(inside.command).write.includes(grantInside),
    "软链指向树内目录时授权保留：不能比 helper 更激进",
  )
  tree.restore()
  rmSync(outsideTmp, { recursive: true, force: true })
  console.log("  ok   经软链指向私有化目录的写授权被剔掉，指向树内的照旧保留")
}


// 101. Regression pin for applyRoleBaseline: a dispatch that declares its own `bash` block used
//      to skip the role md's whole `bash` field — including `deny` — so a caller narrowing the
//      role with `bash: { allow: [...] }` could silently re-allow a banned command. deny is a
//      floor across layers (same contract as mergeConfig): the effective bash is the payload's
//      allowlist plus the md's deny union, and because the deny union is the md contributing,
//      the refusal's source must name the md too.
{
  const proj = join(workdir, "proj-deny-floor")
  const body = "Role policy for review: inspect with git; the deny list is a hard floor."
  writeAgentMd({
    cwd: proj,
    role: "review",
    extend: { permissions: { bash: { allow: ["git diff"], deny: ["git stash"] } } },
    body,
  })
  const h = await mdChild({
    cwd: proj,
    prompt: childSystemPrompt("review", body),
    // The dispatch declares bash and its own allowlist even names the banned command:
    // exactly the payload shape that used to strip the md's deny list.
    bindings: JSON.stringify({
      // `writable: true` so the write-class `git stash` is not refused for a second reason:
      // under the regression the only thing standing between it and execution is the md's deny.
      "pi-subagents-extend/1": { permissions: { scope: ["src/**"], bash: { allow: ["git status", "git stash"], writable: true } } },
    }),
  })
  const stash = await h.call("bash", { command: "git stash" })
  assert.equal(
    stash?.block,
    true,
    "the md's deny entry blocks the command even though the dispatch's own allowlist names it",
  )
  assert.match(stash.reason, /git stash/, "the refusal names the banned command")
  assert.match(stash.reason, /role md/, "the refusal's source names the md: the deny union is the md contributing")
  // The union only adds the md's deny entries; the payload's bash is otherwise intact, so a
  // command only the payload allowlists still passes (the md's bash was not substituted in).
  const status = await h.call("bash", { command: "git status" })
  assert.equal(
    status,
    undefined,
    "the dispatch's own allowlist still authorizes what the md does not deny",
  )
  h.restore()
  console.log("  ok   bash.deny 在 applyRoleBaseline 里也是硬底线：派单声明 bash 不拆 md 禁令")
}




rmSync(workdir, { recursive: true, force: true })
restoreState()
console.log("\npi-subagents-extend 测试通过")
