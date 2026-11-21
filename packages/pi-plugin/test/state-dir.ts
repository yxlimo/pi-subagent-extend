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

import { mkdtempSync } from "node:fs"
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
