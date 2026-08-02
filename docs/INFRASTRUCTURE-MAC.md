# Claude Code VPS Setting — Control Plane

> Project-level CLAUDE.md, auto-loaded when **a Claude Code session opens this folder** (`~/Documents/Workspace/Claude Code VPS setting/`).
>
> Purpose: **THIS folder is the conversation / staging area for VPS infrastructure work.** Source code & plugins live elsewhere — see paths below.
>
> Reply in **繁體中文 / 廣東話**, technical when needed, decisive.

---

## 🗂️ Where everything actually lives

This folder is the **conversation / staging dir**，2026-07-12 已整理成八個分類（睇 root 嘅 `INDEX.md`：`01-product-orcagrade` 產品文件 / `02-reports-reviews` / `03-swarm-tooling` / `04-screenshots` / `05-code-snapshots` / `06-vps-infra` / `07-backups` / `08-rebuild-v2`）。Source code & plugins 嘅正身喺：

| What | Where |
|---|---|
| Plugin marketplace source-of-truth (Mac) | `~/.claude/local-marketplace/`（2026-07-18 一度唔見咗；**2026-07-19 已由 GitHub re-clone 返，8 個 plugin 亦已重新 install**）；VPS live code 已行前過 GitHub |
| Plugin marketplace source-of-truth (GitHub, public) | https://github.com/polarislt0710/claude-skills-hugo （最後 commit 2026-07-12；⚠️ **public** repo，考慮轉 private） |
| User-level Mac CLAUDE.md (also auto-loaded) | `~/.claude/CLAUDE.md` (hidden dotfile) |
| User-level VPS CLAUDE.md | `ssh orca` then `~/.claude/CLAUDE.md` |
| ORCA project | `~/orca-platform-mvp/` (on VPS only) |
| swarm-server backend (Mac source) | `~/.claude/local-marketplace/services/swarm-server/` |
| swarm-server (deployed VPS copy) | `/home/hugo-orca/services/swarm-server/` |
| Tampermonkey userscripts source | `~/.claude/local-marketplace/userscripts/` |

**To view hidden dotfile dirs in Finder**: press `Cmd+Shift+.` (toggles `.dotfile` visibility).

---

## 🌐 VPS quick access

| Field | Value |
|---|---|
| Public IP | `187.127.115.235` |
| SSH alias | `ssh orca` (configured in `~/.ssh/config`) |
| User | `hugo-orca` (sudo NOPASSWD) |
| Hostname | `srv1644941` (Ubuntu 24.04 LTS) |
| Region | Hostinger Kuala Lumpur, KVM 2 / 8 GB / 100 GB NVMe |
| 訂閱狀態 | **已續費**（2026-07-18 Hugo 確認；原 30 日試用已過渡到正式訂閱。下次扣費日 / auto-renew 設定待 hPanel 核實） |

Run shell commands on VPS via `ssh orca '<cmd>'`. Interactive bash needed for NVM-loaded tools (`bash -ic "<cmd>"`).

---

## 🚀 VPS services running

| Service | Port | Process manager | URL | Source code |
|---|---|---|---|---|
| **CloudCLI** (browser UI for Claude/Codex) | 3001 | PM2 | http://187.127.115.235:3001 | npm `@cloudcli-ai/cloudcli@0.40.1` |
| **Swarm Dashboard** (Agent Swarm V3) | 3010（bind `127.0.0.1`） | PM2 | https://swarm.orcagrade.com （nginx HTTPS+gate；登入頁 `/login` 打密碼即可；舊 `:3010` 已 301 過去；key 睇 `/etc/nginx/sites-enabled/orca`） | `~/.claude/local-marketplace/services/swarm-server/` |
| **Swarm Workbench**（溝通工作台） | 同上 | 同上 | https://swarm.orcagrade.com/w.html | `public/w.html` + `routes/workbench.js`（threads/上載/URL抓取/report編輯/Copilot） |
| **swarm-mission-v4**（獨立 V4 實驗） | 3011 | PM2 | https://swarm-v4.187-127-115-235.sslip.io | VPS only（唔喺 marketplace repo；同 swarm-server 無關，唔好誤 restart / 覆蓋） |
| **MiroFish** (群體智能引擎) | 3010/mirofish/ | PM2 (backend: 5001 localhost) | https://swarm.orcagrade.com/mirofish/ | `~/services/mirofish-web/` |
| **Cronicle** (cron + web UI) | 3012 | systemd | http://187.127.115.235:3012 | `/opt/cronicle/` |
| **ORCA backend** (FastAPI, when running) | 8000 | nohup uvicorn | local only | `~/orca-platform-mvp/apps/mvp-web/backend/` |
| **ORCA frontend** (Next.js MVP) | 8003 | PM2 direct Next.js binary | https://mvp.187-127-115-235.sslip.io | `~/orca-platform-mvp/apps/mvp-web/frontend/` |

