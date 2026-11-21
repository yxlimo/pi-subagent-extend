// The one implementation of "where do test scratch directories go".
//
// Sandboxed children get `<repo-root>/.test-state` from the session's preExec —
// that is what their write grant covers; the package directory is not, so a
// mkdtemp inside it dies with EACCES before the first case. A plain local
// `mise run …` has no such directory. Probe the shared root by creating in it —
// a Landlock denial is invisible to an access check, so a try/catch around the
// first mkdtempSync is the honest test — and fall back to the package directory
// when the shared root is absent or not writable. harness.ts re-exports this as
// its own; suites that must not import the harness (it resolves the helper and
// loads the extension at import time) import the module directly.

import { mkdtempSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url)) // <pkg>/test
const repo = join(here, "..") // packages/pi-plugin
// Worktree root: three levels above this test directory (`<worktree>/packages/pi-plugin/test`).
const repoRoot = join(here, "..", "..", "..")

/**
 * A fresh scratch directory.
 *
 * `prefix` names it inside the shared `<repo-root>/.test-state`; `legacyPrefix` names it in the
 * package-local fallback and defaults to the same string. The two exist separately because the
 * harness's own state dir has always been called `.test-state-*` when there is no shared root, and
 * a pinning case asserts that name — renaming it would be a silent behaviour change in a plain
 * local run for no benefit.
 */
export function stateDir(prefix: string, legacyPrefix = prefix): string {
  try {
    return mkdtempSync(join(repoRoot, ".test-state", prefix))
  } catch {
    return mkdtempSync(join(repo, legacyPrefix))
  }
}

/**
 * A scratch directory for the extension's own state — sandbox spec files, `git-excludes`
 * and the `xdg-cache` toolchain cache — plus the environment redirect that makes the
 * extension use it.
 *
 * Suites that spawn real pi sessions call this before the spawn: the child inherits
 * `PI_SUBAGENTS_EXTEND_STATE` through its environment, so the extension's writes land in
 * the shared `.test-state` tree instead of the developer's real `~/.cache`. Without the
 * redirect a sandboxed child dies on its first sandboxed bash call: that spec write is
 * outside every grant. Cleanup runs on `exit` and on the terminating signals, so a failed
 * assertion does not leave the directory behind for `git add -A` to sweep into a patch.
 */
export function redirectStateDir(prefix: string, legacyPrefix = prefix): string {
  const dir = stateDir(prefix, legacyPrefix)
  const previous = process.env.PI_SUBAGENTS_EXTEND_STATE
  process.env.PI_SUBAGENTS_EXTEND_STATE = dir
  const restore = (): void => {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_EXTEND_STATE
    else process.env.PI_SUBAGENTS_EXTEND_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
  process.on("exit", restore)
  // `exit` does not run on a signal: Ctrl-C during a run would leave the directory behind.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      restore()
      process.exit(130)
    })
  }
  return dir
}
