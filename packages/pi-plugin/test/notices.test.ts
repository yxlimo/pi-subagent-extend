// Notices: unreachable allowlist entries and their diagnostics.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension.test.ts

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, repo, workdir } from "./harness.ts"

// pathCandidates 的纯抽取用例已随 paths.test.ts 拆走；本文件只剩接线用例，共用这一个导入。
const bashMatch = (await import(join(repo, "src", "bash-match.ts"))) as unknown as {
  unreachableEntries?: (entries: string[], cwd: string) => UnreachableEntry[]
}

/** `src/bash-match.ts` 判出的「不可达条目」：本文件只用它断言判定结果。 */
interface UnreachableEntry {
  entry: string
  why: string
  fix?: string
  /** cwd 下面所有带 package.json 的目录：多个候选时给不出单一的改法。 */
  candidates?: string[]
  /** 恰好一个候选、但那个包里没有条目点名的脚本时，记下缺的脚本名。 */
  scriptMissing?: string
}

/** 调「不可达条目」判定；导出缺失时给一句可读的失败，而不是 TypeError。 */
function unreachableEntries(entries: string[], cwd: string): UnreachableEntry[] {
  assert.equal(typeof bashMatch.unreachableEntries, "function", "src/bash-match.ts must export unreachableEntries")
  return (bashMatch.unreachableEntries as (entries: string[], cwd: string) => UnreachableEntry[])(entries, cwd)
}


// 122. 授权里写了 `pnpm run typecheck`、工作目录却没有 package.json 时，这条授权永远命中不了：
//      子代理没有 `cd`，它只能自己找一个等价写法。判据是 cwd 本身，改法必须指向真正装着包的
//      目录，并且用这家包管理器自己的旗标 —— 给 npm 建议 `--dir`，那条建议自己就跑不起来。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))

  const found = unreachableEntries(["pnpm run typecheck"], tree)
  assert.equal(found.length, 1, "an entry whose cwd has no package.json can never match")
  assert.equal(found[0].entry, "pnpm run typecheck", "the entry is reported verbatim")
  assert.match(found[0].why, /no package\.json/, "the reason is the checkable fact, not advice")
  assert.ok(found[0].fix?.includes("--dir"), `the fix uses this manager's own flag, got: ${found[0].fix}`)
  assert.ok(
    found[0].fix?.includes(join("packages", "pi-plugin")),
    `the fix points at the directory that really has a package.json, got: ${found[0].fix}`,
  )
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   cwd 没有 package.json 的包管理器条目判为不可达，改法指回真正的包目录")
}

// 123. 条目自己带包目录旗标时判的是那个目录：它是上一条的对照组 —— 判定看事实，
//      不许把「cwd 没有 package.json」一律当成不可达，否则一条正确的授权会被建议改掉。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-reach-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), "{}")

  assert.deepEqual(
    unreachableEntries(["pnpm --dir packages/pi-plugin run typecheck"], tree),
    [],
    "an entry that names its own package directory is reachable",
  )
  assert.deepEqual(
    unreachableEntries(["npm --prefix=packages/pi-plugin run build"], tree),
    [],
    "the --flag=value form is honoured too",
  )
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   条目自带包目录旗标且目录有 package.json 时判为可达")
}

// 124. `cargo` 条目看 cwd 的 Cargo.toml；条目自己用 `--manifest-path` 指名了包时判不了，
//      跳过不判 —— 猜错方向会让一条本来跑得起来的命令被建议改掉。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-cargo-"))
  const before = unreachableEntries(["cargo test"], tree)
  assert.equal(before.length, 1, "cargo with no Cargo.toml in the cwd can never match")
  assert.match(before[0].why, /no Cargo\.toml/, "the reason names the missing manifest")
  assert.equal(before[0].fix, undefined, "no fix is invented for cargo")
  assert.deepEqual(
    unreachableEntries(["cargo --manifest-path ../helper/Cargo.toml test"], tree),
    [],
    "an entry that names its own manifest is not judged",
  )
  writeFileSync(join(tree, "Cargo.toml"), "[package]\nname = \"x\"\n")
  assert.deepEqual(unreachableEntries(["cargo test"], tree), [], "with a Cargo.toml in the cwd the entry is reachable")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   cargo 条目看 cwd 的 Cargo.toml；--manifest-path 条目不判")
}

