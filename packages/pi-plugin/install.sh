#!/usr/bin/env bash
# Install the pi extension that scopes a session's file access to a task range and
# keeps main-agent-only context out of child prompts.
#
#   ./install.sh            link the package into ~/.pi/agent/extensions/
#   ./install.sh --uninstall remove the link
#
# The extension is linked, not copied: edits in this checkout take effect on the
# next pi session. Pi loads it as a directory with a package.json manifest, so
# the "pi" field in the manifest is what makes the loader pick it up (it lists two
# entries: src/index.ts for scope, src/main-context.ts for context injection).
# Without a scope configured the scope half is inert, so a global link is safe for
# parent sessions; to load the scope half only in one agent's children, prefer
# subagentOnlyExtensions in that agent's frontmatter instead (and add
# src/child-context.ts there to strip marked sections from child prompts).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="$PI_AGENT_DIR/extensions/pi-subagents-extend"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { printf '%s\n' "$*" ; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The sandbox helper is a Rust binary; without it bash stays closed (fail closed),
# so build it rather than leaving that discovery to the first bash call.
build_helper() {
  if ! command -v cargo >/dev/null 2>&1; then
    log "warning: cargo not found; run 'pnpm run build:helper' later or bash stays closed"
    return 0
  fi
  log "building the sandbox helper (cargo build --release)"
  if ( cd "$REPO_DIR" \
    && mkdir -p bin \
    && cargo build --release --quiet --manifest-path ../helper/Cargo.toml \
    && cp ../helper/target/release/pi-subagents-extend-helper bin/ ); then
    log "helper ready: $REPO_DIR/bin/pi-subagents-extend-helper"
    # --describe exits 76 when the kernel cannot enforce the sandbox, so report
    # that now instead of failing on the first bash call.
    if ! "$REPO_DIR/bin/pi-subagents-extend-helper" --describe; then
      log "warning: this kernel cannot enforce the sandbox (Landlock ABI 7 needed); bash stays closed"
    fi
  else
    log "warning: the helper did not build; bash stays closed"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -L "$INSTALL_DIR" ] || [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "removed $INSTALL_DIR"
  else
    log "nothing installed at $INSTALL_DIR"
  fi
  exit 0
fi

[ -f "$REPO_DIR/package.json" ] || die "no package.json in $REPO_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  if [ -L "$INSTALL_DIR" ] && [ "$(readlink "$INSTALL_DIR")" = "$REPO_DIR" ]; then
    log "already linked: $INSTALL_DIR -> $REPO_DIR"
    build_helper
    exit 0
  fi
  die "$INSTALL_DIR exists and is not a link to this checkout; remove it first"
fi

ln -s "$REPO_DIR" "$INSTALL_DIR"
log "linked $INSTALL_DIR -> $REPO_DIR"
build_helper
log "the next pi session loads the extension"