PM2 daemon itself runs under systemd unit `pm2-hugo-orca.service` (auto-resurrect on reboot). UFW firewall: ports 22 / 80 / 443 / 3001 / 3010 / 3012 / 8000 / 8003 open. Fail2Ban active.

**⚠️ swarm-server bind 規則（2026-07-13）**：nginx 而家霸住 public IP `:3010`（做舊 bookmark 301 → HTTPS dashboard），node 一定要 bind `127.0.0.1` — PM2 env 有 `SWARM_BIND=127.0.0.1`（喺 dump.pm2 persist 咗）。如果 `pm2 restart swarm-server --update-env` 時漏咗呢個 env，server 會 EADDRINUSE crash-loop（7 月初就係咁死咗幾日）。

## 🥇 預設 coding flow — Matt Pocock skills（2026-08-03 起，行先）

**Hugo 已定：所有 coding 工作預設用 `mattpocock-skills` plugin（官方 https://github.com/mattpocock/skills ，marketplace `mattpocock`，Mac+VPS 都裝咗）嘅 flow 行先**，除非 Hugo 明講唔使。個 flow：

1. **問清需求** → `grilling` / `grill-me`（連環追問到需求無含糊位先郁手）
2. **寫規格** → `to-spec`
3. **拆 tickets** → `to-tickets`（每張 ticket 細到一個 session 做得完）
4. **小步實作＋測試** → `implement`（配合 `tdd`）
5. **Code review** → `code-review`（mattpocock 版；built-in /code-review 可以做加固）
6. **交接** → `handoff`（session 尾寫低狀態俾下一手）

補充：
- 超大件、一個 session 裝唔落嘅工作 → 先用 `wayfinder` 開 decision-ticket 地圖，逐個決定拆完先入上面 flow
- 快手試 idea → `prototype`；追 bug → `diagnosing-bugs`；砌 domain model → `domain-modeling`
- 呢個 flow 同下面 Codex 分工並行唔衝突：flow 定「做嘢次序」，Codex 分工定「邊個落手寫」——implement 階段照可以交 Codex，但 spec/tickets/review/handoff 紀律照跟
- 好細嘅一兩行 trivial fix 唔使全套，但凡有新 feature / 多檔改動 / 需求未清，一律行全 flow

## 🧭 工具分工 — 幾時用邊個（2026-07-13 Swarm Mission review 結論）

**Heuristic：出 brief 嗰陣寫唔寫得出「點驗收」？寫得出 → Swarm Mission；寫唔出 → Claude Code。**

| 工具 | 定位 | 適合 | 唔好用嚟 |
|---|---|---|---|
| **Claude Code / Codex CLI** | Pair programmer（軚盤） | 探索、debug、需求未清、要「睇完結果先知下一步」嘅緊密迭代 | 通宵長跑、大批量並行 |
| **Swarm Mission**（code pipeline） | 判頭團隊（發射台） | brief 清楚 + 驗收清單明確；通宵 / 背景 / 並行；Telegram 遙控 | 互動式研發、未諗清楚嘅 idea |
| **Swarm Council**（三模議會） | 決策評審 | plan review、方案拗贏拗輸、風險評估 | 直接落 code（要經 execute） |

**Swarm Workbench（2026-07-13 落 live）**：`/w.html` 三欄溝通工作台 — 左欄 threads+runs、中欄總管⇄Run對話（ACTION confirm chips 直接開 mission/followup/議會）、右欄 5 tabs（Run詳情+push gate / 報告可編輯連舊版 / 改咗乜 diff viewer / 下一步 / 檔案）。檔案輸入行「存 disk → agent 自己 Read」pattern（Excel/圖/PDF drag-drop/paste + 🔗 URL 抓取連 SSRF guard）。**Followup Copilot**：run 完 AI 自動提跟進提案（右欄卡 ✅照做/✍️傾過先/🛑，預設 3 輪可較）；另有 per-run autopilot（≤3 輪全自動，只限 followup 類，council/execute/push 永遠人手）。新 API 全部喺 `/api/workbench/*`。

