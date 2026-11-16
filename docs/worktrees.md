# Worktrees, pnpm and the setup hook

A managed worktree is a fresh checkout, so tooling that resolves dependencies per directory fails
there in ways that stay invisible until a subagent runs something. `packages/worktree-setup` is a
`worktreeSetupHook` for pi-subagents that lets each project say what to do, and exists mainly
because of one upstream behaviour.

## The `node_modules` link

pi-subagents links the main checkout's `node_modules` into a new worktree
(`linkNodeModulesIfPresent`, from `finalizeCreatedWorktree`) **before** running the project's setup
hook — even though the hook is already a parameter of that function, so upstream knows the project
will set the worktree up itself. All three consequences were measured:

- **Nothing installed.** The worktree's `node_modules` is a symlink to whatever the main checkout
  happens to have. A dependency the manifest declares but the main checkout never installed fails
  with `Cannot find module`, while other packages resolve out of `<main>/node_modules/.pnpm/…` —
  the worktree has no tree of its own.
- **Install runs.** It writes through the link into the main checkout: same inode, and the main
  checkout gains packages its own manifest never declared (measured 4 → 5 top-level entries).
- **pnpm's bookkeeping is rewritten in the wrong checkout.** With `virtualStoreType: global`, each
  project records the virtual store as a *relative* path in `node_modules/.modules.yaml`. Opened
  through the link that file belongs to the main checkout while the depth pnpm computes belongs to
  the worktree, so an install rewrites the main checkout's copy:
  `../../../../.local/share/pnpm/store/v11/links` became
  `../../../../../../.local/share/pnpm/store/v11/links`, with the manifest untouched. The value now
  describes whichever project ran last, and resolved from the worktree it points at a directory
  that does not exist.

So the hook removes the link before running the declaration — a real directory is left alone — and
the project decides what to install. Measured with the hook: the worktree gets its own
`node_modules`, the install still takes about 45ms because the global virtual store is reused, and
the main checkout's `.modules.yaml` is left exactly as it was.

Upstream has an open pull request for the root cause: `worktreeNodeModulesLink: "always" | "never"`
in the pi-subagents config, defaulting to `always` so nothing changes for anyone who does not ask.
The hook's unlink stays useful on its own — it serves every project that has not set that option —
and the two do not conflict: with the link disabled upstream, `[ -L node_modules ]` is simply false.

## The hook

Only the script is installed globally; the file itself is versioned here:

```text
~/.pi/agent/extensions/subagent/worktree-setup.sh -> packages/worktree-setup/worktree-setup.sh
```

```json
// ~/.pi/agent/extensions/subagent/config.json
{
  "worktreeSetupHook": "~/.pi/agent/extensions/subagent/worktree-setup.sh",
  "worktreeSetupHookTimeoutMs": 300000,
  "worktreeBaseDir": "~/.pi/worktrees"
}
```

**A project opts in by committing `.pi/worktree-setup.sh`.** Without that file the hook exits 0
immediately and changes nothing, which is why one global script serves every project. It runs with
the worktree root as its working directory, so the declaration is just a script:

```sh
#!/bin/sh
# single-package repository
set -eu
pnpm install --prefer-offline
```

```sh
#!/bin/sh
# the manifest lives in packages/pi-plugin: pnpm fails with ERR_PNPM_NO_PKG_MANIFEST
# in a directory that has no package.json
set -eu
cd packages/pi-plugin
pnpm install --prefer-offline
```

Being an ordinary shell script, `cd`, conditionals and environment variables need no support from
the hook.

**The exit code is the whole contract.** The hook does not judge whether a worktree is usable: the
project decides, and exits non-zero when it did not get one. That is not laziness — a hook that
judged the tree would have to know where each package manager puts dependencies and what counts as
installed, which is exactly what the project knows. It matters in practice: pnpm 12 installs
everything and then exits 1 for dependency build scripts it was not allowed to run
(`ERR_PNPM_IGNORED_BUILDS`), so "installed but exit 1" is normal and must be handled by the
project's own script:

```sh
#!/bin/sh
set -eu
pnpm install --prefer-offline || true          # exit 1 here can mean "installed"
node -e 'require.resolve("typescript")'        # the real check: did it work?
```

On failure the hook prints the last 20 lines of the declaration's output and the log path, keeping
output in `~/.cache/pi-worktree-setup/<worktree directory name>.log`.

Two boundaries:

- POSIX shell, so it runs where a shebang is honoured. A Windows hook would have to be a native
  executable: pi-subagents starts it with `spawn(hookPath, [], { shell: false })`, and Node refuses
  to run `.cmd`/`.bat` that way.
- mise trust belongs to the project (`trusted_config_paths` in `~/.config/mise/config.toml`). When a
  worktree's `mise.toml` is untrusted, every shimmed command there fails, inside and outside the
  sandbox; the hook only names that cause when it sees `not trusted` in the output.

## What a worktree run delivers

A subagent's worktree and branch are normally **removed** at the end, and that is by design: the
work is captured as a patch first.

The `git add` visible in a run is not someone tampering with the index, it is the first step of
upstream's patch capture — remove the synthetic paths, `git add -A`, then
`git diff --cached <baseCommit>` into a file. So the patch is "worktree plus index against the base
commit": uncommitted changes are in it, and whether the subagent committed is irrelevant.

Removal is gated on two checks: the handoff manifest records that exact patch, and the patch on
disk is byte-identical to the current worktree. Anything else — including a failed run — preserves
the worktree and says why.

The deliverable is therefore `handoff.json` → `groups[].children[].patch`:

```text
{ path, branch, changed, diffStat, filesChanged, insertions, deletions }
```

Nothing is applied to the parent's checkout automatically. After `git branch -D` the branch and SHA
a subagent reports are dead (the objects survive until gc, two weeks by default), which is why the
extension appends a line to the `Worktree handoff:` reference the parent receives, naming
`groups[].children[].patch` as the deliverable and `groups[].cleanup.tasks[].reason` when a
worktree was kept. A patch size is also the honest measure of how much a subagent did — more
reliable than its own report.

## Symptom table

| Symptom | Cause | Handling |
| --- | --- | --- |
| `tsc` cannot find its packages after installing in a worktree | the `node_modules` link, as above | the hook removes the link first; with `virtualStoreType: global` the install takes well under a second |
| `pnpm run` refuses to start under a read-only root | pnpm 12 keeps its lock directory under `XDG_RUNTIME_DIR` | the extension points `XDG_RUNTIME_DIR` at the sandbox's private `/tmp` |
| mise fails parsing configuration inside the sandbox | it records a new worktree's `mise.toml` under `~/.local/state/mise`, which is not writable | the extension points `MISE_STATE_DIR` at the private `/tmp` |
| every mise-shimmed tool exits with `Config files … are not trusted` | a new worktree's `mise.toml` is untrusted, on the host too | declare `trusted_config_paths` in `~/.config/mise/config.toml`; nothing here can compensate |
| `pnpm install` fails inside the sandbox | the network is cut and the store is empty | grant `"network": true` on the installing command |
| a `.pnpm-store` of tens of megabytes appears in the project | the global store is not writable under a read-only root, so pnpm falls back to a project-local one | list the store in `bash.writablePaths`; `bash.gitExcludes` already keeps `.pnpm-store` out of the index |

Verifying with dependencies already present needs `verifyDepsBeforeRun: false` in
`pnpm-workspace.yaml`, the only file pnpm 12 reads that setting from.
