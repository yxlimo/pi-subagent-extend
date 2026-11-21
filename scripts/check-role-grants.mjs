#!/usr/bin/env node
// Every `extend.permissions.write` entry in a role md is matched against the session cwd, so a
// typo does not fail loudly — it produces a role that refuses all writes while looking exactly
// like a working boundary. That happened three times here: a missing `packages/pi-plugin/` prefix,
// `SKILL.md` at a path that does not exist, and a scratch directory one level short.
//
// So: an entry that does not exist is only legitimate if the role's `setup.preExec` creates it.
// Anything else is a dead grant, and a role whose only grants are dead cannot write at all.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.argv[2] ?? ".pi/agents";
const exists = (p) => {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
};
const isDirectory = (path) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

// Pull a block scalar or flow list out of the YAML frontmatter without a parser: these files are
// hand-written, the shape is fixed, and a dependency would have to be installed to run a check
// that guards a config typo.
function writeEntries(text) {
	const block = text.match(/^[ \t]*write:[ \t]*\n((?:[ \t]+-[ \t]+.*\n)+)/m);
	if (block) {
		return block[1]
			.split("\n")
			.map((line) => line.replace(/^[ \t]*-[ \t]*/, "").trim())
			.filter(Boolean)
			.map((entry) => entry.replace(/^["']|["']$/g, ""));
	}
	const flow = text.match(/^[ \t]*write:[ \t]*\[(.*)\]/m);
	if (!flow) return [];
	return flow[1]
		.split(",")
		.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

// Approximate the creation shapes role mds actually use: `mkdir -p <dir>` creates that directory,
// and a copy/move into a directory creates one file named after its source there. Redirections,
// loops and globs are deliberately not modelled — reporting a reachable grant as unreachable is
// safer than hiding a dead one.
function createdPaths(preExec) {
	const created = [];
	for (const command of preExec.split(/\s*(?:&&|;)\s*/)) {
		const tokens =
			command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
		const [program, ...args] = tokens;
		// Flags are not paths; `--` is filtered too because it also starts with `-`.
		const operands = args.filter((arg) => !arg.startsWith("-"));
		if (program === "mkdir" && args.includes("-p")) {
			created.push(...operands);
			continue;
		}
		if (!["cp", "install", "mv"].includes(program) || operands.length < 2) continue;
		const destination = operands[operands.length - 1];
		const source = operands[operands.length - 2];
		created.push(destination);
		if (destination.endsWith("/") || isDirectory(destination)) {
			created.push(join(destination, basename(source)));
		}
	}
	return created;
}

const problems = [];
const report = [];
for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	const entries = writeEntries(text);
	if (entries.length === 0) continue;
	// `preExec` runs unsandboxed at session start, which is the only way a role can create a path
	// the sandbox would otherwise have to grant first. Excuse only the exact paths the command
	// creates: a path merely mentioned in it (or sitting under a directory it creates) can still
	// be dead, which is exactly what this check exists to catch.
	const preExec = (text.match(/^\s+preExec:[ \t]*(.+)$/m) ?? [])[1] ?? "";
	const missing = entries.filter((entry) => !exists(entry));
	const created = createdPaths(preExec);
	const orphaned = missing.filter((entry) => !created.includes(entry));
	if (orphaned.length > 0) {
		problems.push(`${path}: ${orphaned.join(", ")}`);
	}
	report.push(
		`${path}: ${entries.length} entries, ${missing.length} created at session start` +
			(preExec ? " (preExec present)" : ""),
	);
}
// There is no project-wide floor any more: the bindings file that used to supply `git commit`,
// `git push` and the rest to every role is gone, so a role md that omits the deny list simply has
// none. A subagent that can commit and push is the exact failure the floor used to prevent, and
// nothing else would notice — so the omission is an error here.
const REQUIRED_DENY = [
	"git commit",
	"git push",
	"git rebase",
	"git merge",
	"git reset",
	"git clean",
	"git checkout",
	"git restore",
	"rm -rf",
];

for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	if (!/^\s+bash:/m.test(text)) continue;
	const block = text.match(/^[ \t]*deny:[ \t]*\n((?:[ \t]+-[ \t]+.*\n)+)/m);
	const denied = block
		? block[1]
				.split("\n")
				.map((value) => value.replace(/^[ \t]*-[ \t]*/, "").trim())
				.filter(Boolean)
		: [];
	const absent = REQUIRED_DENY.filter((entry) => !denied.includes(entry));
	if (absent.length > 0) {
		problems.push(`${path}: deny list is missing ${absent.join(", ")}`);
	}
}


for (const line of report) console.log(line);

if (problems.length > 0) {
	console.error(
		`\n${problems.length} role md problem(s) — a dead write grant refuses every write, and a missing deny entry lets the role commit or push:\n${problems.join("\n")}`,
	);
	process.exit(1);
}
console.log("\nrole config: every write grant is reachable, every deny list complete");
