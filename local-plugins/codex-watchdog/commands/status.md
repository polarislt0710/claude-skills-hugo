---
description: Classify the real state of Codex jobs in this repository (running / stalled / dead / timed-out / finished)
argument-hint: '[job-id] [--all] [--state-dir <path>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" check "$ARGUMENTS"`

Present the classification for each job, including its evidence (pid liveness, log age, elapsed
time, and the thresholds used). Do not drop jobs classified as `dead`, `queued-dead`, `stalled`, or
`timed-out` — those are the reason this command exists. If any zombie jobs are found, tell the user
they can clear them with `/codex-watchdog:reap`.
