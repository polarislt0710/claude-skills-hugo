#!/usr/bin/env bash
# Stop hook — fires when the agent finishes a turn. Captures a scoped WIP commit
# so work is never lost and the tree never piles into a 185-file soup.
#
# Must never block: always exits 0, never emits decision:block.

HOOK_TAG="stop"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$DIR/lib/common.sh"

main() {
  read_hook_stdin
  resolve_git_scope || { log "no git repo, skip"; exit 0; }

  local sha
  if sha="$(auto_commit)" && [ -n "$sha" ]; then
    log "auto-saved $sha (scope=$SCOPE)"
    registry_upsert
  fi
  exit 0
}

main "$@"
exit 0
