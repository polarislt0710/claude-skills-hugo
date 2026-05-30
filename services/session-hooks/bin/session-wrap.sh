#!/usr/bin/env bash
# session-wrap.sh — manual / API-triggered session wrap.
# Used by the CloudCLI "Wrap & Push" button (POST /api/session-wrap) and by hand.
#
# Usage:
#   session-wrap.sh --cwd <dir>            # wrap the repo containing <dir>
#   session-wrap.sh --slug <mission-slug>  # wrap a mission folder under MISSION_BASE
#
# Prints a JSON result on stdout. Always exits 0 (errors are reported in JSON).

HOOK_TAG="wrap"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$DIR/lib/common.sh"

HOOK_CWD=""
HOOK_SESSION_ID="manual-$$"
MISSION_BASE="${MISSION_BASE_PROJECT:-$HOME/orca-platform-mvp}"

while [ $# -gt 0 ]; do
  case "$1" in
    --cwd)  HOOK_CWD="$2"; shift 2 ;;
    --slug) HOOK_CWD="$MISSION_BASE/missions/$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$HOOK_CWD" ] || HOOK_CWD="$MISSION_BASE"
[ -d "$HOOK_CWD" ] || HOOK_CWD="$MISSION_BASE"

HOOK_SHORT_ID="manual$$"
HOOK_SHORT_ID="$(printf '%s' "$HOOK_SHORT_ID" | tr -cd 'a-zA-Z0-9' | cut -c1-8)"

wrap_session
exit 0