Mission 兩個結構補強（2026-07-13 落 live）：
- **Change reports**：server 自己 capture 每個 code stage 嘅 git diff（唔靠 agent 自報）— 完成通知列改咗乜、dashboard / m.html 有「📝 改咗乜」panel、`GET /api/runs/:id/changes`；autoReview / next-steps / fixer / verifier 都食真 diff
- **🔁 跟進 followup**：完成咗嘅 run 直接追加指示（`POST /api/runs/:id/followup`、TG `/followup` 或 **reply 完成通知直接打字**、兩個 UI 都有掣）— 同 run/project/context 繼續，帶埋原 brief + 之前改動 + 驗證結果；未 push 嘅 gate 會被 supersede，跟進完重新入 gate 一次過 push
- Brief refine 要求【驗收清單】（逐條可執行指令），verifier 對住真 diff 逐條真行；`SWARM_FOLLOWUP_RESUME=1`（VPS 已開）followup agent 用 `claude -p --resume` 接返上手 CLI session
- Mission 代碼註：root `mission.js` 係死代碼（冇人 require）；`routes/mission.js` + `lib/mission-orchestrator.js` 係 disabled v2（`MISSION_ORCHESTRATOR_ENABLED` 冇開）— 兩個都唔好當 live pipeline 改

### ORCA MVP frontend deployment guard

Production MVP frontend **must not** be launched with `npm run start`, `next start`, `nohup npm run start`, or `pm2 start npm -- run start`; these can leave duplicate Next.js child processes and occupy port `8003`.

Approved deploy/restart flow:

```bash
ssh orca 'bash -ic "cd ~/orca-platform-mvp && scripts/restart-mvp-frontend.sh"'
```

Success checks: PM2 app `orca-mvp-frontend` online, exactly one listener on `127.0.0.1:8003`, and `https://mvp.187-127-115-235.sslip.io/` returns 200.

### MiroFish 詳情

- **描述**：「簡潔通用的群體智能引擎，預測萬物」（AGPL-3.0）
- **架構**：Vue 3 前端 (Vite) + Flask 後端 (uv + Python)
- **前端 serve**：build 輸出放在 `~/services/swarm-server/public/mirofish/`，由 swarm-server 靜態 serve
- **後端 API**：PM2 管理 (`mirofish-backend`)，bind `localhost:5001`，swarm-server 透過 `/mirofish-api` proxy 轉發
- **入口**：CloudCLI header 有 MiroFish 按鈕（teal 色，開新 tab）、Swarm Dashboard topbar 亦有
- **多語言**：`locales/` 有 `en.json`、`zh.json`

### Agent Swarm V3 skill 注入系統

Execution agent 同 thinking agent 會自動注入對應嘅 skill 內容到 prompt：

| Agent | 注入嘅 Skills |
|---|---|
| 全部 agent | execution-discipline（無條件行先注入） |
| Frontend Agent | typography, color, layout, components, taste-skill, performance-engineer |
| Backend Agent | architect, debugger, performance-engineer |
| Test Agent | debugger, reviewer-persona |
| Reviewer Agent | reviewer-persona, security-auditor, refactor-engineer |
| Research Agent | brainstormers |
| Strategy Agent | brainstormers, architect |
| Synthesis Agent | brainstormers |

Skills 喺 swarm-server 啟動時**全部由 `~/.claude/plugins/cache/hugo-personal/` 讀取**並 cache（**13 / 13 loaded**；2026-07 起再冇 standalone 依賴，`~/.claude/skills/` 兩部機都係空）。Registry 喺 `server.js` 嘅 `SKILL_REGISTRY`：`brainstormers`→workflow-tools、`taste-skill`→design:taste、`execution-discipline`→swarm-tools。Cache dir 用動態 resolve（`dirs[0]`）— **每個 plugin 只可以有一個 version dir**，`claude plugin update` 之後記得 prune 舊 hash dir。驗證：`pm2 logs swarm-server | grep skill-inject` 要見 `loaded 13 / 13 skills` 零 ⚠。

