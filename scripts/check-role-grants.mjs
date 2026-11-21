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
	// the sandbox would otherwise have to grant first.
	const hasPreExec = /^\s+preExec:/m.test(text);
	const missing = entries.filter((entry) => !exists(entry));
	const orphaned = hasPreExec ? [] : missing;
	if (orphaned.length > 0) {
		problems.push(`${path}: ${orphaned.join(", ")}`);
	}
	report.push(
		`${path}: ${entries.length} entries, ${missing.length} created at session start` +
			(hasPreExec ? " (preExec present)" : ""),
	);
}

for (const line of report) console.log(line);

if (problems.length > 0) {
	console.error(
		`\n${problems.length} role md(s) grant a path that neither exists nor is created by setup.preExec — those grants refuse every write:\n${problems.join("\n")}`,
	);
	process.exit(1);
}
console.log("\nrole grants: every non-existent entry is produced by setup.preExec");
