#!/bin/sh
# pi-subagents worktreeSetupHook, installed once and shared by every project.
#
# pi-subagents creates a worktree and starts the hook with this file as the executable and no
# arguments, with the working directory set to the new worktree root. That is all this script
# needs: the project's declaration lives in the checkout, so nothing is parsed here.
#
# A project opts in by committing <repo>/.pi/worktree-setup.sh. Without that file the hook is a
# no-op, which is why one global script can serve every project.
#
# The exit code is the whole contract: the declared script decides what a usable worktree is and
# exits non-zero when it did not get one. Nothing is second-guessed here -- pnpm 12, for
# instance, exits non-zero after installing everything when a dependency ships a build script it
# was not allowed to run, so a project that hits that says so in its own script.
set -u

declaration=.pi/worktree-setup.sh

if [ ! -f "$declaration" ]; then
	printf '{"syntheticPaths":[]}\n'
	exit 0
fi

cache=${XDG_CACHE_HOME:-"$HOME/.cache"}/pi-worktree-setup
log="$cache/$(basename "$PWD").log"
if ! mkdir -p "$cache"; then
	printf 'worktree setup: cannot create %s\n' "$cache" >&2
	exit 1
fi

sh "$declaration" >"$log" 2>&1
status=$?

if [ "$status" -eq 0 ]; then
	printf '{"syntheticPaths":[]}\n'
	exit 0
fi

{
	printf 'worktree setup failed (exit %s): %s\n\n' "$status" "$PWD/$declaration"
	tail -n 20 "$log"
	if grep -qi 'not trusted' "$log"; then
		printf '\n%s\n' "This is a mise trust failure, not a dependency failure: every shimmed"
		printf '%s\n' "command in that worktree fails until its configuration is trusted. Trust the"
		printf '%s\n' "directory the worktrees live in, in ~/.config/mise/config.toml:"
		printf '%s\n' '  [settings]' '  trusted_config_paths = ["<worktree root>"]'
	fi
	printf '\nlog: %s\n' "$log"
} >&2

exit "$status"
