---
name: codex-watchdog
description: Dispatch, monitor, and recover Codex background jobs run through the official openai-codex plugin. Use whenever you hand work to Codex (task, rescue, review), whenever a Codex job looks dead, stuck, stalled, or its real status is unknown, whenever you need to watch a Codex job until something happens, and whenever zombie "running" jobs need to be reaped so status reporting stops lying.
---

# Codex Watchdog

The official Codex plugin dispatches jobs but never notices when a worker process dies. A job whose
process is gone still reports `running` forever, so Claude waits on a corpse. This skill is the
discipline that prevents that: every Codex job you dispatch gets a watcher, every watcher event maps
to a defined action, and every recovery is bounded.

Watchdog commands in this plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" check [job-id] [--json] [--all]
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" watch [job-id] [--poll-ms <ms>] [--max-wait-ms <ms>]
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" reap  [job-id] [--dry-run] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" doctor [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" dispatch --bypass [--model <m>] [--effort <e>] "<prompt>"
```

Watchdog dispatches Codex work in exactly one situation — the sandbox escape hatch in §6. For
everything else it only reads and repairs the official plugin's job state.
For anything that drives Codex — dispatching, fetching results, cancelling — use the official Codex
plugin's own commands (`/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`), or run
the official `codex-companion.mjs` helper at the path the official plugin provides. Never hardcode a
path into the official plugin's cache directory; it changes with every version.

## 1. Dispatch

- Send Codex work in background mode by default (`task --background`, or `/codex:rescue --background`).
  Foreground is only for work you expect to finish inside a single short turn.
- The moment you have a job id, open a watcher in the same turn, as a background Bash call:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" watch <job-id>`,
  description: "Watch Codex job <job-id>",
  run_in_background: true
})
```

- Do not poll `/codex:status` in a loop and do not call `BashOutput` to wait. The watcher exits when
  something happens, and that exit wakes you with a single JSON event on stdout.
- Never dispatch a Codex job and end the turn without a watcher attached.

## 2. Event → action table

The watcher prints exactly one JSON event and exits. Act on `event`:

| Event | Action |
| --- | --- |
| `completed` | Fetch the result with the official Codex plugin's `result` command for that job id. Process it under the existing HANDOFF discipline: completed state, files changed, test results, open questions, next single task. |
| `dead` / `queued-dead` | Run `watchdog.mjs reap <job-id>` so status stops lying, then auto-recover (see §3). **First check `sandboxDeny` — see the sandbox rule below.** |
| `stalled` | Read the log tail carried in the event. If it looks like legitimate long work (a test suite running, a large build, a long download), reopen the watcher and give it one more round. If work has genuinely stopped, treat it as `dead`: cancel via the official Codex plugin, reap, then recover. **First check `sandboxDeny` — see the sandbox rule below.** |
| `timed-out` | Cancel via the official Codex plugin's `cancel` command, then reap. **Do not re-dispatch automatically.** Report to Hugo with elapsed time and the log tail, and ask how to proceed. |
| `failed` | Fetch the result, read `errorMessage`. If the failure is clearly fixable by tightening the prompt or context packet, re-dispatch once with the fix (this counts against the recovery limit in §3). If it is environmental or unclear, report to Hugo. **First check `sandboxDeny` — see the sandbox rule below.** |
| `cancelled` | Someone stopped it on purpose. Do not recover. Report and wait for instructions. |
| `watch-timeout` | The watcher hit `--max-wait-ms` with no state change. Run `check` once, then decide: still `running` → reopen the watcher; anything else → follow that row. |
| `nothing-to-watch` | No active job existed. Do not assume success — run `check --all` and report the real state. |

### `reap` can refuse — and that is good news

`reap` re-checks each verdict against freshly read state immediately before it writes. If the job
finished between the classification and the write, it is left untouched and reported as:

```json
{ "skipped": [{ "id": "task-…", "reason": "recovered", "classification": "completed" }] }
```

Treat `reason: "recovered"` as a `completed` / `failed` event: do **not** re-run reap, do not
re-dispatch — fetch the result with the official plugin's `result` command and continue.

`evidence` also carries pid-identity fields: `pidRawAlive` (what `kill(pid, 0)` said),
`pidIdentityVerified`, and `pidReuseSuspected`. A job classified `dead` with
`pidReuseSuspected: true` means the pid is alive but belongs to an unrelated process — the worker
really is gone. `pidIdentityVerified: false` means the platform would not give us a process start
time, so liveness rests on the pid alone; say so when you report.

### The sandbox rule: `sandboxDeny`

`failed`, `stalled`, and `dead` events carry a `sandboxDeny` field, and every job in `check` carries
the same thing under `evidence.sandboxDeny`:

```json
{ "suspected": true, "matches": [{ "line": "curl: (7) Network is unreachable", "pattern": "network-unreachable" }] }
```

This is an annotation, not a verdict — it never changes the classification. When
`sandboxDeny.suspected` is true, **read the matched lines before you retry anything**, because the
official plugin overrides the Codex sandbox on every job it dispatches (`read-only` or
`workspace-write`, plus `approvalPolicy: "never"`). A user's own `~/.codex/config.toml`
`danger-full-access` has no effect on plugin-dispatched work, so a blind retry through the same path
fails the same way. Decide from the matches:

- **The job needed to write files but was dispatched read-only** (`read-only file system`, `EACCES`
  / `EPERM` / `operation not permitted` on a workspace path, `requires approval` on an edit) →
  re-dispatch through the official plugin **with `--write`**. Still the official plugin; no bypass.
- **The job needed network access, or access outside the workspace** (`network unreachable`,
  `no network`, `network access`, denials on paths outside the workspace root) → the official plugin
  cannot grant that. Re-dispatch with `dispatch --bypass` (§6), and say explicitly in the new prompt
  why: quote the denied log lines so Codex knows which step previously failed.
- **The matches look incidental** (the word "blocked" inside prose the model wrote, "sandbox" in a
  file name) → ignore the annotation and follow the normal row for that event.

Never silently assume a sandbox denial explains a failure. Quote the evidence when you report or act.

## 3. Automatic recovery, and its limit

When recovering a `dead` / `queued-dead` job:

1. If the event carries a `resumeHint.threadId`, resume the existing Codex thread
   (`task --resume-last --background` via the official helper). Otherwise re-dispatch the original
   context packet in full — goal, files, constraints, accepted decisions, prior results, open
   questions, and the single task for this round.
2. Attach a fresh watcher to the new job id immediately, exactly as in §1.
3. **Automatic recovery is capped at 2 attempts per logical task.** Count the attempts yourself
   across the conversation. On the third failure, stop recovering and report to Hugo with the full
   history: what died, when, what was retried, and what evidence you have.

### Write jobs: verify before retrying

If the dead job was a `--write` job, you must not blind-retry. Before re-dispatching:

```bash
git status
git diff --stat
```

Read what the previous attempt actually changed, then state it explicitly in the new prompt:
what is already done, what is half-done, and what remains. A write job retried blindly can redo or
double-apply work.

## 4. Red lines — never automatic

Regardless of any event, these are never done as part of automatic recovery. Stop and ask Hugo:

- `rm` / any destructive deletion
- force push, history rewrite
- anything touching production (live services, production branches, deploys, restarts of live PM2 apps)
- firewall or security configuration changes
- anything on the 🛑 ALWAYS ASK FIRST list in CLAUDE.md

If recovery would require one of these, report instead of acting.

## 5. When the watcher itself dies

If the background watch process exits with a non-zero exit code **and** printed no event JSON, the
watcher failed, not the job. Reopen the watcher on the same job id. **Cap this at 3 reopen attempts.**
After that, stop watching and fall back to manual `check` calls, and tell Hugo the watcher is
unreliable in this workspace (run `doctor` and include its output).

## 6. Bypass dispatch — the sandbox escape hatch

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" dispatch --bypass \
  [--model <model>] [--effort <low|medium|high|xhigh>] [--cwd <dir>] "<prompt>"
```

