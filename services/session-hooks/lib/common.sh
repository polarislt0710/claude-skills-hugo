#!/usr/bin/env bash
# common.sh — shared helpers for Hugo's Claude Code session-lifecycle hooks.
#
# Sourced by hooks/session-start.sh, hooks/session-stop.sh, hooks/session-end.sh
# and bin/session-wrap.sh. Every function is defensive: a hook must NEVER break
# or block a live Claude Code session, so callers always `exit 0`.
#
# Design notes live in services/session-hooks/README.md.

# ---- paths & constants -------------------------------------------------------
HUGO_STATE_DIR="${HUGO_SESSION_STATE_DIR:-$HOME/.cloudcli}"
HUGO_REGISTRY="$HUGO_STATE_DIR/active-sessions.json"
HUGO_LOG="$HUGO_STATE_DIR/session-hooks.log"
HUGO_LOCK="$HUGO_STATE_DIR/.registry.lock"
# How "fresh" another session's entry must be to count as a concurrent collision.
HUGO_CONCURRENT_WINDOW_SEC="${HUGO_CONCURRENT_WINDOW_SEC:-2700}" # 45 min
# Filenames that must never be auto-committed.
HUGO_SECRET_RE='(^|/)(\.env([.][^/]*)?|\.credentials.*|.*secret.*|.*\.key|.*\.pem|\.telegram_secrets)$'

mkdir -p "$HUGO_STATE_DIR" 2>/dev/null || true

JQ="$(command -v jq 2>/dev/null || true)"

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "${HOOK_TAG:-hook}" "$*" >>"$HUGO_LOG" 2>/dev/null || true; }

