// Phase 3a module tests: main-repo anchoring, deliverable links, and the three role blocks.
// Git cases construct their own repositories under os.tmpdir(); nothing is written to the checkout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const src = (name: string): string => pathToFileURL(join(here.pathname, "..", "src", name)).href;

const { mainRepoRoot, ensureDeliverableLink, deliverableTarget } =
  (await import(src("deliverable.ts"))) as typeof import("../src/deliverable.ts");
const { worktreeFromBlock, setupFromBlock, outputFromBlock, policyFromBlock, resolveRoleFromPrompt } =
  (await import(src("role-config.ts"))) as typeof import("../src/role-config.ts");

const { wireDeliverable, sandboxWritableDirs, wireWorktree, wirePreExec, nodeModulesWriteHint } =
  (await import(src("index.ts"))) as typeof import("../src/index.ts");
let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

function temp(label: string): string {
  return join(tmpdir(), `pi-subagents-extend-p3-${label}-${process.pid}-${(Math.random() * 1e6) | 0}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repoWithWorktree(dir: string): { main: string; worktree: string } {
  const main = join(dir, "main");
  const worktree = join(dir, "child");
  mkdirSync(main, { recursive: true });
  git(["init", "-q"], main);
  writeFileSync(join(main, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], main);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"], main);
  git(["worktree", "add", "-q", "-b", "phase3", worktree], main);
  return { main, worktree };
}

console.log("pi-subagents-extend role phase 3a");

// 1. Tier 1: a linked worktree's .git file points through commondir at the main repo.
{
  const dir = temp("anchor-common");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const anchor = mainRepoRoot(worktree);
    if (anchor.root === null) assert.fail("a linked worktree must have an anchor");
    assert.equal(anchor.via, "common-dir");
    assert.equal(anchor.root, resolve(main));
    ok("tier 1: real git worktree anchors through commondir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Tier 3: from a subdirectory of a linked worktree there is no .git file, so git lists the main worktree.
{
  const dir = temp("anchor-list");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const nested = join(worktree, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    const anchor = mainRepoRoot(nested);
    if (anchor.root === null) assert.fail("a worktree subdirectory must still find the main repo");
    assert.equal(anchor.via, "worktree-list");
    assert.equal(anchor.root, resolve(main));
    ok("tier 3: a worktree subdirectory anchors via git worktree list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Tier 2: a plain gitfile with gitdir: and no commondir points straight at the .git directory.
{
  const dir = temp("anchor-gitfile");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".git"), "gitdir: ../main/.git\n");
    const anchor = mainRepoRoot(child);
    if (anchor.root === null) assert.fail("a gitfile must have an anchor");
    assert.equal(anchor.via, "gitfile");
    assert.equal(anchor.root, resolve(main));
    ok("tier 2: a gitfile anchors on its standalone gitdir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Tier 4: a plain directory with no git evidence is its own main root, not a failure.
{
  const dir = temp("anchor-cwd");
  try {
    mkdirSync(dir, { recursive: true });
    const anchor = mainRepoRoot(dir);
    if (anchor.root === null) assert.fail("a plain directory must fall back to cwd");
    assert.equal(anchor.via, "cwd");
    assert.equal(anchor.root, resolve(dir));
    ok("tier 4: a plain directory falls back to cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. A cwd that does not exist reports failure and says what was tried.
{
  const dir = temp("anchor-missing");
  const anchor = mainRepoRoot(join(dir, "absent"));
  assert.equal(anchor.root, null);
  if (anchor.root !== null) assert.fail("expected a failed anchor");
  assert.ok(anchor.tried.length > 0);
  ok("an unusable cwd reports null with the attempted paths");
}

// 6. No worktree means no link at all.
{
  const dir = temp("link-same");
  try {
    mkdirSync(dir, { recursive: true });
    const result = ensureDeliverableLink(dir, dir, "notes/out.md");
    assert.equal(result.action, "none");
    if (result.action !== "none") assert.fail("expected none");
    assert.equal(result.reason, "same-directory");
    assert.throws(() => statSync(join(dir, "notes", "out.md")), /ENOENT/);
    ok("same directory: no link is created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 7. A fresh child gets a symlink whose resolution is the main-side file.
{
  const dir = temp("link-created");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const target = deliverableTarget(main, "notes/out.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "main content\n");
    const result = ensureDeliverableLink(child, main, "notes/out.md");
    if (result.action !== "created") assert.fail("expected created");
    assert.equal(result.targetPath, target);
    assert.equal(readlinkSync(result.linkPath), target);
    assert.equal(realpathSync(result.linkPath), target);
    assert.equal(readFileSync(result.linkPath, "utf8"), "main content\n");
    ok("fresh child: created link resolves to the main-side file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 8. Calling it again reuses the existing link instead of replacing it.
{
  const dir = temp("link-reused");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const first = ensureDeliverableLink(child, main, "notes/out.md");
    assert.equal(first.action, "created");
    assert.ok(statSync(dirname(deliverableTarget(main, "notes/out.md"))).isDirectory(), "main-side parent created");
    const second = ensureDeliverableLink(child, main, "notes/out.md");
    assert.equal(second.action, "reused");
    assert.equal(second.linkPath, first.linkPath);
    assert.equal(readlinkSync(second.linkPath), deliverableTarget(main, "notes/out.md"));
    ok("second call: reused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 9. A link to a different target is not overwritten; a .new link is written beside it.
{
  const dir = temp("link-retarget");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const other = join(dir, "other.md");
    writeFileSync(other, "other\n");
    const linkPath = join(child, "out.md");
    symlinkSync(other, linkPath);
    const result = ensureDeliverableLink(child, main, "out.md");
    if (result.action !== "retargeted") assert.fail("expected retargeted");
    assert.equal(result.linkPath, `${linkPath}.new`);
    assert.equal(result.targetPath, deliverableTarget(main, "out.md"));
    assert.equal(readlinkSync(result.linkPath), deliverableTarget(main, "out.md"));
    assert.equal(readlinkSync(linkPath), other, "the original link is untouched");
    assert.match(result.warning, /left it untouched/);
    ok("link to another target: retargeted to <name>.new with a warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 10. A real file at the link path is never overwritten; the caller falls back to the main path.
{
  const dir = temp("link-real");
  try {
    const main = join(dir, "main");
    const child = join(dir, "child");
    mkdirSync(main, { recursive: true });
    mkdirSync(child, { recursive: true });
    const linkPath = join(child, "out.md");
    writeFileSync(linkPath, "do not touch\n");
    const result = ensureDeliverableLink(child, main, "out.md");
    if (result.action !== "skipped") assert.fail("expected skipped");
    assert.equal(result.reason, "real-file");
    assert.ok(result.warning);
    assert.equal(readFileSync(linkPath, "utf8"), "do not touch\n");
    assert.equal(result.targetPath, deliverableTarget(main, "out.md"));
    ok("real file at the link path: skipped with a warning and left untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 11. A deliverable that escapes the child directory is a config error, not a link to create.
{
  const dir = temp("link-escape");
  try {
    mkdirSync(join(dir, "main"), { recursive: true });
    mkdirSync(join(dir, "child"), { recursive: true });
    assert.throws(() => ensureDeliverableLink(join(dir, "child"), join(dir, "main"), "../escape.md"), /relative path/);
    assert.throws(() => ensureDeliverableLink(join(dir, "child"), join(dir, "main"), "/tmp/absolute.md"), /relative path/);
    assert.throws(() => deliverableTarget(join(dir, "main"), "../escape.md"), /relative path/);
    ok("escaping and absolute deliverables are refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 12. All three blocks convert, with nodeModules defaulting to keep inside an existing block.
{
  const out = worktreeFromBlock({ worktree: { enabled: true } });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.worktree, { enabled: true, nodeModules: "keep" });
  assert.deepEqual(setupFromBlock({ setup: { preExec: "echo hi" } }).setup, { preExec: "echo hi" });
  assert.deepEqual(outputFromBlock({ output: { deliverable: "notes/out.md" } }).output, { deliverable: "notes/out.md" });
  const explicit = worktreeFromBlock({ worktree: { enabled: false, nodeModules: "remove" } });
  assert.deepEqual(explicit.worktree, { enabled: false, nodeModules: "remove" });
  ok("worktree, setup and output blocks convert with the nodeModules default");
}

// 13. Unknown keys and bad values are reported by block and omitted.
{
  const worktree = worktreeFromBlock({ worktree: { enabled: "yes", nodeModules: "delete", mystery: 1 } });
  assert.ok(worktree.problems.some((p) => p.includes("worktree.enabled")));
  assert.ok(worktree.problems.some((p) => p.includes("worktree.nodeModules")));
  assert.ok(worktree.problems.some((p) => p.includes("worktree.mystery")));
  assert.equal(worktree.worktree?.enabled, undefined);
  assert.equal(worktree.worktree?.nodeModules, "keep");
  const setup = setupFromBlock({ setup: { preExec: 7, extra: true } });
  assert.ok(setup.problems.some((p) => p.includes("setup.preExec")));
  assert.ok(setup.problems.some((p) => p.includes("setup.extra")));
  assert.equal(setup.setup?.preExec, undefined);
  const output = outputFromBlock({ output: { deliverable: "../escape.md", extra: true } });
  assert.ok(output.problems.some((p) => p.includes("output.deliverable")));
  assert.ok(output.problems.some((p) => p.includes("output.extra")));
  assert.equal(output.output?.deliverable, undefined);
  ok("bad keys are reported with their block name and omitted");
}

// 14. An absent block means do not intervene; a present empty block is still a block.
{
  const absent = {
    worktree: worktreeFromBlock({}),
    setup: setupFromBlock({}),
    output: outputFromBlock({}),
  };
  assert.deepEqual(absent.worktree.worktree, undefined);
  assert.deepEqual(absent.setup.setup, undefined);
  assert.deepEqual(absent.output.output, undefined);
  assert.deepEqual([absent.worktree.problems, absent.setup.problems, absent.output.problems], [[], [], []]);
  const empty = {
    worktree: worktreeFromBlock({ worktree: {} }),
    setup: setupFromBlock({ setup: {} }),
    output: outputFromBlock({ output: {} }),
  };
  assert.deepEqual(empty.worktree.worktree, { nodeModules: "keep" });
  assert.deepEqual(empty.setup.setup, {});
  assert.deepEqual(empty.output.output, {});
  ok("absent blocks stay absent; present empty blocks parse to empty configs");
}

// 15. A malformed or unknown top-level block is reported, and wired blocks are silent.
{
  assert.ok(worktreeFromBlock({ worktree: true }).problems.some((p) => p.includes("worktree must be an object")));
  assert.ok(setupFromBlock({ setup: [] }).problems.some((p) => p.includes("setup must be an object")));
  assert.ok(outputFromBlock({ output: "x" }).problems.some((p) => p.includes("output must be an object")));
  const wired = policyFromBlock({ spooky: {}, worktree: {}, setup: {}, output: {} });
  assert.deepEqual(wired.problems, ["spooky: unknown block"]);
  ok("unknown block names are reported and the three wired blocks are silent");
}


// 16. deliverable in the main checkout still gets the file grant even though no link is needed.
{
  const dir = temp("wire-same");
  try {
    mkdirSync(dir, { recursive: true });
    const policy = { absoluteWrite: [] as string[] };
    const options: { sections?: Record<string, string> } = {};
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable: "notes/out.md" } }, policy, options, (m) => warnings.push(m));
    const target = deliverableTarget(dir, "notes/out.md");
    assert.equal(result.link?.action, "none");
    assert.equal(result.target, target);
    assert.ok(policy.absoluteWrite.includes(target), "the real file is granted even with no link");
    assert.deepEqual(warnings, []);
    const section = Object.values(options.sections ?? {})[0];
    assert.ok(section?.includes("Write the deliverable to `notes/out.md`"));
    assert.ok(section?.includes("Name the file in your final message"));
    assert.ok(section?.includes(`the parent reads it at \`${target}\``));
    ok("phase 3 wiring: same-directory deliverable is granted and announced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 17. A linked worktree gets a symlink to the main file; only the file, never its parent, is writable.
{
  const dir = temp("wire-worktree");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const policy = { absoluteWrite: [] as string[] };
    const options: { sections?: Record<string, string> } = {};
    const result = wireDeliverable(worktree, { output: { deliverable: "notes/out.md" } }, policy, options, () => {});
    const target = deliverableTarget(main, "notes/out.md");
    assert.equal(result.link?.action, "created");
    assert.equal(result.link?.linkPath, join(worktree, "notes", "out.md"));
    assert.equal(readlinkSync(result.link!.linkPath), target);
    assert.ok(policy.absoluteWrite.includes(target));
    assert.ok(!policy.absoluteWrite.includes(dirname(target)), "the parent directory is not a write grant");
    const writable = sandboxWritableDirs(
      { writeGlobs: [] } as never,
      worktree,
      { writable: true, scratchPaths: [], writablePaths: [] } as never,
    );
    assert.ok(writable.includes(target), "bash can write the deliverable file");
    assert.ok(!writable.includes(dirname(target)), "bash cannot write the parent directory");
    assert.ok(Object.values(options.sections ?? {})[0]?.includes(target));
    ok("phase 3 wiring: worktree symlink points at the main file; only the file is granted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 18. readOnly never suppresses the single deliverable grant.
{
  const dir = temp("wire-readonly");
  try {
    mkdirSync(dir, { recursive: true });
    const policy = { readOnly: true, absoluteWrite: [] as string[] };
    wireDeliverable(dir, { output: { deliverable: "report.md" } }, policy, undefined, () => {});
    assert.deepEqual(policy.absoluteWrite, [deliverableTarget(dir, "report.md")]);
    ok("phase 3 wiring: readOnly still grants exactly the deliverable file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 19. A file cannot anchor a main repo: no link, no grant, and the warning names what was tried.
{
  const dir = temp("wire-no-anchor");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "not-a-directory.txt");
    writeFileSync(file, "seed\n");
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(file, { output: { deliverable: "out.md" } }, policy, {}, (m) => warnings.push(m));
    assert.equal(result.link, undefined);
    assert.deepEqual(policy.absoluteWrite, []);
    assert.ok(warnings.some((m) => m.includes(file) && m.includes("not a directory")), warnings.join("\n"));
    ok("phase 3 wiring: a file cwd reports the tried anchor and grants nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// 20. setup.preExec runs the configured command in the child cwd and reports its result.
{
  const dir = temp("preexec-ok");
  try {
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, "marker.txt");
    const result = await wirePreExec(dir, { setup: { preExec: `printf "ran\\n" >> ${marker}` } }, () => {});
    assert.equal(result.ran, true);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(marker, "utf8"), "ran\n");
    ok("phase 3 wiring: preExec runs its command in the child cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 21. A failing preExec reports the exit code and a bounded tail, without throwing.
{
  const dir = temp("preexec-fail");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const result = await wirePreExec(dir, { setup: { preExec: "seq 1 1000 >&2; printf 'boom\\n' >&2; exit 7" } }, (m) => warnings.push(m));
    assert.equal(result.ran, true, "the child still proceeds");
    assert.equal(result.status, 7);
    const text = warnings.join("\n");
    assert.match(text, /setup\.preExec exited with code 7/);
    assert.match(text, /boom/, "the tail is included");
    assert.ok(!text.includes("1\n2\n3\n"), "only the tail is reported");
    assert.ok(text.length < 2600, `the report is bounded, got ${text.length}`);
    ok("phase 3 wiring: a failing preExec reports the code and a bounded tail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 22. worktree.nodeModules: remove unlinks only the link; the target survives.
{
  const dir = temp("worktree-remove");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "deps", "shared");
    mkdirSync(target, { recursive: true });
    const link = join(dir, "node_modules");
    symlinkSync(target, link, "dir");
    assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "removed");
    assert.equal(existsSync(link), false, "the link is gone");
    assert.equal(statSync(target).isDirectory(), true, "the target is untouched");
    assert.ok(warnings.some((m) => m.includes(target)), warnings.join("\n"));
    ok("phase 3 wiring: nodeModules remove unlinks the link and keeps the target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 23. A real directory and a link outside the main checkout are both left alone, with a warning.
{
  const dir = temp("worktree-keep");
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "node_modules");
    mkdirSync(real, { recursive: true });
    assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "skipped");
    assert.equal(statSync(real).isDirectory(), true);
    assert.ok(warnings.some((m) => m.includes("real directory")), warnings.join("\n"));

    rmSync(real, { recursive: true, force: true });
    const elsewhere = temp("worktree-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    try {
      symlinkSync(elsewhere, real, "dir");
      assert.equal(wireWorktree(dir, { worktree: { nodeModules: "remove" } }, (m) => warnings.push(m)).action, "skipped");
      assert.equal(readlinkSync(real), elsewhere, "an out-of-checkout link stays");
      assert.ok(warnings.some((m) => m.includes("outside the main checkout")), warnings.join("\n"));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    rmSync(real, { recursive: true, force: true });
    const target = join(dir, "deps", "shared");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, real, "dir");
    wireWorktree(dir, { worktree: { nodeModules: "keep" } }, () => {});
    const inLink = nodeModulesWriteHint(dir, join(real, "pkg", "x.js"));
    assert.match(inLink, /worktree\.nodeModules: remove/, "keep hints at the fix");
    assert.equal(nodeModulesWriteHint(dir, join(dir, "src", "x.js")), "", "unrelated paths get no hint");
    wireWorktree(dir, { worktree: { nodeModules: "remove" } }, () => {});
    assert.equal(nodeModulesWriteHint(dir, join(real, "pkg", "x.js")), "", "no false hint after removal");
    ok("phase 3 wiring: unsafe targets are kept and the hint only appears for keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// 24. A directory at the deliverable path must never become a write grant (P0-a).
{
  const dir = temp("wire-directory");
  try {
    mkdirSync(dir, { recursive: true });
    const target = deliverableTarget(dir, "dist");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "keep\n");
    const policy = { absoluteWrite: [] as string[] };
    const options: { sections?: Record<string, string> } = {};
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable: "dist" } }, policy, options, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a directory gets no write grant");
    assert.equal(Object.keys(options.sections ?? {}).length, 0, "no deliverable section is announced");
    const writable = sandboxWritableDirs(
      { writeGlobs: [] } as never,
      dir,
      { writable: true, scratchPaths: [], writablePaths: [] } as never,
    );
    assert.ok(!writable.includes(target), "no sandbox entry for the directory");
    assert.ok(warnings.some((m) => m.includes(target) && m.includes("not a regular file")), warnings.join("\n"));
    assert.equal(result.target, target);
    ok("phase 3 wiring: a directory deliverable is refused with no grant, section, or sandbox entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 25. A symlink at the deliverable path must not redirect the grant outside the checkout (P0-b).
{
  const dir = temp("wire-symlink");
  const outside = temp("wire-outside");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const dangling = deliverableTarget(dir, "leak.txt");
    const outsideFile = join(outside, "secret.txt");
    symlinkSync(outsideFile, dangling, "file");
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    wireDeliverable(dir, { output: { deliverable: "leak.txt" } }, policy, undefined, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a link gets no write grant");
    assert.equal(existsSync(outsideFile), false, "the outside file was not created");
    assert.equal(lstatSync(dangling).isSymbolicLink(), true, "the link is left untouched");
    assert.ok(warnings.some((m) => m.includes(dangling) && m.includes("not a regular file")), warnings.join("\n"));

    // An existing outside file must also keep its bytes.
    const present = deliverableTarget(dir, "leak2.txt");
    const existing = join(outside, "existing.txt");
    writeFileSync(existing, "original\n");
    symlinkSync(existing, present, "file");
    const policy2 = { absoluteWrite: [] as string[] };
    wireDeliverable(dir, { output: { deliverable: "leak2.txt" } }, policy2, undefined, () => {});
    assert.deepEqual(policy2.absoluteWrite, [], "a link to an existing file gets no grant");
    assert.equal(readFileSync(existing, "utf8"), "original\n", "the outside file was not modified");
    ok("phase 3 wiring: a linked deliverable is refused and the outside file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// 26. Tier 3 skips a linked worktree listed first and anchors on the main checkout (P2-1).
{
  const dir = temp("anchor-list-order");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const nested = join(worktree, "nested");
    mkdirSync(nested, { recursive: true });
    // git normally prints the main worktree first; stand in for a listing that doesn't.
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\nprintf 'worktree ${worktree}\\nHEAD 000\\nbranch refs/heads/phase3\\n\\nworktree ${main}\\nHEAD 111\\nbranch refs/heads/main\\n'\n`);
    chmodSync(fakeGit, 0o755);
    const oldPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}${sep}${oldPath}`;
    try {
      const anchor = mainRepoRoot(nested);
      if (anchor.root === null) assert.fail("a main checkout must still be found");
      assert.equal(anchor.root, resolve(main));
      assert.equal(anchor.via, "worktree-list");
    } finally {
      process.env.PATH = oldPath;
    }
    ok("tier 3: a linked worktree listed first is skipped for the main checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// 27 (case A / P0). A symlinked parent inside the main checkout must not move the grant — or the file — outside it.
{
  const dir = temp("wire-parent-symlink");
  const outside = temp("wire-parent-outside");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dir, ".pi"), "dir");
    const deliverable = ".pi/reports/review.md";
    const requested = deliverableTarget(dir, deliverable);
    const resolved = join(realpathSync(outside), "reports", "review.md");
    const policy = { absoluteWrite: [] as string[] };
    const options: { sections?: Record<string, string> } = {};
    const warnings: string[] = [];
    const result = wireDeliverable(dir, { output: { deliverable } }, policy, options, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [], "a parent symlink must not grant an outside file");
    assert.equal(Object.keys(options.sections ?? {}).length, 0, "no deliverable section is announced");
    assert.equal(existsSync(resolved), false, "the outside file was never created");
    assert.equal(result.target, requested);
    assert.ok(warnings.some((m) => m.includes(deliverable) && m.includes(resolved)), warnings.join("\n"));
    ok("phase 3 wiring: a symlinked parent is refused before creating the outside file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// 28 (case B). A legitimate deliverable inside the main checkout keeps its grant even when cwd is a worktree.
{
  const dir = temp("wire-boundary-main");
  try {
    const { main, worktree } = repoWithWorktree(dir);
    const deliverable = "reports/review.md";
    const target = deliverableTarget(main, deliverable);
    const policy = { absoluteWrite: [] as string[] };
    const warnings: string[] = [];
    const result = wireDeliverable(worktree, { output: { deliverable } }, policy, undefined, (m) => warnings.push(m));
    assert.deepEqual(policy.absoluteWrite, [target], "the main-checkout file keeps its grant");
    assert.equal(result.target, target);
    assert.ok(existsSync(target), "the deliverable file was created in the main checkout");
    assert.ok(!warnings.some((m) => m.includes("outside the main checkout")), warnings.join("\n"));
    ok("phase 3 wiring: a legitimate main-checkout deliverable is not refused by the boundary check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// 29 (P2-1). The preExec timeout must not hold the event loop open: a ref'd 600s timer
// would keep a session alive for ten minutes if it ended while preExec still ran.
{
  const dir = temp("wire-timer-unref");
  try {
    const original = globalThis.setTimeout;
    const captured: ReturnType<typeof setTimeout>[] = [];
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      const handle = original(handler, timeout);
      if (timeout === 600_000) captured.push(handle);
      return handle;
    }) as typeof globalThis.setTimeout;
    try {
      await wirePreExec(dir, { setup: { preExec: `printf "ran\\n" >> ${join(dir, "marker.txt")}` } }, () => {});
    } finally {
      globalThis.setTimeout = original;
    }
    assert.equal(captured.length, 1, "the 600s timeout was installed");
    assert.equal(captured[0].hasRef?.(), false, "the timeout is unref'd so it cannot keep the session alive");
    ok("phase 3 wiring: the preExec timeout is unref'd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 30. A <active_agent> tag wins even when another md's body is also in the prompt.
{
  const dir = temp("resolve-tag");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const alphaBody = "ALPHA UNIQUE BODY MARKER for role identity tests with enough text to fill a probe beyond one hundred and twenty characters of distinctive content";
    const betaBody = "BETA DISTINCT BODY MARKER that also appears in the prompt but must not win over the tag for role identity resolution";
    writeFileSync(join(agentDir, "alpha.md"), `---\nextend:\n  permissions:\n    scope: ["a/**"]\n---\n${alphaBody}\n`);
    writeFileSync(join(agentDir, "beta.md"), `---\nextend:\n  permissions:\n    scope: ["b/**"]\n---\n${betaBody}\n`);
    const prompt = `rewritten prompt\n${betaBody}\n<active_agent name="alpha"/>\n`;
    const result = resolveRoleFromPrompt(prompt, dir, home);
    assert.equal(result.role, "alpha", "the tag wins over a body match");
    assert.deepEqual(result.warnings, []);
    ok("resolver: a tag wins even when another md's body is in the prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 31. No tag + one body match resolves that role; whitespace differences are normalised away.
{
  const dir = temp("resolve-one");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "SOLO DISTINCT BODY MARKER followed by enough unique prose that the probe stays stable across whitespace changes in both the prompt and the md file itself";
    writeFileSync(join(agentDir, "solo.md"), `---\nextend:\n  permissions:\n    scope: ["src/**"]\n---\n${body}\n`);
    const prompt = `rewritten prompt\n\n${body.replace(/ /g, "   ")}\n\ntail`;
    const result = resolveRoleFromPrompt(prompt, dir, home);
    assert.equal(result.role, "solo");
    assert.deepEqual(result.warnings, []);
    ok("resolver: one body match resolves the role across whitespace differences");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 32. Two md files with the same body are ambiguous: null plus a warning naming both.
{
  const dir = temp("resolve-ambiguous");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "IDENTICAL SHARED BODY MARKER used by two role files so a body match cannot tell them apart and must report ambiguity instead of guessing";
    writeFileSync(join(agentDir, "alpha.md"), `---\nextend:\n  permissions:\n    scope: ["a/**"]\n---\n${body}\n`);
    writeFileSync(join(agentDir, "beta.md"), `---\nextend:\n  permissions:\n    scope: ["b/**"]\n---\n${body}\n`);
    const result = resolveRoleFromPrompt(`prompt\n${body}\n`, dir, home);
    assert.equal(result.role, null, "ambiguity must not pick a role");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /more than one role md/i);
    assert.match(result.warnings[0], /alpha \(/);
    assert.match(result.warnings[0], /beta \(/);
    ok("resolver: two identical bodies are ambiguous and name both candidates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 33. No tag and no body match: null, no ambiguity warning, but extendMdSeen is reported.
{
  const dir = temp("resolve-nomatch");
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".agents");
    mkdirSync(agentDir, { recursive: true });
    const body = "UNRELATED ROLE BODY that is not present in the child prompt at all and must not be matched";
    writeFileSync(join(agentDir, "decoy.md"), `---\nextend:\n  permissions:\n    scope: ["x/**"]\n---\n${body}\n`);
    const result = resolveRoleFromPrompt("a completely unrelated rewritten prompt with no role body", dir, home);
    assert.equal(result.role, null);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.extendMdSeen, true, "the md declares extend, so the caller can explain the missing tag");
    ok("resolver: no tag and no body match yields no role but reports the extend md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 34. The deliverable section must use a pi-valid name and still carry both paths.
{
  const dir = temp("wire-section-name");
  try {
    mkdirSync(dir, { recursive: true });
    const policy = { absoluteWrite: [] as string[] };
    const options: { sections?: Record<string, string> } = {};
    wireDeliverable(dir, { output: { deliverable: "notes/out.md" } }, policy, options, () => {});
    const keys = Object.keys(options.sections ?? {});
    assert.deepEqual(keys, ["pi_subagents_extend_deliverable"], "the section is stored under the pi-valid name");
    for (const key of keys) {
      assert.match(key, /^[A-Za-z][A-Za-z0-9_]*$/, "pi rejects section names containing ':' or '-'");
    }
    const section = options.sections?.pi_subagents_extend_deliverable ?? "";
    assert.ok(section.includes("`notes/out.md`"), "the short deliverable path is named");
    const target = deliverableTarget(dir, "notes/out.md");
    assert.ok(section.includes(`\`${target}\``), "the absolute target is named");
    ok("phase 3 wiring: deliverable section has a pi-valid name and names both the short path and absolute target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\npi-subagents-extend role phase 3a tests passed (${passed} cases)`);