// 125. 程序位写成绝对路径的条目可以静态核对：文件不在，这条授权永远命中不了。
//      对照组是同一函数对着真实存在的文件，防止「一律判不可达」也能过这一条。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-abs-"))
  const missing = join(tree, "missing-tool")
  const present = join(tree, "present-tool")
  writeFileSync(present, "")
  const gone = unreachableEntries([missing], tree)
  assert.equal(gone.length, 1, "an absolute-path entry whose file does not exist can never match")
  assert.equal(gone[0].why, `${missing} does not exist`, "the reason is the fact, with the path in it")
  assert.equal(gone[0].fix, undefined, "no fix is invented for a missing binary")
  assert.deepEqual(unreachableEntries([present], tree), [], "the same entry with an existing file is reachable")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   绝对路径条目按文件是否存在判定，存在即可达")
}

// 126. 不猜：工作目录语义到处都杂的程序名（git、rg）与 `re:` 正则条目一律不判。
//      误报会让父代理改掉一条本来正确的授权，比漏报糟。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-skip-"))
  assert.deepEqual(
    unreachableEntries(["git status", "rg foo", "re:^git .*", "re:pnpm run .*"], tree),
    [],
    "only entries whose facts can be checked are judged",
  )
  assert.deepEqual(unreachableEntries([], tree), [], "an empty allowlist reports nothing")
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   工具链通用程序名与 re: 条目不判，空列表不报")
}

// 127. 接线一：开场把「授权写了却永远命中不了」说一次，走 UI 而不是模型上下文。
//      没有这一条，子代理只能撞几次墙再自己推断，父代理也看不到自己配错了。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-ui-"))
  mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
  writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const notices = h.ui.join("\n")
  assert.match(notices, /can never match/, "session_start warns about entries that can never match")
  assert.match(notices, /pnpm run typecheck/, "the warning names the entry")
  assert.ok(notices.includes("--dir"), `the warning carries the usable form, got: ${notices}`)
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   开场警告点出永远命中不了的条目，并给出带 --dir 的可用形态")
}

// 128. 接线二：与命令同首 token 的条目写进拒绝文案 —— 撞墙的原因和出路在同一段里。
//      那条条目自己不可达时，`why` 也要跟着写进去，否则读者会以为改个参数就行。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-deny-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run lint"] } } }),
  })
  const refused = await h.call("bash", { command: "pnpm run typecheck" })
  assert.equal(refused?.block, true, "a command missing from the allowlist is refused")
  const reason = String(refused?.reason)
  assert.match(reason, /entries for `pnpm`/, "the refusal lists the entries with the same program")
  assert.match(reason, /pnpm run lint/, "and names the entry that is close")
  assert.match(reason, /no package\.json/, "the entry's own unreachability is stated too")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   拒绝文案点名同首 token 的条目，并带上它不可达的原因")
}

// 129. 反例：首 token 不同的条目与此无关，不写进文案。猜「你可能想跑那个」比不说更糟：
//      子代理会照着一条不相干的授权去改命令，然后再撞一次。
{
  const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-other-"))
  const h = await handler({
    cwd: tree,
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
  })
  const refused = await h.call("bash", { command: "rg foo x.ts" })
  assert.equal(refused?.block, true, "a command missing from the allowlist is refused")
  const reason = String(refused?.reason)
  assert.match(reason, /allowed:/, "the refusal still lists what is allowed")
  assert.doesNotMatch(reason, /entries for/, "no entries hint for a different program name")
  h.restore()
  rmSync(tree, { recursive: true, force: true })
  console.log("  ok   首 token 不同时不臆测：文案里不出现同首 token 条目提示")
}