It creates a job under watchdog's own state namespace, spawns a detached worker that runs
`codex exec --sandbox danger-full-access --skip-git-repo-check`, prints one JSON line
(`{jobId, status:"queued", stateDir, logFile, bypass:true}`) and exits immediately. The job is a
normal watchdog job: `check`, `watch`, and `reap` all see it.

**Use it only when** the previous failure evidence shows the official plugin's sandbox is the actual
blocker and the work genuinely requires it:

- the job must reach the network (install a dependency, call an API, clone a repo, fetch a page)
- the job must read or write outside the workspace root

**Do not use it when:**

- the job only needed to write inside the workspace — that is `--write` on the official plugin
- you have no denial evidence, or have not read the `sandboxDeny` matches yet
- you simply want the job to "have fewer restrictions". Convenience is never a reason. Full access
  means Codex can touch anything this machine's user can touch.

Rules for every bypass dispatch:

1. The red lines in §4 apply unchanged and are **not** relaxed by full access. `rm`, force push,
   history rewrite, anything touching production, firewall or security config, and anything on the
   🛑 ALWAYS ASK FIRST list in CLAUDE.md always go to Hugo first — bypass or not.
2. The prompt **must** contain the sentence `Do not run destructive commands.` alongside the scope
   of what Codex is allowed to touch. Bypass removes the sandbox, so the prompt is the only guard
   left.
3. State the reason for the bypass in the prompt and quote the denied log lines from the failed
   attempt.
4. Attach a watcher immediately after dispatch, exactly as in §1:
   `watchdog.mjs watch <job-id>` as a background Bash call.
5. Recovery of a bypass job counts against the same 2-attempt limit in §3.

If `dispatch` is run without `--bypass`, it refuses and points back at the official plugin — that is
intended. Hugo can turn the whole path off with `{"allowBypassDispatch": false}` in
`~/.codex-watchdog.json`; if it is off, do not work around it, report instead.

## 7. Diagnosing watchdog itself

- `check` misses the job or errors about state directories → run `doctor`, and pass an explicit
  `--state-dir <path>` if the workspace layout is unusual.
- Any error about an unsupported state format version means the official Codex plugin changed its
  on-disk format. Stop, do not reap anything, and report — watchdog fails loud by design.