### CloudCLI 自訂 UI 層

CloudCLI 係第三方 npm 套件，透過外掛 CSS/JS 檔案客制化：
- `dist/cloudcli-hugo-themes.css` — 三個 theme（Light / Cozy / Dark）嘅完整視覺覆蓋
- `dist/cloudcli-hugo-themes.js` — theme switcher、Swarm 側面板、MiroFish 按鈕
- Theme switcher 固定喺右下角，Swarm/MiroFish 按鈕注入 header
- **注意**：`npm update` CloudCLI 後需要重新部署呢兩個檔案

### CloudCLI Mission feature（cwd redirect）

避免 Claude 寫到亂晒 ORCA repo root；揀緊 mission 時，所有 Write/Edit 自動 redirect 到 `~/orca-platform-mvp/missions/<plan-slug>/`。

- **Source-of-truth**：`~/.claude/local-marketplace/services/cloudcli-patches/`
  - `server/mission-cwd.service.js` — `resolveMissionCwd(options)` helper（slug → cwd override + mkdir）
  - `server/missions.routes.js` — `GET /api/missions` (list `MISSION-*.md`), `POST /api/missions/:slug/ensure`, `GET /api/missions/:slug/files`
  - `dist/cloudcli-hugo-mission.{js,css}` — 右上角 Mission selector overlay + WebSocket monkey-patch（注入 `options.missionSlug`）
  - `scripts/apply-patches.sh` — idempotent apply script，npm update 後 re-run
- **Patch 目標**：`dist-server/server/index.js`（mount route）+ `dist-server/server/modules/websocket/services/chat-websocket.service.js`（攔截 4 個 provider call）+ `dist/index.html`（加 script/link）
- **Plan name 來源**：自動掃 `~/orca-platform-mvp/MISSION-*.md`；slug = filename strip `MISSION-` prefix 同 `.md`，小階；title = 第一行 `# MISSION — XXX` 嘅 `XXX`
- **Env override**：`MISSION_BASE_PROJECT` env var 可改 base path（default `~/orca-platform-mvp`）
- **Re-apply 流程**（npm update CloudCLI 後）：`ssh orca 'bash -ic "~/.claude/local-marketplace/services/cloudcli-patches/scripts/apply-patches.sh && pm2 restart cloudcli"'`

---

## 🔑 VPS auth state

| Tool | Auth method | Status |
|---|---|---|
| Claude Code | OAuth via `claude auth login --claudeai` | ✅ Max subscription, Opus 4.7 |
| Codex CLI | OAuth via `--device-auth` | ✅ ChatGPT Plus, gpt-5.5 |
| GLM | shell wrapper `glm()` in `~/.bashrc`；BigModel key 實際已存在（喺 CloudCLI PM2 env） | ⚠️ **2026-07-18 決定：淘汰 GLM，用 Kimi 取代議會座位**。空咗兩個月，key 又喺 log 暴露過要 rotate |
| Kimi (proxy) | ✅ 已接入（2026-07-23）：`https://fix.6kd.top/v1`，model `kimi-k3-thinking`，key 喺 `~/.kimi_secrets`（Mac+VPS，0600）+ VPS `~/.swarm_v5_secrets`（V5 config 認咗）；plugin `kimi-tools`（hugo-personal） | ⚠️ 非官方 proxy：慢／1M ctx／成日斷線（script 自動重駁）；**backend 自報 GLM-5.2 扮 Kimi**（Hugo 知情）；紀律＝斬件 one-shot，plan 完開新 session |
| Telegram MCP | uvx wrapper + `~/.telegram_secrets` | ✅ chigwell/telegram-mcp via Telethon session string |
| GitHub (`polarislt0710/orca-platform-hugo`) | Deploy key `~/.ssh/id_ed25519_github` | ✅ write access |

**⚠️ NEVER print plaintext** tokens / passwords / API keys in chat.
Sensitive files (`~/.telegram_secrets`, `~/.env.local`, `~/.claude/.credentials.json`) all `chmod 600`.

---

## 📂 ORCA project (Hugo's main work)