// 139. `npm`/`pnpm`/`yarn`/`bun` 与 `cargo` 都是**向上**找 manifest：cwd 是仓库里的子目录时，
//      祖先目录里有 manifest 就说明这条命令跑得起来。只看 cwd 会把它误报成不可达，
//      父代理于是去改一条本来没坏的配置 —— 误报比漏报糟。
//      不需要 manifest 的子命令（`pnpm --version`、`pnpm store path`、`npm --help`）本来就能跑，不判。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-upward-"))
	writeFileSync(join(tree, "package.json"), "{}")
	writeFileSync(join(tree, "Cargo.toml"), "[package]\nname = \"x\"\n")
	mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
	const sub = join(tree, "packages", "pi-plugin")
	assert.deepEqual(unreachableEntries(["pnpm test"], sub), [], "pnpm finds the manifest in an ancestor")
	assert.deepEqual(unreachableEntries(["npm run build"], sub), [], "npm finds it the same way")
	assert.deepEqual(unreachableEntries(["cargo test"], sub), [], "cargo finds Cargo.toml the same way")
	// 祖先也没有 manifest：仍然判不可达。
	const bare = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-nomanifest-"))
	assert.equal(unreachableEntries(["pnpm test"], bare).length, 1, "without a manifest anywhere the entry cannot match")
	assert.equal(unreachableEntries(["cargo test"], bare).length, 1, "the same holds for cargo")
	// 本来就不需要 manifest 的子命令：不判。
	assert.deepEqual(unreachableEntries(["pnpm --version"], bare), [], "pnpm --version needs no manifest")
	assert.deepEqual(unreachableEntries(["pnpm store path"], bare), [], "pnpm store path needs no manifest")
	assert.deepEqual(unreachableEntries(["npm --help"], bare), [], "npm --help needs no manifest")
	rmSync(tree, { recursive: true, force: true })
	rmSync(bare, { recursive: true, force: true })
	console.log("  ok   manifest 向上找：子目录里跑得起来；不需要 manifest 的子命令不判")
}

// 140. 多个候选包时给不出可靠的改法：这条授权原本指哪个包只有父代理知道，随便挑一个
//      再给一条 `--dir` 建议，会把命令指到别的包上。候选列表交回去让父代理挑。
//      只有一个候选、但那个包里没有这个脚本时同样不给改法：pnpm 会自己报脚本不存在，
//      那是「脚本不存在」，不是「授权不可达」。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-candidates-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	mkdirSync(join(tree, "pkg-b"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	writeFileSync(join(tree, "pkg-b", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	const found = unreachableEntries(["pnpm run typecheck"], tree)
	assert.equal(found.length, 1, "the entry is still reported: there is no manifest anywhere")
	assert.equal(found[0].fix, undefined, "two candidates: no single fix is invented")
	assert.deepEqual(found[0].candidates, ["pkg-a", "pkg-b"], "both candidates are listed instead")
	// 一个候选，但那个包里没有这个脚本：不给改法。
	const single = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-noscript-"))
	mkdirSync(join(single, "pkg-a"), { recursive: true })
	writeFileSync(join(single, "pkg-a", "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }))
	const one = unreachableEntries(["pnpm run typecheck"], single)
	assert.equal(one.length, 1, "the entry is reported")
	assert.equal(one[0].fix, undefined, "no fix is invented when the candidate has no such script")
	assert.deepEqual(one[0].candidates, ["pkg-a"], "the candidate is still listed")
	rmSync(tree, { recursive: true, force: true })
	rmSync(single, { recursive: true, force: true })
	console.log("  ok   多个候选包时给候选列表不给改法；包里没有该脚本时也不给改法")
}

// 141. 绝对路径条目指向构建产物目录时，文件不存在只说明还没构建
//      （`packages/helper/target/release/…` 要等一次 cargo build），不说明授权命中不了。
//      指向普通目录的不存在路径仍然判不可达。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-artifact-"))
	const artifact = join(tree, "packages", "helper", "target", "release", "pi-subagents-extend-helper")
	const plain = join(tree, "packages", "helper", "bin", "pi-subagents-extend-helper")
	assert.deepEqual(unreachableEntries([artifact], tree), [], "an artefact that does not exist yet is not unreachable")
	assert.equal(unreachableEntries([plain], tree).length, 1, "a missing file outside an artefact directory is unreachable")
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   构建产物目录里的缺失文件不判不可达；普通缺失路径照旧判")
}

