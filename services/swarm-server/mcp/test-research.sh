#!/usr/bin/env bash
# 端到端 smoke：直接打 MCP server，真 call Perplexity（要 ~/.perplexity_secrets）。
# 排除 claude/codex 變數，純測 MCP → Perplexity + angles + budget log。
[ -f "$HOME/.perplexity_secrets" ] && source "$HOME/.perplexity_secrets"
export COUNCIL_RUN_ID="${COUNCIL_RUN_ID:-smoketest}"
export PPLX_LOG_DIR="${PPLX_LOG_DIR:-/tmp/pplx-smoke}"
MCP="$(dirname "$0")/perplexity-research.mjs"
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"research","arguments":{"query":"HKDSE 地理科考試結構同評核方式","angles":["卷一同卷二嘅題型同分數分佈","必修課題與選修課題範圍","SBA 校本評核點計分"]}}}' \
  | node "$MCP"