- **Repo**: `git@github.com:polarislt0710/orca-platform-hugo.git` (PRIVATE)
- **VPS path**: `/home/hugo-orca/orca-platform-mvp`
- **Branch / 部署佈局（2026-07-24 大整理）**：
  - **LIVE orcagrade.com = `Production`**，由 primary worktree `~/orca-platform-mvp` deploy（PM2 `orca-mvp-backend`:8000 + `orca-mvp-frontend`:8003 都喺呢個資料夾）。**唔好喺 `~/orca-platform-mvp` 亂改 —— 一 restart 就上 live。**
  - **日常 test = `staging`**，喺**獨立 worktree `~/orca-staging`** 做，改極都唔會搞亂 live。⚠️ 開 Claude session 做嘢／test 要 `cd ~/orca-staging`。
  - **升 live 流程**：喺 staging 改好 → merge/ff `staging` → `Production` → 喺 `~/orca-platform-mvp` restart（backend `pm2 restart orca-mvp-backend --update-env`；frontend 用 `scripts/restart-mvp-frontend.sh`）。
  - GitHub **default = `staging`**（工作線）。GitHub 淨返兩條：`staging` + `Production`。舊 `ui-redesign` renamed → `staging`；`main`、3 條 Liston 線（`feature/concept-tree*`、`feature/mvp-sprint`）、8 條已併入舊 branch 全刪。
  - 全 repo bundle 備份喺 VPS `~/orca-all-branches-backup-20260724.bundle`（35M / 80 ref）。⚠️ Liston 原靠 GitHub `feature/concept-tree*` 交收，已無，要改用 `staging`。
- **Convention files**: `CLAUDE.md`, `PROJECT-MEMORY.md`, `SESSION-LOG.md`, `DECISIONS.md`, `BUILD-PLAN.md`
- **Workflow**: hard-enforces **PAUL-loop** (Plan → Apply → Unify) per project CLAUDE.md § 3
- **Resume trigger**: user types `Resume project. Read CLAUDE.md first.`

---

## 🧩 Plugins installed (Mac + VPS)

Marketplace: `hugo-personal` → `https://github.com/polarislt0710/claude-skills-hugo`

| Plugin | Version | Sub-skills | Mac | VPS |
|---|---|---|---|---|
| `super-personas` | 1.0.1 | architect / debugger / reviewer / security-auditor / performance-engineer / refactor-engineer | ✅ | ✅ |
| `design` | 1.1.0 | typography / color / layout / components / **web-motion-design** / **taste** | ✅ | ✅ |
| `swarm-tools` | 1.1.0 | multi-persona-jam（5-phase，scripts/emit-event.sh + references/）/ **execution-discipline** | ✅ | ✅ |
| `ai-prompts` | 1.0.1 | image / single-shot-video / multi-shot-video | ✅ | ✅ |
| `marketing` | 1.0.1 | copywriting / content-templates / growth-strategies / conversion / seo | ✅ | ✅ |
| `workflow-tools` | 1.0.0 | paul-loop / seed / brainstormers / everything-code / cli-anything / research-last30days / awesome-code-skills / gstack | ✅ | ✅ |
| `media-tools` | 1.0.0 | cantonese-ai（連 scripts/）/ remotion（remotion-video + best-practices 合併） | ✅ | ✅ |
| `data-tools` | 1.0.0 | duckdb-data | ✅ | ✅ |
| `kimi-tools` | 1.0.0 | kimi-delegate（一次過任務交 Kimi proxy，自動重駁；key 喺 `~/.kimi_secrets` 唔入 repo） | ✅ | ✅ |
| ~~`mattpocock-skills`~~ (舊 smll-ai 版) | — | — | ❌ | ❌（2026-08-03 已 uninstall，改用下面官方 `mattpocock` marketplace 版） |

### 第二個 marketplace：`openai-codex`（2026-07-22 裝）

Repo: https://github.com/openai/codex-plugin-cc （OpenAI 官方）

| Plugin | Version | 指令 | Mac | VPS |
|---|---|---|---|---|
| `codex@openai-codex` | 1.0.6 | `/codex:review`（唯讀）/ `/codex:adversarial-review` / `/codex:rescue`（delegate coding）/ `/codex:transfer` / `/codex:status` / `/codex:result` / `/codex:cancel` | ✅ | ✅ |