// 142. 白名单里的命令在 cwd 下跑不起来时，子代理只看到 pnpm 自己的报错，看不出这是配置问题。
//      注解写进工具结果，把原因与改法一起给出；成功的命令不补（成功的输出里混注解会误导）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-unreach-note-"))
	mkdirSync(join(tree, "packages", "pi-plugin"), { recursive: true })
	writeFileSync(join(tree, "packages", "pi-plugin", "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
	})
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the entry is allowlisted, so the command runs")
	const failed = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const failure = String(failed?.content)
	assert.match(failure, /\[sandbox\] this command ran/, "the failure says the command ran")
	assert.match(failure, /cannot work from/, "and that the entry cannot work from this directory")
	assert.match(failure, /--dir/, "and it carries the usable form")
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the same command runs again")
	const succeeded = await h.result("bash", "typecheck: no errors", false)
	assert.doesNotMatch(String(succeeded?.content), /this command ran/, "a successful command gets no such note")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   跑不起来的命令在工具结果里拿到注解与改法；成功的命令不补注解")
}


// 143. 注解要认「跑的是哪一条授权」，不是「首 token 一样就算」。白名单里同时有可达的
//      `pnpm --dir packages/a run build` 与不可达的 `pnpm run typecheck` 时，早先只比
//      `pnpm` 这个程序名，于是**可达**那条一失败就被安上 `pnpm run typecheck` 的诊断与改法：
//      那条命令根本没跑，照它改也没用。对照组：跑的就是不可达那条时，注解必须点名它。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-note-entry-"))
	mkdirSync(join(tree, "packages", "a"), { recursive: true })
	writeFileSync(join(tree, "packages", "a", "package.json"), JSON.stringify({ scripts: { build: "tsc -b" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm --dir packages/a run build", "pnpm run typecheck"] } },
		}),
	})
	const reachable = "pnpm --dir packages/a run build"
	assert.equal(await h.call("bash", { command: reachable }), undefined, "the reachable entry is allowlisted")
	const unrelatedResult = await h.result("bash", "error TS1234: boom", true)
	const unrelated = String(unrelatedResult?.content)
	assert.doesNotMatch(unrelated, /this command ran/, "a failed reachable command is not annotated")
	assert.doesNotMatch(unrelated, /cannot work from/, "and no other entry's diagnosis is pinned on it")
	assert.doesNotMatch(unrelated, /pnpm run typecheck/, "the unrelated entry is not named at all")
	// 对照组：跑的是那条不可达的，注解点名的就必须是它。
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the unreachable entry is allowlisted too")
	const ownResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const own = String(ownResult?.content)
	assert.match(own, /this command ran/, "the failing unreachable command is annotated")
	assert.match(own, /"pnpm run typecheck" cannot work/, "and the note names that very entry")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解按条目匹配实际跑的命令；同程序名的无关条目不会被安上来")
}

