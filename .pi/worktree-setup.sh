#!/bin/sh
# Worktree setup for this repository, run by pi-subagents before a subagent starts.
#
# The manifest for the plugin lives in packages/pi-plugin, so pnpm has to run there; the
# worktree root has no package.json and pnpm would fail with ERR_PNPM_NO_PKG_MANIFEST.
# The exit code is the contract, so this script must fail loudly when the tree is unusable.
set -eu

cd packages/pi-plugin
pnpm install --prefer-offline
