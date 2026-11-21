#!/usr/bin/env node
// Every `extend.permissions.write` entry in a role md is matched against the session cwd, so a
// typo does not fail loudly — it produces a role that refuses all writes while looking exactly
// like a working boundary. That happened three times here: a missing `packages/pi-plugin/` prefix,
// `SKILL.md` at a path that does not exist, and a scratch directory one level short.
//
// So: an entry that does not exist is only legitimate if the role's `setup.preExec` creates it.
// Anything else is a dead grant, and a role whose only grants are dead cannot write at all.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".pi/agents";
const exists = (p) => {
	try {
		statSync(p);
		return true;
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

const problems = [];
const report = [];
for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	const entries = writeEntries(text);
	if (entries.length === 0) continue;
	// `preExec` runs unsandboxed at session start, which is the only way a role can create a path
	// the sandbox would otherwise have to grant first. Only the paths that command actually names
	// are excused: treating "the md has a preExec" as blanket permission hid a dead grant for a
	// file that had been deleted, which is exactly what this check exists to catch.
	const preExec = (text.match(/^\s+preExec:[ \t]*(.+)$/m) ?? [])[1] ?? "";
	const missing = entries.filter((entry) => !exists(entry));
	const orphaned = missing.filter((entry) => !preExec.includes(entry));
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