// 144. 候选包可能有几百个，文案必须有上限：把整棵树拼进一条告警，读者读不完，
//      也看不出重点是「这条授权指错了地方」。上限 8 条，超出补 `… and N more`。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-list-cap-"))
	const names = Array.from({ length: 10 }, (_, i) => `pkg-${String(i + 1).padStart(2, "0")}`)
	for (const name of names) {
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run build"] } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /… and 2 more/, "the session warning stops at eight candidates and counts the rest")
	assert.ok(!notices.includes("pkg-09") && !notices.includes("pkg-10"), `the warning names no candidate past the cap, got: ${notices}`)
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	assert.match(note, /… and 2 more/, "the tool-result note is capped the same way")
	assert.ok(!note.includes("pkg-09") && !note.includes("pkg-10"), `the note names no candidate past the cap, got: ${note}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选列表封在 8 条，超出补「… and N more」；告警与工具结果一致")
}

// 145. 恰好一个候选、但那个包里没有条目点名的脚本时，说「没有候选带这个脚本」，而不是让人
//      去候选里「挑一个」：挑哪一个都跑不通（pnpm 自己报 Command not found）。这是「脚本
//      不存在」，不是「授权不可达」。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-no-script-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run typecheck"] } } }),
	})
	const found = unreachableEntries(["pnpm run typecheck"], tree)
	assert.equal(found[0]?.fix, undefined, "no fix is invented when the only candidate lacks the script")
	assert.equal(found[0]?.scriptMissing, "typecheck", "the entry carries the missing script name")
	const notices = h.ui.join("\n")
	assert.match(notices, /no candidate has a `typecheck` script/, "the warning says the script is missing")
	assert.doesNotMatch(notices, /pick the one this entry meant/, "and does not send the reader off to pick one")
	assert.equal(await h.call("bash", { command: "pnpm run typecheck" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	// 句首大写：这条注解里它另起一句，措辞本身与告警那一处相同。
	assert.match(note, /no candidate has a `typecheck` script/i, "the tool-result note says it too")
	assert.doesNotMatch(note, /pick the one this entry meant/, "instead of asking which candidate was meant")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选缺该脚本时明说「没有候选带这个脚本」，不让读者去挑")
}

// 146. cwd 是经软链进来的时候，字面祖先链与真实祖先链不是同一棵树。命令跑在**物理**目录里，
//      所以只有真实祖先里的 package.json 算数 —— 只按字面路径上行会漏掉它，一条能跑的命令
//      被判成永远不可达，父代理于是被建议去改一条正确的授权。判据只走解析后的路径。
{
	const real = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-real-"))
	// 软链要指向包**之下一层**（`pkg/deep`），manifest 在 `pkg`：这样字面链上每一级都没有
	// `package.json`，只有真实链查得到。指向包根本身就会失效 —— 那时 `link/package.json`
	// 经软链本身就命中，判据不查真实链也照样通过（实测：那一版用例撤销实现后仍然绿）。
	mkdirSync(join(real, "pkg", "deep", "sub"), { recursive: true })
	writeFileSync(join(real, "pkg", "package.json"), "{}")
	const holder = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-link-"))
	const link = join(holder, "link")
	symlinkSync(join(real, "pkg", "deep"), link)
	assert.deepEqual(
		unreachableEntries(["pnpm test"], join(link, "sub")),
		[],
		"the manifest above the real path makes the entry reachable through the symlink",
	)
	// 对照组：同样的子目录结构，没有软链也没有祖先 manifest 时仍判不可达。
	const bare = mkdtempSync(join(tmpdir(), "pi-subagents-extend-realpath-bare-"))
	mkdirSync(join(bare, "sub"), { recursive: true })
	assert.equal(unreachableEntries(["pnpm test"], join(bare, "sub")).length, 1, "without a manifest anywhere it is still unreachable")
	rmSync(real, { recursive: true, force: true })
	rmSync(holder, { recursive: true, force: true })
	rmSync(bare, { recursive: true, force: true })
	console.log("  ok   软链 cwd：真实祖先里的 manifest 也算；没有 manifest 时照旧判不可达")
}

// 147. `allow` 与 `write` 是同一列的两种写法（`parseBashRule` 把两者接起来），所以清空哪一边
//      都要清空另一边。早先只做了 `write: []` → 清 `allow` 这一个方向，反向的 `allow: []`
//      让 profile 用新字段 `bash.write` 写下的授权静默留着 —— 与「显式空列表 = 清空该列」
//      是同一个失败，方向相反。
{
	const proj = join(workdir, "proj-empty-allow")
	mkdirSync(join(proj, ".pi"), { recursive: true })
	mkdirSync(join(proj, "src"), { recursive: true })
	writeFileSync(
		join(proj, ".pi/subagent-bindings.json"),
		JSON.stringify({ impl: { bash: { read: ["git status"], write: ["git commit"] } } }),
	)
	// 正控：profile 的写授权本来生效，否则「它不生效了」证明不了任何事。
	const open = await handler({ cwd: proj, profile: "impl" })
	assert.equal(await open.call("bash", { command: "git status" }), undefined, "the profile's read entry runs")
	assert.equal(await open.call("bash", { command: "git commit -m x" }), undefined, "the profile's write entry runs on its own")
	open.restore()

	const h = await handler({
		cwd: proj,
		profile: "impl",
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, maxWriteDenies: 0, bash: { read: ["git status"], allow: [] } },
		}),
	})
	const denied = await h.call("bash", { command: "git commit -m x" })
	assert.equal(denied?.block, true, "an explicit empty allow column drops the profile's write grant")
	h.restore()
	console.log("  ok   allow:[] 同时清掉继承来的 write：两个方向都不再静默保留授权")
}

// 148. 注解该问的是「allowlist 用**哪一条**放行了这条命令」，不是「白名单里哪一条匹配得上」。
//      白名单里有一条**比命令短**的宽条目（`pnpm`）时，可达命令失败仍会被安上那条宽条目的
//      诊断 —— 它自己确实不可达，但它不是放行这条命令的那一条。判据与放行必须同源。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-grant-entry-"))
	mkdirSync(join(tree, "packages", "a"), { recursive: true })
	writeFileSync(join(tree, "packages", "a", "package.json"), JSON.stringify({ scripts: { build: "tsc -b" } }))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm --dir packages/a run build", "pnpm"] } },
		}),
	})
	const exact = "pnpm --dir packages/a run build"
	assert.equal(await h.call("bash", { command: exact }), undefined, "the reachable entry allowlists it")
	const failedResult = await h.result("bash", "error TS1234: boom", true)
	const failed = String(failedResult?.content)
	assert.doesNotMatch(failed, /this command ran/, "the entry that granted it is reachable, so there is nothing to explain")
	assert.doesNotMatch(failed, /"pnpm" cannot work/, "the shorter, wider entry is not pinned on this command")
	// 对照组：跑的就是那条宽条目，注解必须点名它自己。
	assert.equal(await h.call("bash", { command: "pnpm" }), undefined, "the wide entry allowlists the bare command")
	const wideResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const wide = String(wideResult?.content)
	assert.match(wide, /"pnpm" cannot work/, "running the wide entry still gets its own diagnosis")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解问 allowlist 是哪条放行的；更短的宽条目不再顶替真正的授权")
}

// 149. 与 146 反方向：字面祖先里有 manifest、真实祖先里没有。工具走 `chdir` 后的**物理**路径，
//      字面链上的那份 manifest 它永远看不到，所以这条授权**确实**跑不起来，必须被报出来。
//      两条链取并集只会把死授权判成可达、永不报告 —— 正是这个判据要防的事。
{
	const repo = mkdtempSync(join(tmpdir(), "pi-subagents-extend-link-lexical-"))
	writeFileSync(join(repo, "package.json"), "{}")
	const outside = mkdtempSync(join(tmpdir(), "pi-subagents-extend-link-real-"))
	mkdirSync(join(outside, "pkg", "deep", "sub"), { recursive: true })
	symlinkSync(join(outside, "pkg", "deep"), join(repo, "link"))
	assert.equal(
		unreachableEntries(["pnpm test"], join(repo, "link", "sub")).length,
		1,
		"a manifest on the lexical chain only is invisible to the tool, so the entry stays unreachable",
	)
	rmSync(repo, { recursive: true, force: true })
	rmSync(outside, { recursive: true, force: true })
	console.log("  ok   只看物理祖先链：字面链上的 manifest 不把死授权洗成可达")
}

// 150. `write`/`allow` 是一列的两个拼法，所以「这一列只留 x」不能因为用的是哪个拼法而有两种结果。
//      两边都写、其中一边为空时，这一列同样要从底层清空。
{
	const proj = join(workdir, "proj-both-columns")
	mkdirSync(join(proj, ".pi"), { recursive: true })
	mkdirSync(join(proj, "src"), { recursive: true })
	writeFileSync(
		join(proj, ".pi/subagent-bindings.json"),
		JSON.stringify({ impl: { bash: { read: ["git status"], write: ["git commit"] } } }),
	)
	const h = await handler({
		cwd: proj,
		profile: "impl",
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, maxWriteDenies: 0, bash: { read: ["git status"], allow: [], write: ["git status"] } },
		}),
	})
	assert.equal(await h.call("bash", { command: "git status" }), undefined, "the column's own entry still runs")
	const denied = await h.call("bash", { command: "git commit -m x" })
	assert.equal(denied?.block, true, "emptying one spelling clears the column even though the other spelling is written")
	h.restore()

	// 镜像：profile 用旧拼法，派单用新拼法清空。
	const proj2 = join(workdir, "proj-both-columns-mirror")
	mkdirSync(join(proj2, ".pi"), { recursive: true })
	mkdirSync(join(proj2, "src"), { recursive: true })
	writeFileSync(
		join(proj2, ".pi/subagent-bindings.json"),
		JSON.stringify({ impl: { bash: { read: ["git status"], allow: ["git commit"] } } }),
	)
	const h2 = await handler({
		cwd: proj2,
		profile: "impl",
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["src/**"], maxDenies: 0, maxWriteDenies: 0, bash: { read: ["git status"], write: [], allow: ["git status"] } },
		}),
	})
	const denied2 = await h2.call("bash", { command: "git commit -m x" })
	assert.equal(denied2?.block, true, "the mirror direction behaves the same")
	h2.restore()
	console.log("  ok   write 与 allow 合成一列：任一边显式为空都清空整列")
}

// 151. 候选被截断时得说一句「没列全」：否则文案让人去挑，而没显示出来的恰好是它挑不了的那几个。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-cap-note-"))
	for (let i = 1; i <= 10; i += 1) {
		const name = `pkg-${String(i).padStart(2, "0")}`
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm run build"] } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /only the first 8 are listed/, "the warning says the list is not complete")
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the entry is allowlisted")
	const noteResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const note = String(noteResult?.content)
	assert.match(note, /only the first 8 are listed/, "and so does the tool-result note")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   候选被截断时明说「只列了前 8 个」，不让人去挑看不见的")
}

// 152. 告警里的**条目**列表同样要封顶：十几条不可达条目一起展开，那条告警会长到没人读。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-entry-cap-"))
	mkdirSync(join(tree, "pkg-a"), { recursive: true })
	writeFileSync(join(tree, "pkg-a", "package.json"), "{}")
	const entries = Array.from({ length: 10 }, (_, i) => `pnpm run e${String(i + 1).padStart(2, "0")}`)
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: entries } } }),
	})
	const notices = h.ui.join("\n")
	assert.match(notices, /10 allowlist entries can never match/, "the count still says how many there really are")
	assert.match(notices, /… and 2 more/, "but the list itself stops at eight")
	assert.ok(!notices.includes("pnpm run e09") && !notices.includes("pnpm run e10"), `no entry past the cap is named, got: ${notices}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   条目列表也封在 8 条，总数照实说")
}

// 153. 拒绝文案里的「同首 token 条目」提示走的是同一套候选渲染，所以也必须有截断说明
//      （上一轮只给告警与注解补了用例，这条渲染点漏了）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-deny-cap-"))
	for (let i = 1; i <= 10; i += 1) {
		const name = `pkg-${String(i).padStart(2, "0")}`
		mkdirSync(join(tree, name), { recursive: true })
		writeFileSync(join(tree, name, "package.json"), "{}")
	}
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], maxDenies: 0, bash: { read: ["pnpm run build"] } } }),
	})
	const denied = await h.call("bash", { command: "pnpm run other" })
	assert.equal(denied?.block, true, "a command outside the entry is refused")
	const text = String(denied?.reason ?? "")
	assert.match(text, /only the first 8 are listed/, `the refusal hint is capped with the same note, got: ${text}`)
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   拒绝提示里的候选也封顶并说明")
}
// 154. `bun test` 跑的是 bun 自带的运行器：不看 `scripts.test`，连 `package.json` 都不需要。
//      把它判成「没有 manifest 所以永远命中不了」是误报（它在空目录里照样能跑），
//      文案里那句「没有候选带这个脚本」对它就更是假话。
{
	const empty = mkdtempSync(join(tmpdir(), "pi-subagents-extend-bun-test-"))
	assert.deepEqual(unreachableEntries(["bun test"], empty), [], "`bun test` runs without any manifest, so it is never reported")
	assert.equal(unreachableEntries(["bun run test"], empty).length, 1, "but `bun run test` is a package script and still needs one")
	// 旗标不是子命令：`bun --bun test`、`bun test --watch` 跑的仍是自带 runner。
	assert.deepEqual(unreachableEntries(["bun --bun test"], empty), [], "a leading flag does not hide the builtin runner")
	assert.deepEqual(unreachableEntries(["bun test --watch"], empty), [], "and neither does a trailing one")
	rmSync(empty, { recursive: true, force: true })
	console.log("  ok   bun test 不判不可达；bun run test 仍按脚本判")
}