- **分工（2026-07-30 更新）**：Claude／Opus 係協調者、決策者、狀態持有人同最後 reviewer；Codex 負責調查、planning、寫 code、修 bug 同測試。難或重要任務用 `gpt-5.6-sol`＋high；容易又唔重要用 `gpt-5.6-terra`＋high。
- **Codex 係 one-shot**：每個 Codex call 只回覆一輪，完結後唔會自動記得之前內容。`--background` 只代表背景執行，唔代表保留 session 或對話記憶。
- **同一個 section 接力**：每次開新 Codex call，Claude 都要附上完整但精簡嘅 context packet：目標、section／檔案路徑、相關原文或行號、限制、已接受決定、上一輪結果、未解問題，以及今輪唯一任務。唔好只寫「繼續上次工作」。
- **Plan → Implement**：複雜任務第一個 call 叫 Codex 調查及出 plan；Claude review、回答問題及作必要決定後，要立即開新 call，連同原 context packet、Codex plan 同 Claude 答案，明確叫 Codex 實作及測試。除非缺少只有主人先知道嘅資料，否則唔好停低等額外批准。
- **Codex 問 Opus**：叫 Codex 用 `BLOCKED_QUESTION` 回傳問題、證據、建議答案同影響。Claude／Opus 自行處理可判斷嘅問題，再將答案放入新 Codex call；真正需要主人提供資料先問主人。
- **每輪交接**：要求 Codex 回覆尾段提供 `HANDOFF`，列出完成狀態、改動檔案、測試結果、未解問題同下一個 call 嘅唯一任務。Claude 保存並傳入下一輪，直至同一個 section 完成及通過驗收。
- 第二對眼睇 code 用 `/codex:review`（唯讀）；挑戰設計決定用 `/codex:adversarial-review`。Claude 必須自行檢查 diff 同測試證據，唔好將 Codex 嘅自我聲稱當成驗收。
- Mac Codex CLI 0.145.0（npm global 新裝），ChatGPT login 本身已有；default model `gpt-5.6-terra` high effort（`~/.codex/config.toml`）；`codex exec` smoke test 通
- VPS Codex CLI 一早 auth 咗（gpt-5.5→已可用 5.6）；長 task 記得 `--background`

### 第三個 marketplace：`mattpocock`（2026-08-03 裝，coding flow 行先）

Repo: https://github.com/mattpocock/skills （Matt Pocock 官方；取代舊 smll-ai fork）

| Plugin | Version | 重點 skills | Mac | VPS |
|---|---|---|---|---|
| `mattpocock-skills@mattpocock` | 1.2.0 | **flow 六步**：grilling/grill-me → to-spec → to-tickets → implement(+tdd) → code-review → handoff；另有 wayfinder（超大件工作 decision-ticket 地圖）/ prototype / diagnosing-bugs / domain-modeling / codebase-design / triage / research / resolving-merge-conflicts / teach / writing-great-skills | ✅ | ✅ |

- **用法**：見上面 § 🥇 預設 coding flow — 所有 coding 預設行呢個 flow
- 首次喺某 repo 用可以行 `/setup-matt-pocock-skills` 綁 issue tracker（冇 tracker 就 fallback local markdown tickets）

### Standalone skills (`~/.claude/skills/`)
**無 — 2026-07-12 skills consolidation 已全部遷入 marketplace plugins**（brainstormers/taste/execution-discipline 等 12 個入咗上面嘅 plugin；persistent-mem/session-continuity/code-review/security-review/superpowers/openspace-agents/video-db/vibe-kanban 等因同 built-in 重複已淘汰）。兩部機嘅 `~/.claude/skills/` 都係空。

---

## 🔄 Sync workflows

### Edit a plugin skill (e.g. tweak SKILL.md)

```bash
nano ~/.claude/local-marketplace/local-plugins/<plugin>/skills/<skill>/SKILL.md
cd ~/.claude/local-marketplace
git add -A && git commit -m "..." && git push
claude plugin marketplace update hugo-personal && claude plugin install <plugin>
ssh orca 'bash -ic "claude plugin marketplace update hugo-personal && claude plugin install <plugin>"'
```

### Edit swarm-server backend / dashboard

