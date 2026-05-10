# VPS — Local Infrastructure Context

> User-level CLAUDE.md, auto-loaded by **every Claude Code session on this VPS** (`srv1644941`).
> You are NOT on Hugo's Mac — you are on his Hostinger VPS in Kuala Lumpur.

---

## 🌐 TL;DR

You are running on **Hugo's Hostinger VPS**:
- User: `hugo-orca` (sudo NOPASSWD)
- Hostname: `srv1644941`, Ubuntu 24.04 LTS
- Public IP: `187.127.115.235`
- Most operations should be **local on this VPS** unless explicitly cross-machine.
- Reply in **繁體中文 / 廣東話**.

---

## 🚀 Local services running

| Service | Port | Manager | Local URL |
|---|---|---|---|
| CloudCLI (browser Claude/Codex UI) | 3001 | PM2 | http://localhost:3001 |
| Swarm Dashboard (multi-persona jam) | 3010 | PM2 | http://localhost:3010 |
| Cronicle (cron + web UI) | 3012 | systemd | http://localhost:3012 |

`pm2 list` shows: `cloudcli`, `swarm-server`. PM2 itself managed by systemd unit `pm2-hugo-orca`.

---

## 🔑 Auth state

- **Claude Code**: Max subscription (Opus 4.7), `~/.claude/.credentials.json`
- **Codex CLI**: ChatGPT Plus, `~/.codex/auth.json`
- **GitHub**: deploy key `~/.ssh/id_ed25519_github` for `polarislt0710/orca-platform-hugo` (write)
- **Telegram MCP**: secrets in `~/.telegram_secrets` (chmod 600), session via `~/bin/run-telegram-mcp.sh` wrapper

**⚠️ NEVER print plaintext** tokens / passwords. Sensitive files (`~/.telegram_secrets`, `~/.env.local`) `chmod 600`.

---

## 📂 ORCA project

- **Path**: `~/orca-platform-mvp/`
- **Branch**: `feature/mvp-sprint`
- **Remote**: `git@github.com:polarislt0710/orca-platform-hugo.git`
- **Convention files**: `CLAUDE.md`, `PROJECT-MEMORY.md`, `SESSION-LOG.md`, `DECISIONS.md`, `BUILD-PLAN.md`
- **Workflow**: hard-enforces **PAUL-loop** per project CLAUDE.md § 3
- **Resume trigger**: user types `Resume project. Read CLAUDE.md first.`

---

## 🧩 Plugins installed (via marketplace `hugo-personal`)

Marketplace source: `https://github.com/polarislt0710/claude-skills-hugo` (PUBLIC)

- `super-personas` — 6 cognitive engineering personas
- `design` — 20 design rules (typography / color / layout / components)
- `mattpocock-skills` — 12 engineering skills (TDD / grill / diagnose / to-prd / etc.)
- `swarm-tools` — multi-persona jam with WebSocket dashboard at port 3010

Standalone user-level skills in `~/.claude/skills/`: 17 entries (paul-loop, persistent-mem, session-continuity, gstack, vibe-kanban, web-motion-design, taste-skill, duckdb-data, sql-queries, analyze, explore-data, validate-data, build-dashboard, brainstormers, research-last30days, consolidate-memory, everything-code).

---

## 🛠️ Common local commands

```bash
# Plugin updates
claude plugin marketplace update hugo-personal
claude plugin install <plugin>
claude plugin list

# Swarm-server health
curl http://localhost:3010/health

# Swarm-server restart
pm2 restart swarm-server
pm2 logs swarm-server --lines 30 --nostream

# Telegram MCP first-run (only needed once)
~/bin/run-telegram-mcp.sh

# UFW status
sudo ufw status

# ORCA repo ops (deploy key auto-attached via ~/.ssh/config)
cd ~/orca-platform-mvp
git pull / git push  # works without prompt
```

---

## 🧷 Decision boundaries

### 🛑 ALWAYS ASK FIRST
- Anything costing money
- `sudo reboot`
- Disable UFW / fail2ban / SSH password-disable rollback
- Open new UFW port
- `rm -rf` outside known scratch dirs

### ✅ Auto-approved
- Read any file
- Modify config in `~/.bashrc`, `~/.claude/`, `~/.ssh/`, `~/services/`
- `npm install / uninstall`
- Edit / commit / push to ORCA repo (deploy key has write access)
- Plugin install / update

---

## 🌐 Multi-machine context

- Hugo's **Mac** is the source-of-truth for `~/.claude/local-marketplace/` (Mac path: same `~/.claude/local-marketplace/`).
- Plugin marketplace + dashboard public at **github.com/polarislt0710/claude-skills-hugo**. Pull updates via `claude plugin marketplace update hugo-personal`.
- swarm-server source code lives on Mac; deploy via Mac `scp services/swarm-server/* orca:~/services/swarm-server/`.

---

## 🐾 Last updated

Generated 2026-05-08 from current chat session.