// 155. 注解只能按「这条**命令**需不需要 manifest」归因。宽条目 `pnpm` 会被判成不可达，
//      但它放行的 `pnpm --version` 根本不需要 manifest：失败原因是网络或别的什么，
//      拿「没有 manifest」去解释它是把原因安到了不成立的前提上（误报比漏报糟）。
{
	const tree = mkdtempSync(join(tmpdir(), "pi-subagents-extend-wide-entry-"))
	const h = await handler({
		cwd: tree,
		bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["."], bash: { read: ["pnpm"] } } }),
	})
	// 正控：条目本身确实被报成不可达，否则「没有注解」证明不了任何事。
	assert.match(h.ui.join("\n"), /can never match/, "the wide entry is reported as unreachable")
	assert.equal(await h.call("bash", { command: "pnpm --version" }), undefined, "the wide entry allowlists it")
	const versionResult = await h.result("bash", "ENETUNREACH: network is unreachable", true)
	const versionText = String(versionResult?.content)
	assert.doesNotMatch(versionText, /"pnpm" cannot work from/, "a command that needs no manifest gets no manifest diagnosis")
	// 对照：同一条条目放行的 `pnpm run build` 确实需要 manifest，注解必须出现。
	assert.equal(await h.call("bash", { command: "pnpm run build" }), undefined, "the same entry allowlists this too")
	const buildResult = await h.result("bash", "ERR_PNPM_NO_PKG_MANIFEST  No package.json found", true)
	const buildText = String(buildResult?.content)
	assert.match(buildText, /"pnpm" cannot work from/, "a command that does need one is still explained")
	// P3-7：旗标带值与 bun 的 dlx 都不需要 manifest，不能被当成「需要」。
	assert.deepEqual(unreachableEntries(["bun --cwd /tmp test"], tree), [], "a flag's value is not the subcommand")
	assert.deepEqual(unreachableEntries(["bun x cowsay"], tree), [], "bun's dlx needs no manifest either")
	assert.equal(unreachableEntries(["bun --cwd /tmp run test"], tree).length, 1, "but a script behind the flags still does")
	h.restore()
	rmSync(tree, { recursive: true, force: true })
	console.log("  ok   注解只按命令自身是否需要 manifest 归因；bun 的旗标值与 dlx 也认")
}