```bash
# Edit on Mac:
nano ~/.claude/local-marketplace/services/swarm-server/server.js
# OR
nano ~/.claude/local-marketplace/services/swarm-server/public/index.html

# Push + deploy:
cd ~/.claude/local-marketplace
git add -A && git commit -m "..." && git push
scp services/swarm-server/server.js orca:~/services/swarm-server/server.js
scp services/swarm-server/public/index.html orca:~/services/swarm-server/public/index.html
ssh orca 'bash -ic "pm2 restart swarm-server"'   # only if server.js changed
```

### Sync skills Mac → VPS（2026-07 起用 plugin 機制）

```bash
# Mac（改完 skill 先 commit+push，兩部機先攞到）
claude plugin marketplace update hugo-personal && claude plugin update <plugin>@hugo-personal
# VPS（claude 唔喺 non-interactive PATH，要用全 path）
ssh orca '~/.nvm/versions/node/v22.22.2/bin/claude plugin marketplace update hugo-personal && ~/.nvm/versions/node/v22.22.2/bin/claude plugin update <plugin>@hugo-personal'
# update 後 prune 舊 cache dir（swarm-server dirs[0] 要求每 plugin 一個 dir）
ssh orca 'ls ~/.claude/plugins/cache/hugo-personal/<plugin>/'
```

（舊 `sync-skills-vps` alias 已退役 — 佢 rsync 嘅 store materialization 路徑已隨 skills consolidation 刪除）

### Update CLAUDE.md (this file)

```bash
nano "/Users/hugo/Documents/Workspace/Claude Code VPS setting/CLAUDE.md"
# Optionally also propagate user-level:
cp "/Users/hugo/Documents/Workspace/Claude Code VPS setting/CLAUDE.md" ~/.claude/CLAUDE.md
# And canonical to GitHub:
cp "/Users/hugo/Documents/Workspace/Claude Code VPS setting/CLAUDE.md" ~/.claude/local-marketplace/docs/INFRASTRUCTURE-MAC.md
cd ~/.claude/local-marketplace && git add docs/ && git commit -m "docs: update infra" && git push
```

---

## 🧷 Decision boundaries (from Hugo's brief)

### 🛑 ALWAYS ASK FIRST
- Anything costing money (API credit, plan upgrade, paid GitHub)
- Reboot VPS (`sudo reboot`)
- Disable security settings (UFW disable, fail2ban stop, SSH password re-enable)
- Modify hPanel subscription
- Clone an unfamiliar repo before getting GitHub URL from Hugo
- Open a new UFW port

### ✅ Auto-approved (just do it)
- SSH read-only commands on VPS
- Modify VPS config files (`~/.bashrc`, `~/.claude/`, `~/.ssh/config`)
- `npm install / uninstall`
- Hostinger MCP read queries (`VPS_get*`, `domains_get*`)
- File edits on VPS via SSH (when Hugo asked for them)
- Plugin install / update / uninstall

### 📋 Style & format
- Reply in **繁體中文 / 廣東話** unless Hugo switches to English
- Concise, scannable (tables, code blocks, bullets)
- Don't ask permission for trivial things; do ask before destructive irreversible actions
- Use standard "Report Back" template at end of multi-step tasks

---

## 🛠️ MCP servers connected

### Local on VPS (registered via `claude mcp add`)
- `telegram` — chigwell/telegram-mcp via wrapper script

### Cloud MCPs (auto-synced from claude.ai)
- Canva, Heygen, Google Calendar, Gmail, Google Drive (needs reauth)

### Mac-side specialty MCPs
- `Hostinger` (VPS lifecycle / firewall / billing API)
- `cantonese-ai` (Cantonese TTS / Jyutping)
- `Claude_in_Chrome` (browser automation)
- `computer-use` (macOS desktop automation)

---

## 🎬 Common one-liners

