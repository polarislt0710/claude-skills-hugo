#!/usr/bin/env bash
# Emit a swarm dashboard event. NEVER fails the jam — always exits 0.
#
# Usage:
#   emit-event.sh <event-type> '<json-payload>'
#   echo '<json-payload>' | emit-event.sh <event-type> -
#
# Event types: swarm-start | agent-proposal | debate-message | rebuttal |
#              synthesis-complete | persona-added | context-update
#
# Env:
#   SWARM_DASHBOARD_URL  dashboard base URL (default: http://187.127.115.235:3010)

URL="${SWARM_DASHBOARD_URL:-http://187.127.115.235:3010}"
TYPE="$1"
PAYLOAD="$2"

if [ -z "$TYPE" ]; then
  echo "[emit-event] usage: emit-event.sh <event-type> '<json>' (or - for stdin)" >&2
  exit 0
fi

if [ "$PAYLOAD" = "-" ] || [ -z "$PAYLOAD" ]; then
  PAYLOAD="$(cat)"
fi

if ! curl -s -m 5 -X POST "$URL/events/$TYPE" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1; then
  echo "[emit-event] ⚠ dashboard unreachable at $URL — continuing without visualization" >&2
fi

exit 0
