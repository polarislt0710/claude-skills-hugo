# session-hooks — automatic session continuity & safe git for Claude Code

Turns the passive `session-continuity` / `persistent-mem` skills into **harness-enforced**
automation. Hooks are run by the Claude Code harness (not the model), so they fire
every time — no reliance on the model remembering to invoke a skill.

## What it does

| Hook | When | Action |
|---|---|---|
| `SessionStart` | new session / resume | Injects a **session brief**: branch, recent commits, dirty files, last `HANDOFF.md`, and a ⚠️ warning if another session is touching the same repo. → sessions talk to each other. |
| `Stop` | every agent turn | **Auto-commit** a WIP snapshot scoped to the session cwd (`chore(wip): auto-save …`). Secrets are stripped first. → work never lost, no 185-file soup. |
| `SessionEnd` | clear / exit | **Push HEAD → `session/<date>-<slug>-<id>`** (a safe branch, never the integration branch on the remote), regenerate `HANDOFF.md`, release the session lock. |

`bin/session-wrap.sh` does the SessionEnd wrap on demand — it backs the CloudCLI
**Wrap & Push** button (`POST /api/session-wrap`).

## Design guarantees

- **Never blocks a session.** Every hook wraps its logic and `exit 0`s no matter what.
- **Never pushes to the shared branch.** Snapshots go to per-session `session/…` refs;
  Hugo merges/cherry-picks into `feature/mvp-sprint` when ready.
- **Never commits secrets.** `.env*`, `*.key`, `*.pem`, `.credentials*`, `.telegram_secrets`
  are unstaged before every commit.
- **Concurrency aware.** `~/.cloudcli/active-sessions.json` tracks live sessions; overlap
  on the same repo surfaces as a warning in the next brief and in the CloudCLI chip.

## Files

```
lib/common.sh          shared helpers (stdin parse, git scope, commit, wrap, registry)
hooks/session-start.sh  SessionStart  → brief
hooks/session-stop.sh   Stop          → auto-commit
hooks/session-end.sh    SessionEnd    → push to safe branch + handoff
bin/session-wrap.sh     manual / API wrap
install.sh              chmod + jq-merge hooks into ~/.claude/settings.json (run on VPS)
```

State (on VPS): `~/.cloudcli/active-sessions.json`, `~/.cloudcli/session-hooks.log`.

## Deploy

```bash
# from Mac:
scp -r ~/.claude/local-marketplace/services/session-hooks orca:~/.claude/session-hooks
ssh orca 'bash ~/.claude/session-hooks/install.sh'
```

Re-run `install.sh` after editing any script. Tune via env vars:
`HUGO_CONCURRENT_WINDOW_SEC` (collision window, default 2700s),
`HUGO_SESSION_STATE_DIR` (default `~/.cloudcli`).
