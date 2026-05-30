#!/usr/bin/env bash
# install.sh — install Hugo's session-lifecycle hooks into Claude Code.
# Run this ON THE VPS, from inside the deployed ~/.claude/session-hooks dir.
# Idempotent: safe to re-run after editing the scripts.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"

echo "==> session-hooks dir: $DIR"

# 1. Make every script executable.
chmod +x "$DIR"/hooks/*.sh "$DIR"/bin/*.sh "$DIR"/install.sh
echo "==> chmod +x done"

# 2. Require jq.
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not installed" >&2; exit 1; }

# 3. Merge the hooks block into settings.json (preserving all other keys).
[ -f "$SETTINGS" ] || echo '{}' >"$SETTINGS"
TMP="$(mktemp)"
jq \
  --arg start "$DIR/hooks/session-start.sh" \
  --arg stop  "$DIR/hooks/session-stop.sh" \
  --arg end   "$DIR/hooks/session-end.sh" \
  '.hooks = {
      "SessionStart": [ { "hooks": [ { "type":"command", "command":$start } ] } ],
      "Stop":         [ { "hooks": [ { "type":"command", "command":$stop  } ] } ],
      "SessionEnd":   [ { "hooks": [ { "type":"command", "command":$end   } ] } ]
   }' \
  "$SETTINGS" >"$TMP"
mv "$TMP" "$SETTINGS"
echo "==> merged hooks into $SETTINGS"

echo ""
echo "Installed hooks:"
jq '.hooks | keys' "$SETTINGS"
echo ""
echo "✅ Done. New Claude Code sessions will pick these up immediately."
