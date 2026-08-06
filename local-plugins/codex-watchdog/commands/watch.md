---
description: Watch a Codex job until it finishes, dies, stalls, or times out, then report the event
argument-hint: '[job-id] [--poll-ms <ms>] [--max-wait-ms <ms>] [--state-dir <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Launch the watcher in the background so this turn is not blocked:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" watch "$ARGUMENTS"`,
  description: "Watch Codex job",
  run_in_background: true
})
```

Do not call `BashOutput` or wait for completion in this turn. Tell the user the watcher is running
and that it will wake Claude with a single JSON event when the job finishes, dies, stalls, or times
out. When that event arrives, handle it using the `codex-watchdog` skill's event-to-action table.
