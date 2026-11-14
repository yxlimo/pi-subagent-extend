#!/usr/bin/env node
/**
 * pi-subagents `worktreeSetupHook`: make a fresh worktree buildable before the child starts.
 *
 * Wire it up in `~/.pi/agent/extensions/subagent/config.json`:
 *
 *   {
 *     "worktreeSetupHook": "~/extensions/pi-subagent-extend/scripts/worktree-setup.mjs",
 *     "worktreeSetupHookTimeoutMs": 300000
 *   }
 *
 * pi-subagents pipes one JSON object on stdin (`repoRoot`, `worktreePath`, `agentCwd`,
 * `branch`, `index`, `runId`, `baseCommit`) and expects exactly one JSON object on
 * stdout. `syntheticPaths` are deleted before diff capture; nothing here creates files
 * inside the worktree except ignored install output, so it stays empty.
 *
 * Behaviour: probe first, install only when the probe fails.
 *
 * The probe answers the failure it exists for — a worktree whose `node_modules` is a
 * symlink into the main checkout (or missing entirely), where pnpm rebuilds the links at
 * the wrong depth and `tsc` can no longer resolve packages. A worktree that already has
 * a real, resolving `node_modules` is left alone; nothing is downloaded on every launch.
 *
 * Install roots: the worktree root when it has `package.json` or `pnpm-workspace.yaml`;
 * otherwise every immediate subdirectory that has a `package.json` (the layout of this
 * repo, where `packages/*` are independent packages and there is no root manifest).
 *
 * A copy of every run's log goes to `~/.cache/pi-worktree-setup/<runId>.log` so a failed
 * setup can be diagnosed after the launch is gone.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROBE_TSC_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 240_000;

/** Collect the hook's stdin; it is small and bounded. */
function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

const context = (() => {
	const raw = readStdin().trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
})();

const runId = typeof context.runId === "string" && context.runId ? context.runId : `manual-${Date.now()}`;
const worktreePath = typeof context.worktreePath === "string" ? context.worktreePath : process.cwd();

const logDir = join(homedir(), ".cache", "pi-worktree-setup");
const logFile = join(logDir, `${runId}.log`);
const lines = [];
const log = (text) => {
	lines.push(text);
};

function flushLog() {
	try {
		mkdirSync(logDir, { recursive: true });
		writeFileSync(logFile, `${lines.join("\n")}\n`);
	} catch {
		// Diagnostics must never fail the hook.
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		timeout: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
		env: process.env,
		maxBuffer: 32 * 1024 * 1024,
	});
	const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
	return { ok: result.status === 0, status: result.status, error: result.error?.message, tail };
}

const has = (dir, name) => existsSync(join(dir, name));

/** A real directory, not a symlink into the main checkout: that is the reported bug. */
function realNodeModules(root) {
	const nm = join(root, "node_modules");
	try {
		if (!lstatSync(nm).isDirectory()) {
			log(`probe ${root}: node_modules is a symlink (or not a directory)`);
			return false;
		}
		if (readdirSync(nm).length === 0) {
			log(`probe ${root}: node_modules is empty`);
			return false;
		}
		return true;
	} catch {
		log(`probe ${root}: node_modules missing`);
		return false;
	}
}

function typescriptAvailable(root) {
	const tsc = join(root, "node_modules", ".bin", "tsc");
	try {
		return statSync(tsc).isFile() || statSync(tsc).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Probe: a real node_modules, and — when the package ships a tsconfig and has tsc
 * installed — an actually passing type-check. The type-check is what proves the links
 * resolve; a directory that merely exists does not.
 */
function probe(root) {
	if (!realNodeModules(root)) return false;
	if (!has(root, "tsconfig.json") || !typescriptAvailable(root)) return true;
	const result = run(join(root, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "tsconfig.json"], {
		cwd: root,
		timeoutMs: PROBE_TSC_TIMEOUT_MS,
	});
	if (result.ok) return true;
	log(`probe ${root}: tsc --noEmit failed (exit ${result.status}${result.error ? `, ${result.error}` : ""})\n${result.tail}`);
	return false;
}

function installRoots(worktree) {
	if (has(worktree, "package.json") || has(worktree, "pnpm-workspace.yaml")) return [worktree];
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 2) return;
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = join(dir, entry.name);
			if (has(child, "package.json")) found.push(child);
			else walk(child, depth + 1);
		}
	};
	walk(worktree, 1);
	return found;
}

/** Prefer the lockfile's own tool; fall back to whatever is installed. */
function installCommands(root) {
	if (has(root, "pnpm-lock.yaml")) {
		return [
			["pnpm", ["install", "--prefer-offline", "--frozen-lockfile"]],
			["pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"]],
		];
	}
	if (has(root, "package-lock.json")) {
		return [
			["npm", ["ci", "--prefer-offline"]],
			["npm", ["install", "--prefer-offline"]],
		];
	}
	return [
		["pnpm", ["install", "--prefer-offline"]],
		["npm", ["install", "--prefer-offline"]],
	];
}

function install(root) {
	// The reported bug, verbatim: the worktree's `node_modules` is a symlink into the main
	// checkout. pnpm installs *through* such a link instead of replacing it, so the tree
	// keeps pointing at the wrong depth and tsc still cannot resolve packages. Remove the
	// link first — unlink touches the link, never its target.
	const nm = join(root, "node_modules");
	try {
		if (lstatSync(nm).isSymbolicLink()) {
			unlinkSync(nm);
			log(`removed stale node_modules symlink at ${root}`);
		}
	} catch {
		// Absent or unreadable: the installer will create it.
	}
	for (const [command, args] of installCommands(root)) {
		log(`install ${root}: ${command} ${args.join(" ")}`);
		const result = run(command, args, { cwd: root });
		if (result.ok) return true;
		log(`install failed (${command}, exit ${result.status}${result.error ? `, ${result.error}` : ""})\n${result.tail}`);
		// Only a missing tool justifies the next command. A real failure of the project's
		// own package manager must not be papered over with npm.
		if (result.status !== null) return false;
	}
	return false;
}

const roots = installRoots(worktreePath);
log(`worktree ${worktreePath} (run ${runId}), install roots: ${roots.length ? roots.join(", ") : "(none)"}`);

if (roots.length === 0) {
	log("nothing to install: no package.json at the root or one level down");
	flushLog();
	process.stdout.write(`${JSON.stringify({ syntheticPaths: [] })}\n`);
	process.exit(0);
}

const failed = [];
for (const root of roots) {
	if (probe(root)) {
		log(`skip ${root}: already buildable`);
		continue;
	}
	// The probe is the contract; the installer's exit code is only a log line. pnpm exits
	// non-zero for policy complaints (ERR_PNPM_IGNORED_BUILDS) after installing everything
	// fine, and failing the launch on that would be wrong — the probe already says whether
	// the tree is buildable.
	install(root);
	if (probe(root)) {
		log(`ready ${root}`);
		continue;
	}
	failed.push(root);
}

flushLog();

if (failed.length > 0) {
	process.stderr.write(
		`worktree setup failed for: ${failed.join(", ")}\nlog: ${logFile}\n` +
			"The child would start in a worktree whose dependencies do not resolve, so the launch is refused.\n",
	);
	process.exit(1);
}

process.stdout.write(`${JSON.stringify({ syntheticPaths: [] })}\n`);
