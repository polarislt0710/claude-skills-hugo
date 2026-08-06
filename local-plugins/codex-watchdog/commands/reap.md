---
description: Mark dead Codex jobs as failed so official status reporting stops showing them as running
argument-hint: '[job-id] [--dry-run] [--state-dir <path>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" reap "$ARGUMENTS"`

Report which jobs were reaped and which were left alone, along with the evidence that justified each
reap. Only jobs classified as `dead` or `queued-dead` are touched; logs are never deleted. If the
run was a `--dry-run`, say so explicitly and offer to run it for real.