# ---- stdin parsing -----------------------------------------------------------
# Reads the hook JSON payload from stdin into HUGO_STDIN, then extracts fields.
read_hook_stdin() {
  HUGO_STDIN="$(cat 2>/dev/null || true)"
  HOOK_CWD="$(json_field '.cwd')"
  HOOK_SESSION_ID="$(json_field '.session_id')"
  HOOK_SOURCE="$(json_field '.source')"
  HOOK_EVENT="$(json_field '.hook_event_name')"
  [ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"
  HOOK_SHORT_ID="$(printf '%s' "${HOOK_SESSION_ID:-nosid}" | tr -cd 'a-zA-Z0-9' | cut -c1-8)"
  [ -n "$HOOK_SHORT_ID" ] || HOOK_SHORT_ID="nosid"
}

json_field() {
  [ -n "$JQ" ] || { printf ''; return; }
  printf '%s' "$HUGO_STDIN" | "$JQ" -r "$1 // empty" 2>/dev/null
}

# ---- git scope ---------------------------------------------------------------
# Resolves REPO_ROOT (toplevel), BRANCH, and SCOPE (pathspec for auto-commit).
resolve_git_scope() {
  REPO_ROOT="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$REPO_ROOT" ] || return 1
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  # Scope auto-commits to what this session is touching: the whole repo only when
  # the session cwd IS the repo root, otherwise just the cwd subtree.
  case "$HOOK_CWD" in
    "$REPO_ROOT") SCOPE="." ;;
    "$REPO_ROOT"/*) SCOPE="$HOOK_CWD" ;;
    *) SCOPE="." ;;
  esac
  return 0
}

# True (0) if a rebase/merge/cherry-pick is in progress — never auto-commit then.
git_op_in_progress() {
  local g="$REPO_ROOT/.git"
  [ -d "$g/rebase-merge" ] || [ -d "$g/rebase-apply" ] || \
  [ -f "$g/MERGE_HEAD" ] || [ -f "$g/CHERRY_PICK_HEAD" ]
}

# Derive a human branch-slug from the session cwd (mission name or repo name).
session_slug() {
  local base
  case "$HOOK_CWD" in
    */missions/*) base="$(basename "$HOOK_CWD")" ;;
    *) base="$(basename "$REPO_ROOT")" ;;
  esac
  printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-40
}

# ---- secret guard ------------------------------------------------------------
# Unstage anything matching the secret denylist before committing.
unstage_secrets() {
  local f hit=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if printf '%s' "$f" | grep -Eiq "$HUGO_SECRET_RE"; then
      git -C "$REPO_ROOT" reset -q -- "$f" 2>/dev/null || true
      hit=1
      log "secret guard: unstaged $f"
    fi
  done < <(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null)
  return $hit
}

# ---- auto-commit (Stop) ------------------------------------------------------
# Stages SCOPE, drops secrets, commits a WIP snapshot. No-op when clean.
# Echoes the new commit hash on success (empty otherwise).
auto_commit() {
  git_op_in_progress && { log "skip commit: git op in progress"; return 1; }
  git -C "$REPO_ROOT" add -A -- "$SCOPE" 2>/dev/null || true
  unstage_secrets
  if git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
    return 1   # nothing staged
  fi
  local msg="chore(wip): auto-save $(date '+%F %T') [session ${HOOK_SHORT_ID}]"
  if git -C "$REPO_ROOT" -c user.name='Claude Session' \
        -c user.email='session@cloudcli.local' \
        commit -q --no-verify -m "$msg" 2>>"$HUGO_LOG"; then
    git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null
    return 0
  fi
  return 1
}

# ---- wrap / push to safe branch (SessionEnd + manual) ------------------------
# Captures a final WIP commit, then pushes HEAD to a per-session safe branch.
# Never touches the integration branch on the remote. Echoes JSON result.
wrap_session() {
  resolve_git_scope || { printf '{"ok":false,"error":"not a git repo"}'; return 1; }
  auto_commit >/dev/null 2>&1 || true
  local slug safe head_sha pushed=false err=""
  slug="$(session_slug)"
  safe="session/$(date '+%Y-%m-%d')-${slug}-${HOOK_SHORT_ID}"
  head_sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null)"
  if git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
    if git -C "$REPO_ROOT" push --quiet --force-with-lease \
          origin "HEAD:refs/heads/$safe" 2>>"$HUGO_LOG"; then
      pushed=true
      log "pushed HEAD ($head_sha) -> origin/$safe"
    else
      err="push failed (see log)"
      log "push FAILED -> $safe"
    fi
  else
    err="no origin remote"
    log "no origin remote, skip push"
  fi
  write_handoff "$safe" "$pushed"
  if [ -n "$JQ" ]; then
    "$JQ" -n --arg b "$safe" --arg sha "$head_sha" --argjson p "$pushed" \
      --arg e "$err" '{ok:($e==""),branch:$b,head:$sha,pushed:$p,error:$e}'
  else
    printf '{"ok":%s,"branch":"%s","head":"%s","pushed":%s}' \
      "$([ -z "$err" ] && echo true || echo false)" "$safe" "$head_sha" "$pushed"
  fi
}

# ---- HANDOFF.md (session-continuity format, git-derived, no LLM) -------------
write_handoff() {
  local safe="$1" pushed="$2" out="$REPO_ROOT/HANDOFF.md"
  # Mission sessions get their own handoff inside the mission folder too.
  case "$HOOK_CWD" in */missions/*) out="$HOOK_CWD/HANDOFF.md" ;; esac
  {
    echo "# Session Handoff — $(session_slug)"
    echo "_Auto-generated $(date '+%F %T %Z') · session ${HOOK_SHORT_ID}_"
    echo
    echo "## Current State"
    echo "- Integration branch: \`$BRANCH\`"
    echo "- Snapshot branch (pushed): \`$safe\` (pushed=$pushed)"
    echo "- HEAD: \`$(git -C "$REPO_ROOT" log -1 --format='%h %s' 2>/dev/null)\`"
    echo
    echo "## What This Session Touched"
    git -C "$REPO_ROOT" log "${BRANCH}" --oneline -n 12 \
        --grep="auto-save.*session ${HOOK_SHORT_ID}" 2>/dev/null | sed 's/^/- /'
    echo
    echo "## Files Changed (vs origin)"
    git -C "$REPO_ROOT" diff --stat "@{upstream}" 2>/dev/null | sed 's/^/    /' | head -40 \
      || git -C "$REPO_ROOT" show --stat --oneline -1 2>/dev/null | sed 's/^/    /'
    echo
    echo "## Resume Next Session"
    echo "\`\`\`"
    echo "Continue $(session_slug). Last session snapshot is on branch $safe."
    echo "Review it with: git log $safe --oneline"
    echo "Cherry-pick / merge what you want into $BRANCH when ready."
    echo "\`\`\`"
  } >"$out" 2>/dev/null || true
  log "wrote handoff -> $out"
}

# ---- session registry (concurrency awareness) --------------------------------
# A coarse flock (fd 9) serialises read-modify-write on the registry JSON so two
# hooks firing at once never clobber it. The lock is opened for the whole
# function body via a subshell.
_registry_now() { date +%s; }

registry_upsert() {
  [ -n "$JQ" ] || return 0
  local now; now="$(_registry_now)"
  (
    command -v flock >/dev/null 2>&1 && flock -w 5 9
    [ -s "$HUGO_REGISTRY" ] || echo "[]" >"$HUGO_REGISTRY"
    "$JQ" \
      --arg sid "$HOOK_SESSION_ID" \
      --arg cwd "$HOOK_CWD" \
      --arg repo "${REPO_ROOT:-}" \
      --arg branch "${BRANCH:-}" \
      --argjson now "$now" \
      '( [ .[] | select(.sid != $sid) ] )
        + [{sid:$sid, cwd:$cwd, repo:$repo, branch:$branch,
            started:( ([ .[] | select(.sid==$sid) | .started ] | first) // $now ),
            updated:$now}]' \
      "$HUGO_REGISTRY" >"$HUGO_REGISTRY.tmp" 2>>"$HUGO_LOG" \
      && mv "$HUGO_REGISTRY.tmp" "$HUGO_REGISTRY"
  ) 9>"$HUGO_LOCK" 2>/dev/null || true
}

registry_remove() {
  [ -n "$JQ" ] || return 0
  (
    command -v flock >/dev/null 2>&1 && flock -w 5 9
    [ -s "$HUGO_REGISTRY" ] || exit 0
    "$JQ" --arg sid "$HOOK_SESSION_ID" \
      '[ .[] | select(.sid != $sid) ]' \
      "$HUGO_REGISTRY" >"$HUGO_REGISTRY.tmp" 2>>"$HUGO_LOG" \
      && mv "$HUGO_REGISTRY.tmp" "$HUGO_REGISTRY"
  ) 9>"$HUGO_LOCK" 2>/dev/null || true
}

# Echoes a warning line if another fresh session overlaps the same repo.
registry_collision_warning() {
  [ -n "$JQ" ] || return 0
  [ -s "$HUGO_REGISTRY" ] || return 0
  local now cutoff others
  now="$(_registry_now)"; cutoff=$(( now - HUGO_CONCURRENT_WINDOW_SEC ))
  others="$("$JQ" -r \
    --arg sid "$HOOK_SESSION_ID" --arg repo "${REPO_ROOT:-}" --argjson cutoff "$cutoff" \
    '[ .[] | select(.sid != $sid and .repo == $repo and .updated >= $cutoff) ]
       | map(.branch + " (" + (.cwd|sub(".*/";"")) + ")") | unique | join(", ")' \
    "$HUGO_REGISTRY" 2>/dev/null)"
  [ -n "$others" ] && [ "$others" != "null" ] && printf '%s' "$others"
}
