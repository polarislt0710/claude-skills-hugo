#!/usr/bin/env bash
# SessionStart hook — injects a "session brief" so each new Claude Code session
# knows what the previous one did (git state + HANDOFF.md) and warns when another
# session is touching the same repo. Output JSON -> additionalContext.
#
# Must never block: always exits 0.

HOOK_TAG="start"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$DIR/lib/common.sh"

emit_context() {
  # Encode the brief as additionalContext JSON; plain echo fallback if no jq.
  if [ -n "$JQ" ]; then
    "$JQ" -n --arg ctx "$1" \
      '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
  else
    printf '%s\n' "$1"
  fi
}

main() {
  read_hook_stdin
  if ! resolve_git_scope; then
    log "no git repo at $HOOK_CWD — no brief"
    exit 0
  fi
  registry_upsert

  local collide brief
  collide="$(registry_collision_warning)"

  brief=""
  brief+="## 🧭 Session brief (auto-injected)"$'\n'
  brief+="Repo: \`$(basename "$REPO_ROOT")\` · branch: \`$BRANCH\` · cwd: \`${HOOK_CWD/#$HOME/~}\`"$'\n\n'

  if [ -n "$collide" ]; then
    brief+="⚠️ **另一個 session 正在改緊呢個 repo**: $collide"$'\n'
    brief+="→ 小心撞，盡量改唔同 file / mission；收工會各自 push 去獨立 snapshot branch。"$'\n\n'
  fi

  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  brief+="### Working tree"$'\n'
  brief+="- Uncommitted changes: **$dirty** file(s)"$'\n'
  if [ "$dirty" != "0" ]; then
    brief+="\`\`\`"$'\n'
    brief+="$(git -C "$REPO_ROOT" status --short 2>/dev/null | head -12)"$'\n'
    brief+="\`\`\`"$'\n'
  fi
  brief+=$'\n'

  brief+="### Recent commits"$'\n'
  brief+="\`\`\`"$'\n'
  brief+="$(git -C "$REPO_ROOT" log --oneline -n 6 2>/dev/null)"$'\n'
  brief+="\`\`\`"$'\n\n'

  # Surface the most relevant HANDOFF.md (mission-level first, else repo-level).
  local handoff=""
  case "$HOOK_CWD" in */missions/*) [ -f "$HOOK_CWD/HANDOFF.md" ] && handoff="$HOOK_CWD/HANDOFF.md" ;; esac
  [ -z "$handoff" ] && [ -f "$REPO_ROOT/HANDOFF.md" ] && handoff="$REPO_ROOT/HANDOFF.md"
  if [ -n "$handoff" ]; then
    brief+="### 📋 Last session handoff (\`${handoff/#$HOME/~}\`)"$'\n'
    brief+="$(head -40 "$handoff")"$'\n\n'
  fi

  brief+="---"$'\n'
  brief+="_Session continuity active: work auto-commits every turn; on session end it pushes to a safe \`session/…\` branch. Maintain HANDOFF.md if you make a major decision._"

  emit_context "$brief"
  log "brief emitted for branch=$BRANCH dirty=$dirty collide=[${collide}]"
  exit 0
}

main "$@"
exit 0
