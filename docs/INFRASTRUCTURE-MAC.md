# Hugo's Mac — Infrastructure & VPS Context

> User-level CLAUDE.md, auto-loaded by **every Claude Code session on this Mac**.
> Source of truth for Hugo's full ORCA + VPS setup.

---

## 🌐 TL;DR

You are running on **Hugo's Mac** (`hugo`, macOS, zsh default shell).
Hugo owns a Hostinger VPS in Malaysia accessible via SSH alias `orca`.
Most engineering work targets the VPS or his ORCA project.
Reply in **繁體中文 / 廣東話**, technical when needed, decisive.

---

## 🖥️ VPS quick access

| Field | Value |
|---|---|
| Public IP | `187.127.115.235` |
| SSH alias | `ssh orca` (already configured in `~/.ssh/config`) |
| User | `hugo-orca` (sudo NOPASSWD) |
| Hostname | `srv1644941` (Ubuntu 24.04 LTS) |
| Region | Hostinger Kuala Lumpur, KVM 2 / 8 GB / 100 GB NVMe |
| Auto-renew | **disabled** (30-day trial, expires 2026-06-05) |

You can run shell commands on VPS via `ssh orca '<cmd>'`. Interactive bash needed for NVM-loaded tools (`bash -ic "<cmd>"`).

---

## 🚀 VPS services running

| Service | Port | Process manager | Public URL |
|---|---|---|---|
| **CloudCLI** (browser UI for Claude/Codex) | 3001 | PM2 | http://187.127.115.235:3001 |
| **Swarm Dashboard** (multi-persona jam) | 3010 | PM2 | http://187.127.115.235:3010 |
| **Cronicle** (cron with web UI) | 3012 | systemd | http://187.127.115.235:3012 |
| **ORCA backend** (FastAPI, when running) | 8000 | nohup uvicorn | local only |

PM2 daemon itself runs under systemd unit `pm2-hugo-orca.service` (auto-resurrect on reboot).

UFW firewall: ports 22 / 3001 / 3010 / 3012 open (anywhere). Fail2Ban active.

---

## 🔑 VPS auth state

| Tool | Auth method | Status |
|---|---|---|
| Claude Code | OAuth via `claude auth login --claudeai` | ✅ Max subscription, Opus 4.7 |
| Codex CLI | OAuth via `--device-auth` | ✅ ChatGPT Plus, gpt-5.5 |
| GLM | shell wrapper function | 🟡 placeholder (awaiting BigModel API key) |
| Telegram MCP | uvx wrapper + `~/.telegram_secrets` | ✅ chigwell/telegram-mcp via Telethon session string |
| GitHub (orca-platform-hugo) | Deploy key `~/.ssh/id_ed25519_github` (write) | ✅ |

**⚠️ NEVER print plaintext** tokens / passwords / API keys in chat.
Sensitive files (`~/.telegram_secrets`, `~/.env.local`, `~/.claude/.credentials.json`) all `chmod 600`.

---

## 📂 ORCA project (Hugo's main work)

- **Repo**: `git@github.com:polarislt0710/orca-platform-hugo.git` (PRIVATE)
- **VPS path**: `/home/hugo-orca/orca-platform-mvp`
- **Active branch**: `feature/mvp-sprint`
- **Convention files**: `CLAUDE.md`, `PROJECT-MEMORY.md`, `SESSION-LOG.md`, `DECISIONS.md`, `BUILD-PLAN.md`
- **Workflow**: hard-enforces PAUL-loop (Plan → Apply → Unify) per project CLAUDE.md § 3
- **Resume trigger**: user types `Resume project. Read CLAUDE.md first.`

When working on ORCA, **both** this user-level CLAUDE.md and ORCA's project CLAUDE.md apply (project-level conventions like PAUL-loop take precedence for code work).

---

## 🧩 Custom plugin marketplace

- **Source-of-truth GitHub**: https://github.com/polarislt0710/claude-skills-hugo (PUBLIC)
- **Mac local source**: `~/.claude/local-marketplace/`
  - `local-plugins/` — 5 plugins (super-personas, design, ai-prompts, marketing, swarm-tools)
  - `services/swarm-server/` — Node.js + Socket.io backend deployed to VPS at `/home/hugo-orca/services/swarm-server/`
  - `userscripts/` — Tampermonkey scripts (`cloudcli-vibe-switcher.user.js`)
- **VPS local source**: `~/.claude/local-marketplace/` (sparse-cloned subset)