```bash
# === VPS health checks ===
ssh orca 'bash -ic "pm2 list" && sudo ufw status && df -h'

# === Tail swarm-server logs ===
ssh orca 'bash -ic "pm2 logs swarm-server --lines 30 --nostream"'

# === Reset swarm dashboard state ===
curl -X POST http://187.127.115.235:3010/api/reset

# === Trigger swarm via Claude Code on VPS ===
ssh orca 'cd ~/orca-platform-mvp && claude -p --dangerously-skip-permissions "用校長/老師/科主任/學生/研發者 jam <topic>"'

# === Manual fire dashboard event for testing ===
curl -X POST http://187.127.115.235:3010/events/swarm-start \
  -H "Content-Type: application/json" \
  -d '{"topic":"test","personas":["A","B","C"]}'

# === ORCA backend (start manually) ===
ssh orca 'cd ~/orca-platform-mvp/apps/mvp-web/backend && nohup bash -ic "uv run uvicorn app.main:app --host 0.0.0.0 --port 8000" > /tmp/backend.log 2>&1 &'
```

---

## 📜 Recent work history (May 2026)

What's been built so far:

1. **VPS hardening** — SSH key only, UFW 22, fail2ban, sudo NOPASSWD, hostname, timezone HK
2. **Toolchain** — Node 22 (NVM), bun, Rust, uv, git, tmux, htop, jq
3. **Claude Code (Max) auth** — `claude auth login --claudeai`, paste-back OAuth flow
4. **Codex CLI (ChatGPT Plus) auth** — `--device-auth` flow
5. **GLM 5.1 placeholder** — `glm()` shell function in `~/.bashrc`, awaiting BigModel API key
6. **ORCA repo cloned** — `~/orca-platform-mvp/` = LIVE，on `Production` branch（原 `feature/mvp-sprint`）；test 區喺獨立 worktree `~/orca-staging`（`staging` branch）。詳見上面 § ORCA project「Branch / 部署佈局」
7. **Cronicle installed** — `/opt/cronicle/`, systemd, port 3012, admin password Hugo set
8. **CloudCLI installed** — npm pkg `@cloudcli-ai/cloudcli@0.40.1`, PM2-managed, port 3001
9. **Telegram MCP** — chigwell/telegram-mcp via uvx wrapper, Telethon session string in `~/.telegram_secrets`
10. **Plugin marketplace** — `hugo-personal` GitHub repo with 6 plugins (super-personas / design / ai-prompts / marketing / swarm-tools / mattpocock-skills)
11. **17 standalone skills synced** — anthropic-skills + data:* via rsync
12. **Swarm Dashboard V3** — Node + Express + Socket.io, 6-layer pipeline (研究→協作→博弈→決策→交付→覆核), domain detection (education/product/general), execution agents spawn real CLI processes, 3 themes (Light/Cozy/Dark)
13. **CloudCLI custom UI** — `cloudcli-hugo-themes.js/.css` 直接覆蓋 dist（取代舊 Tampermonkey 方案），含 theme switcher + Swarm 側面板 + MiroFish 按鈕
14. **MiroFish 部署** — Vue 3 + Flask 群體智能引擎，前端 serve 經 swarm-server `/mirofish/`，後端 PM2 managed at port 5001 (localhost only)
15. **Agent Swarm skill 注入** — 12 個 skill 從 plugin cache + standalone skills 自動載入，按 agent 角色注入 prompt（frontend→design, backend→architect+debugger, reviewer→security-auditor, thinking→brainstormers）
16. **Skills consolidation（2026-07-12）** — 全面 audit 55+ skills：Desktop store 31 個 user skills 清理到剩 4 個高價值（humanizer / meta-ads-decision / panorama-carousel / geo-game-prompt-builder），12 個遷入 marketplace 新 plugin（workflow-tools / media-tools / data-tools）+ design/swarm-tools 擴充，13 個同 plugin/built-in 重複嘅淘汰；multi-persona-jam 重構（413→119 行，emit-event.sh + references/，SWARM_DASHBOARD_URL env）；swarm-server SKILL_REGISTRY 全 plugin 化（13/13）；兩部機 `~/.claude/skills/` 清空；`sync-skills-vps` alias 退役；backup 喺 `~/Documents/Workspace/Claude Skills Update/store-backup-20260712/`

---

## 🐾 Last updated

2026-08-03（裝官方 mattpocock/skills plugin 兩部機 + 新增 🥇 預設 coding flow 章節：問清需求→spec→tickets→小步實作測試→review→handoff；uninstall 舊 smll-ai 版）。上一次：2026-07-13 (Swarm Mission review + Workbench)。If knowledge here drifts from reality, **edit this file** and propagate to user-level + GitHub canonical (see `Update CLAUDE.md` section above).
