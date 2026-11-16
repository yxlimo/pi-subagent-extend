// Tests for the worktree setup hook.
//
//   node packages/worktree-setup/test/hook.test.mjs
//
// The hook is started the way pi-subagents starts it: the file itself, no arguments, with the
// worktree root as the working directory. Node only drives these cases; the hook under test
// does not use node at all.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "..", "worktree-setup.sh")
const root = mkdtempSync(join(tmpdir(), "worktree-setup-test-"))
const cache = join(root, "cache")
const env = { ...process.env, HOME: join(root, "home"), XDG_CACHE_HOME: cache }
mkdirSync(env.HOME, { recursive: true })

/** A checkout-shaped directory; `declaration` becomes .pi/worktree-setup.sh when given. */
function project(name, declaration) {
	const dir = join(root, name)
	mkdirSync(join(dir, ".pi"), { recursive: true })
	if (declaration !== undefined) writeFileSync(join(dir, ".pi", "worktree-setup.sh"), declaration)
	return dir
}

function run(dir) {
	const result = spawnSync(hook, [], { cwd: dir, encoding: "utf8", env, input: "{}" })
	const logFile = join(cache, "pi-worktree-setup", `${dir.split("/").pop()}.log`)
	return { ...result, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" }
}

const results = []
function check(name, body) {
	try {
		body()
		results.push(`ok   ${name}`)
	} catch (error) {
		results.push(`FAIL ${name}\n     ${error.message}`)
		process.exitCode = 1
	}
}

// 0. The main checkout's node_modules link is removed before the declaration runs, so a
//    declaration that installs writes its own tree instead of the main checkout's.
check("the linked node_modules is removed before the declaration runs", () => {
	const main = project("main-checkout")
	const mainNodeModules = join(main, "node_modules")
	mkdirSync(mainNodeModules)
	writeFileSync(join(mainNodeModules, "keep.txt"), "main\n")

	const dir = project("linked", 'if [ -L node_modules ]; then echo "saw a link" > seen.txt; elif [ -e node_modules ]; then echo "saw a file" > seen.txt; else echo "saw nothing" > seen.txt; fi\n')
	symlinkSync(mainNodeModules, join(dir, "node_modules"), "dir")

	const { status, log } = run(dir)
	assert.equal(status, 0, `hook exited ${status}: ${log}`)
	assert.equal(readFileSync(join(dir, "seen.txt"), "utf8").trim(), "saw nothing", "the declaration must not see the link")
	assert.equal(existsSync(join(dir, "node_modules")), false, "the link is gone")
	assert.deepEqual(readdirSync(mainNodeModules), ["keep.txt"], "the main checkout is untouched")
})

// 0b. A real node_modules directory is not touched: only the synthetic link is.
check("a real node_modules directory is left alone", () => {
	const dir = project("real-deps", 'test -d node_modules && echo kept > seen.txt\n')
	mkdirSync(join(dir, "node_modules"))
	writeFileSync(join(dir, "node_modules", "marker.txt"), "mine\n")

	const { status, log } = run(dir)
	assert.equal(status, 0, `hook exited ${status}: ${log}`)
	assert.equal(readFileSync(join(dir, "seen.txt"), "utf8").trim(), "kept")
	assert.deepEqual(readdirSync(join(dir, "node_modules")), ["marker.txt"])
})

// 1. No declaration: nothing happens, and the launch is not refused.
check("a project without a declaration is left alone", () => {
	const dir = project("inert")
	const { status, stdout, log } = run(dir)
	assert.equal(status, 0)
	assert.deepEqual(JSON.parse(stdout), { syntheticPaths: [] })
	assert.equal(log, "", "the hook must not touch the cache when it has nothing to do")
})

// 2. The declaration runs inside the worktree, so a repository whose manifest sits in a
//    subdirectory can cd there itself.
check("the declaration runs in the worktree and may cd", () => {
	const dir = project("declared", "cd sub && pwd > marker.txt && touch node_modules\n")
	mkdirSync(join(dir, "sub"), { recursive: true })
	const { status, stdout } = run(dir)
	assert.equal(status, 0)
	assert.deepEqual(JSON.parse(stdout), { syntheticPaths: [] })
	assert.equal(readFileSync(join(dir, "sub", "marker.txt"), "utf8").trim(), join(dir, "sub"))
})

// 3. A failing declaration refuses the launch and shows the tail of its output.
check("a failing declaration refuses the launch with its output", () => {
	const dir = project("failing", "echo 'boom: no manifest'\nexit 7\n")
	const { status, stderr, log } = run(dir)
	assert.equal(status, 7, "the declaration's exit code is the contract")
	assert.match(stderr, /worktree setup failed \(exit 7\)/)
	assert.match(stderr, /boom: no manifest/)
	assert.match(stderr, /log: .*\.log/)
	assert.match(log, /boom/)
})

// 4. Environment variables a project sets are visible to the declaration.
check("the declaration sees the caller's environment", () => {
	const dir = project("env", 'printf "%s" "$npm_config_registry" > seen.txt\n')
	const result = spawnSync(hook, [], {
		cwd: dir,
		encoding: "utf8",
		env: { ...env, npm_config_registry: "https://example.invalid" },
		input: "{}",
	})
	assert.equal(result.status, 0)
	assert.equal(readFileSync(join(dir, "seen.txt"), "utf8"), "https://example.invalid")
})

// 5. The mise hint appears only for a trust failure.
check("a mise trust failure is named as such", () => {
	const trusted = project("trusted", "echo 'Config files in /x are not trusted' >&2\nexit 1\n")
	assert.match(run(trusted).stderr, /trusted_config_paths/)

	const other = project("other", "echo 'ENOENT: no such file' >&2\nexit 1\n")
	assert.doesNotMatch(run(other).stderr, /trusted_config_paths/)
})

// 6. The hook does not depend on node being installed at all. Only the utilities it calls are
//    put on PATH, resolved here so the case works on any layout (NixOS has no coreutils in /bin).
check("the hook runs without node on PATH", () => {
	const toolsDir = join(root, "tools")
	mkdirSync(toolsDir, { recursive: true })
	for (const tool of ["sh", "mkdir", "basename", "tail", "grep"]) {
		const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
		assert.ok(found, `${tool} must exist on the host`)
		spawnSync("ln", ["-s", found, join(toolsDir, tool)])
	}

	const dir = project("no-node", "echo 'done without node' > ran.txt\n")
	const result = spawnSync(hook, [], {
		cwd: dir,
		encoding: "utf8",
		env: { ...env, PATH: toolsDir },
		input: "{}",
	})
	assert.equal(result.status, 0)
	assert.equal(readFileSync(join(dir, "ran.txt"), "utf8").trim(), "done without node")
})

process.stdout.write(`${results.join("\n")}\n`)
rmSync(root, { recursive: true, force: true })
if (process.exitCode === 1) process.stdout.write("worktree-setup hook 测试失败\n")
else process.stdout.write(`worktree-setup hook 测试通过（${results.length} 项）\n`)