### Plugins installed (both Mac + VPS)
- `super-personas` — 6 engineering personas (architect / debugger / reviewer / security-auditor / performance-engineer / refactor-engineer)
- `design` — 20 design rules (typography / color / layout / components)
- `mattpocock-skills` — 12 engineering skills (TDD / grill / diagnose / etc.)
- `swarm-tools` — multi-persona jam with WebSocket dashboard

### Mac-only plugins
- `ai-prompts` — image / single-shot video / multi-shot video prompt builders
- `marketing` — copywriting / content / growth / conversion / SEO

### Standalone skills synced Mac → VPS (in `~/.claude/skills/`)
17 anthropic-skills + data:* skills: `paul-loop`, `persistent-mem`, `session-continuity`, `consolidate-memory`, `everything-code`, `brainstormers`, `research-last30days`, `gstack`, `vibe-kanban`, `web-motion-design`, `taste-skill`, `duckdb-data`, `sql-queries`, `analyze`, `explore-data`, `validate-data`, `build-dashboard`.

---

## 🔄 Sync workflows

### Edit a plugin skill (e.g. tweak a SKILL.md)

```bash
nano ~/.claude/local-marketplace/local-plugins/<plugin>/skills/<skill>/SKILL.md
cd ~/.claude/local-marketplace
git add -A && git commit -m "..." && git push
claude plugin marketplace update hugo-personal && claude plugin install <plugin>
ssh orca 'bash -ic "claude plugin marketplace update hugo-personal && claude plugin install <plugin>"'
```

### Edit swarm-server backend (server.js / public/index.html)

```bash
# After editing on Mac:
cd ~/.claude/local-marketplace
git add -A && git commit -m "..." && git push
scp services/swarm-server/server.js orca:~/services/swarm-server/server.js          # if server.js changed
scp services/swarm-server/public/index.html orca:~/services/swarm-server/public/index.html  # if dashboard changed
ssh orca 'bash -ic "pm2 restart swarm-server"'  # only needed if server.js changed
```

### Sync standalone skills Mac → VPS

```bash
sync-skills-vps   # zsh alias defined in ~/.zshrc
```

---

## 🧷 Decision boundaries (from Hugo's brief)

### 🛑 ALWAYS ASK FIRST
- Anything costing money (API credit, plan upgrade, paid GitHub)
- Reboot VPS
- Disable security settings (UFW disable, fail2ban stop, etc.)
- Modify hPanel subscription
- Clone an unfamiliar repo before getting GitHub URL from Hugo
- Open a new UFW port

### ✅ Auto-approved (just do it)
- SSH read-only commands on VPS
- Modify VPS config files (`~/.bashrc`, `~/.claude/`, `~/.ssh/config`)
- `npm install / uninstall`
- Hostinger MCP read queries (`VPS_*`, `domains_*` GET-style)
- File edits on VPS via SSH (when Hugo asked for them)
- Plugin install / update / uninstall

### 📋 Style & format
- Reply in **繁體中文 / 廣東話** unless Hugo switches to English
- Concise, scannable (tables, code blocks, bullets)
- Don't ask permission for trivial things; do ask before destructive irreversible actions
- Standard "Report Back" template at end of multi-step tasks

---

## 🛠️ MCP servers Hugo has connected

### Local MCPs (registered via `claude mcp add`)
- `telegram` (chigwell/telegram-mcp via wrapper script)

### Cloud MCPs (auto-synced from claude.ai when authed)
- Canva, Heygen, Google Calendar, Gmail, Google Drive (needs reauth)

### Mac-side specialty MCPs
- `Hostinger` (VPS lifecycle / firewall / billing API)
- `cantonese-ai` (Cantonese TTS / Jyutping)
- `Claude_in_Chrome` (browser automation)
- `computer-use` (macOS desktop automation)

---

## 🎬 Common one-liners

```bash
# VPS health check
ssh orca 'bash -ic "pm2 list" && sudo ufw status && df -h'

# Tail swarm-server logs (debug WebSocket)
ssh orca 'bash -ic "pm2 logs swarm-server --lines 30 --nostream"'

# Reset Swarm Dashboard
curl -X POST http://187.127.115.235:3010/api/reset

# Trigger swarm via Claude Code on VPS (needs new session, must be in cwd of a project)
ssh orca 'cd ~/orca-platform-mvp && claude -p --dangerously-skip-permissions "用校長/老師/科主任/學生/研發者 jam <topic>"'

# Hostinger MCP — list VPS
# (use Hostinger MCP tool, e.g. mcp__hostinger__VPS_getVirtualMachinesV1)
```

---

## 🐾 Last updated

Generated 2026-05-08 from current chat session.
**If knowledge here drifts from reality, update via**: edit this file + commit canonical to GitHub `docs/infrastructure.md`.
