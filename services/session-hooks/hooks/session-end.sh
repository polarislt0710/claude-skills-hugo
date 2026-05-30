#!/usr/bin/env bash
# SessionEnd hook — fires when a session ends (clear / exit / logout). Pushes the
# session's commits to a safe per-session branch, regenerates HANDOFF.md, and
# removes the session from the active registry.
#
# Must never block: always exits 0.

HOOK_TAG="end"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$DIR/lib/common.sh"

main() {
  read_hook_stdin
  if resolve_git_scope; then
    local result
    result="$(wrap_session)"
    log "session-end wrap: $result"
  else
    log "no git repo at $HOOK_CWD — nothing to wrap"
  fi
  registry_remove
  exit 0
}

main "$@"
exit 0
