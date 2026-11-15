#!/run/current-system/sw/bin/node
/**
 * pi-subagents `worktreeSetupHook`, installed once globally.
 *
 * The shebang names a concrete node binary on purpose. `node` on PATH here is a mise
 * shim, and a fresh worktree's `mise.toml` is untrusted, so mise refuses and the shim
 * exits 1 — before this file runs a single line, which means nothing gets logged and the
 * only evidence left is pi-subagents reporting an unverified process tree. Running the
 * real binary keeps the hook alive so it can report what the project's command failed
 * with. If node moves, replace the path above.
 *
 * Wire it in `~/.pi/agent/extensions/subagent/config.json`:
 *
 *   {
 *     "worktreeSetupHook": "~/.pi/agent/extensions/subagent/worktree-setup.mjs",
 *     "worktreeSetupHookTimeoutMs": 300000
 *   }
 *
 * pi-subagents pipes one JSON object on stdin (`repoRoot`, `worktreePath`, `agentCwd`,
 * `branch`, `index`, `runId`, `baseCommit`) and expects one JSON object on stdout.
 *
 * Opt-in is the project's own file. Without it this hook does nothing at all, in every
 * project — declaring the work is what enables it:
 *
 *   <repoRoot>/.pi/worktree-setup.json
 *   {
 *     "command": ["pnpm", "install", "--prefer-offline"],
 *     "cwd": "."                       // optional, relative to the worktree
 *   }
 *
 * A project that needs two commands can point `command` at its own script, e.g.
 * `["bash", ".pi/setup-worktree.sh"]`.
 *
 * Before running the command the hook removes a `node_modules` symlink at the target
 * directory. pi-subagents links the main checkout's `node_modules` into a new worktree;
 * pnpm then installs *through* that link instead of replacing it, leaving the virtual
 * store at the wrong depth so tools can no longer resolve dependencies. unlink touches
 * the link, never its target.
 *
 * Why installing per worktree is cheap: pnpm's recommendation for git worktrees is
 * `virtualStoreType: global` in `pnpm-workspace.yaml`, so a worktree's `node_modules`
 * holds only symlinks into one shared content-addressable store and installing only
 * creates links (measured: ~200 ms for a real project).
 *
 * The launch is refused only when the result is not usable — `node_modules` missing or a
 * symlink, or a declared dependency that does not resolve. The command's own exit code is
 * logged but not decisive: pnpm 12 exits non-zero after a complete install when dependencies
 * have unapproved build scripts (ERR_PNPM_IGNORED_BUILDS), and refusing on that would block
 * every launch. Every run is logged to `~/.cache/pi-worktree-setup/<runId>.log`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TIMEOUT_MS = 240_000;

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function parseJson(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const context = parseJson(readStdin()) ?? {};
const runId = typeof context.runId === "string" && context.runId ? context.runId : `manual-${Date.now()}`;
const repoRoot = typeof context.repoRoot === "string" ? context.repoRoot : process.cwd();
const worktreePath = typeof context.worktreePath === "string" ? context.worktreePath : repoRoot;

const logFile = join(homedir(), ".cache", "pi-worktree-setup", `${runId}.log`);
const lines = [];
const startedAt = Date.now();

function log(text) {
	lines.push(`[${Date.now() - startedAt}ms] ${text}`);
}

function finish(exitCode, message) {
	try {
		mkdirSync(join(homedir(), ".cache", "pi-worktree-setup"), { recursive: true });
		writeFileSync(logFile, `${lines.join("\n")}\n`);
	} catch {
		// Diagnostics must never fail the hook.
	}
	if (exitCode === 0) {
		process.stdout.write(`${JSON.stringify({ syntheticPaths: [] })}\n`);
	} else {
		process.stderr.write(`${message}${trustHint(message)}\nlog: ${logFile}\n`);
	}
	process.exit(exitCode);
}

/**
 * mise refuses to run in a worktree whose config it has not trusted, which breaks every
 * shimmed tool there (`node`, `pnpm`, ...). Say so instead of leaving a raw exit code.
 */
function trustHint(message) {
	if (!/not trusted/i.test(message)) return "";
	return (
		"\n\nThis is a mise trust failure, not a dependency failure: the worktree's mise.toml " +
		"is not trusted, so every shimmed command in that worktree fails. Trust the directory " +
		"the worktrees live in, in ~/.config/mise/config.toml:\n" +
		'  [settings]\n  trusted_config_paths = ["<worktree root>"]\n' +
		"(`trusted_config_paths` covers config files at or below each path, including " +
		"worktrees created later.)"
	);
}

const configPath = join(repoRoot, ".pi", "worktree-setup.json");
if (!existsSync(configPath)) {
	log(`nothing to do: ${configPath} does not exist`);
	finish(0);
}

const config = parseJson(readFileSync(configPath, "utf8"));
if (config === undefined) {
	finish(1, `${configPath} must contain a JSON object`);
}

const command = config.command;
if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) {
	finish(1, `${configPath} must declare "command" as a non-empty array of strings`);
}

const targetDir = resolve(worktreePath, typeof config.cwd === "string" ? config.cwd : ".");
if (!existsSync(targetDir)) {
	finish(1, `worktree setup directory does not exist: ${targetDir}`);
}

// Drop the symlink pi-subagents creates, so the installer builds a real tree here.
const nodeModules = join(targetDir, "node_modules");
try {
	if (lstatSync(nodeModules).isSymbolicLink()) {
		unlinkSync(nodeModules);
		log(`removed stale node_modules symlink at ${targetDir}`);
	}
} catch {
	// Absent: the command creates it.
}

log(`run in ${targetDir}: ${command.join(" ")}`);
const result = spawnSync(command[0], command.slice(1), {
	cwd: targetDir,
	encoding: "utf8",
	timeout: TIMEOUT_MS,
	env: process.env,
	maxBuffer: 32 * 1024 * 1024,
});
const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
log(`exit ${result.status}${result.error ? ` (${result.error.message})` : ""}\n${tail}`);

/**
 * Did the declared step achieve what it declares? pnpm 12 exits non-zero for
 * ERR_PNPM_IGNORED_BUILDS after installing everything — refusing the launch on that alone
 * would block every run. A worktree whose dependencies resolve is buildable; one whose
 * dependencies do not is not, whatever the exit code said.
 */
function verify(dir) {
	const nodeModules = join(dir, "node_modules");
	try {
		if (!lstatSync(nodeModules).isDirectory()) return "node_modules is a symlink";
	} catch {
		return "node_modules is missing";
	}

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined; // No manifest to check against: the command succeeded as far as we can tell.
	}
	const names = [...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.dependencies ?? {})];
	const dependency = names.includes("typescript") ? "typescript" : names[0];
	if (dependency === undefined) return undefined;

	const probe = spawnSync(process.execPath, ["-e", `require.resolve(${JSON.stringify(dependency)})`], {
		cwd: dir,
		encoding: "utf8",
		timeout: 60_000,
	});
	if (probe.status !== 0) return `cannot resolve ${dependency}`;
	return undefined;
}

const problem = verify(targetDir);
if (problem !== undefined) {
	finish(1, `worktree setup did not produce a usable tree (${problem}): ${command.join(" ")}\n${tail}`);
}
if (result.status !== 0) {
	// Visible but not blocking: the tree is usable, the command just complained.
	log(`note: command exited ${result.status} but the tree verifies; not refusing the launch`);
}

log("done");
finish(0);
