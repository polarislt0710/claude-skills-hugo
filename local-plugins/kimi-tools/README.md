# kimi-tools

Kimi (kimi-k3-thinking via Hugo's proxy) as a one-shot delegate for Claude Code.

- `kimi-delegate` skill — chop tasks into single focused calls; plan → new session → decisions.
- Credentials live in `~/.kimi_secrets` (0600) on each machine — **never** in this repo.
- Script: `skills/kimi-delegate/scripts/kimi-call.mjs` (auto-reconnect w/ backoff, thinking-token aware).
