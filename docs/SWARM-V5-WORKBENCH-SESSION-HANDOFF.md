# Swarm V5 Multi-runtime Workbench — Session Handoff

> 更新：2026-07-22（Asia/Hong_Kong）
> 狀態：完成架構評估及 backlog；**今個 session 冇修改或部署 Swarm V5 程式**。
> 完整 backlog：`docs/SWARM-V5-WORKBENCH-MASTER-BACKLOG.md`

## 1. 兩分鐘接手摘要

目標係將現有 Swarm V5 左邊普通 AI Chat 升級成真正 multi-runtime Workbench，右邊繼續用 Agent Office 顯示 Claude、Codex、Kimi 及其真實 subagents／background jobs。

已拍板方向：

1. **唔推倒 V5 重做。** 保留現有 Harness、worktree、驗證、審批、budget、audit、Agent Office。
2. **唔 iframe VS Code Claude Code extension。** Extension webview 依賴 VS Code host/API/CSP，唔係普通網頁。
3. Claude 預設先做 **真正 Claude Code CLI + persistent PTY + xterm.js**，保留熟悉 TUI、Claude Max login、`/goal`、`/loop`、plugins、skills、hooks。
4. **Claude Agent SDK 係可選 structured runtime，唔係預設。** 官方路線主要用 API key；第三方未經批准唔應提供 Claude.ai subscription login/rate limits，而且 SDK 產品唔應冒充或模仿 Claude Code branding。
5. Codex 長線直接接 **Codex app-server**；短線先利用官方 `openai/codex-plugin-cc`，令 Claude 可以 background delegate、review、rescue、status/result/cancel、transfer session。
6. Kimi 由「前端建議者」升級成一級 runtime，支援 streaming、session、cancel、usage、worktree、Agent Office events。
7. Pipeline／Harness 應包裝成 **Plugin**；Skill 只係策略，MCP／hooks／monitors／Harness 先係執行及守門層。
8. 自動跟進由 **Swarm/Cronicle** 做 durable scheduler；Claude 原生 `/loop`、`/goal` 可保留，但唔可以成為唯一可靠鬧鐘。
9. Parallel orchestration 要有 task DAG、dispatch ID、worker completion、heartbeat、decision gate、worktree ownership、retry/circuit breaker。
10. `stablyai/orca` 高度相關，最值得借鏡 task/dispatch schema、scheduled automations、persistent PTY、agent hooks、worktree safety；暫時唔建議 fork 成個 Electron app。

## 2. 已核實現況

### GitHub source-of-truth

- Repo：`https://github.com/polarislt0710/claude-skills-hugo`
- 呢份 handoff branch：`agent/swarm-v5-workbench-handoff`
- 本機 checkout：`/Users/hugong/.claude/local-marketplace/`
- 舊 project note 曾寫成 `Codex-skills-hugo`；實際 remote 已核實係 `claude-skills-hugo`。

### VPS

- SSH：`ssh orca`
- V5 deployed source：`/home/hugo-orca/services/swarm-mission-v5/`
- V5 本機 listener：`127.0.0.1:3013`，經既有 authenticated gateway 暴露。
- Cronicle 已存在，systemd 管理，現時 port 3012。
- 任何新 UFW port、VPS reboot、付費 API／plan 都要先問 Hugo。

### V5 已有能力（唔好重做）

- Discussion／Chat／Plan、Plan approval、Pause／Resume／Stop。
- Scout → Plan → Execute → Review → Verify → Report Harness。
- Task DAG／waves、每 task Git worktree、merge及衝突保留。
- Claude CLI runner、Claude session ID／`--resume`。
- Codex CLI cross-review、Kimi provider／frontend advice。
- Verify commands、fix rounds、JSON contracts、budgets、audit、permission profiles。
- Agent Office／work cards／Socket.IO、Telegram notification、unit/E2E tests。

重要現況：現有 chat path 多數係每回合 `claude -p` 完成後 process exit；因此 Claude session-scoped `/loop` 唔會單靠現有 runner 長期留低等喚醒。要 persistent PTY，或者由 Swarm scheduler 到時用 session ID resume。

## 3. 建議目標架構

```text
Swarm Workbench UI
├── Claude Code Terminal renderer（預設；xterm.js）
├── Claude Agent renderer（可選；Agent SDK/API）
├── Codex renderer（app-server）
├── Kimi renderer（API/CLI adapter）
└── Plan / Diff / Artifacts / Logs
             │
             ▼
Swarm Control Plane / Harness Plugin
├── Task DAG + Dispatch + Heartbeat + Decision Gate
├── Worktree Manager + Verify + Merge Queue
├── Event Bus + Audit + Budget + Approval
├── schedule_followup + Cronicle + worker_done wakeup
└── Unified Runtime Event Schema
             │
             ▼
Agent Office（只顯示真實 runtime events）
```

### Plugin 分層

```text
swarm-harness/
├── shared-core/
├── claude-plugin/
│   ├── .claude-plugin/plugin.json
│   ├── skills/ agents/ hooks/ monitors/
│   └── .mcp.json
└── codex-plugin/
    ├── .codex-plugin/plugin.json
    ├── skills/ hooks/
    └── .mcp.json
```

唔好將所有邏輯寫入 `SKILL.md`：

- Skill：何時分工、review、reschedule、stop。
- MCP／Harness：建立任務、dispatch、鎖、驗證、狀態轉移。
- Hooks：audit、安全、completion gate。
- Cronicle／scheduler：真正時間喚醒。

## 4. 建議實作順序

### Phase A — 首個可日常使用版本（估計 5–8 工作日）

1. 將現有 pipeline 抽成可版本化 Plugin/Harness contract。
2. 加 Claude Code native terminal：xterm.js、persistent PTY、reconnect、scrollback、safe cancel。
3. VPS Claude 安裝／驗證 `openai/codex-plugin-cc`。
4. 將 Claude/Codex background job 狀態送入 Agent Office。
5. 加 `schedule_followup`、worker completion wakeup、Cronicle watchdog。
6. 將 session／wake job 持久化並支援 server restart reconcile。

### Phase B — 真正 multi-runtime（再 8–12 工作日）

1. Unified runtime event schema。
2. Codex app-server adapter。
3. Kimi first-class adapter。
4. SQLite WAL orchestration store。
5. Task／dispatch／heartbeat／decision gate／inbox。
6. Parallel worktrees、merge queue、model race。
7. Workbench Diff／Plan／Artifacts UI。

### Phase C — Production hardening（再 5–8 工作日）

1. Crash/reboot/auth-expiry/missed-wake recovery。
2. Concurrency、token/cost、deadline、circuit breaker。
3. Security、terminal sanitization、permission regression tests。
4. Full E2E、feature flag、fallback、notifications、rollout。

完整 production-ready 粗估 18–25 工作日；唔應將呢個估計理解成單一大爆炸 rewrite。

## 5. 下一個 AI 必讀 reference

按需要逐步讀，唔好一次過塞晒 context：

1. **先完整讀本檔**：`docs/SWARM-V5-WORKBENCH-SESSION-HANDOFF.md`
2. 要做設計／拆 issue 先讀：`docs/SWARM-V5-WORKBENCH-MASTER-BACKLOG.md`
3. 核對 Mac/VPS 現況：
   - `docs/INFRASTRUCTURE-MAC.md`
   - `docs/INFRASTRUCTURE-VPS.md`
4. 核對真正 V5 code，唔好只信 handoff：
   - `ssh orca 'cd /home/hugo-orca/services/swarm-mission-v5 && git status 2>/dev/null || true'`
   - 讀 `README.md`、`DESIGN.md`、`server.js`、`lib/agent-runner.js`、`lib/engine.js`、`lib/execution-coordinator.js`、`lib/discussion-store.js`、`lib/mission-worktree.js`、`routes/discussions.js`。
5. 外部參考：
   - Claude Agent SDK：`https://code.claude.com/docs/en/agent-sdk/overview`
   - Claude plugins：`https://code.claude.com/docs/en/plugins`
   - Claude scheduled tasks：`https://code.claude.com/docs/en/scheduled-tasks`
   - Claude goals：`https://code.claude.com/docs/en/goal`
   - Codex app-server：`https://learn.chatgpt.com/docs/app-server`
   - Codex plugins：`https://learn.chatgpt.com/docs/build-plugins`
   - Official bridge：`https://github.com/openai/codex-plugin-cc`
   - Orca repo：`https://github.com/stablyai/orca`
   - Orca orchestration：`https://www.onorca.dev/docs/cli/orchestration`
   - Orca scheduled automations：`https://www.onorca.dev/docs/cli/automations`
   - Orca worktrees：`https://www.onorca.dev/docs/model/worktrees`
   - Orca headless VPS：`https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md`

## 6. Orca 判斷

可以借／參考：

- SQLite task/message/dispatch/decision-gate schema。
- `worker_done` 必須帶 taskId + dispatchId 嘅 authority contract。
- Heartbeat、hung detection、retry、stale completion rejection。
- Automation：RRULE、missed-run grace、precheck、reuse session、run snapshots。
- Persistent PTY daemon、xterm.js、agent OSC/hooks、session restore。
- Worktree create/delete safety、Agents feed、headless deployment pattern。

唔建議直接做：

- Fork 成個 Electron UI。
- 依賴仍屬 Experimental 嘅 internal orchestration protocol 作唯一 production core。
- 照抄 Orca full-autonomy dangerous flags。
- 未經批准安裝 sidecar、開新 port 或改 firewall。

如要驗證 sidecar，先做 1–2 日 localhost-only spike，再決定係「Orca runtime sidecar」定「只抽取設計模式」。

## 7. 下一個 AI 嘅工作守則

1. 先做 drift check；呢份 log 係 2026-07-22 snapshot，唔係永遠 truth。
2. 保留 V5 現有 Harness；除非有證據，唔好另起新 engine。
3. 唔好將 Skill 當 scheduler、database 或安全邊界。
4. Agent Office 只可以顯示真實 events；資料不足就 `unknown`。
5. 預設唔好用 Agent SDK 取代 Claude Max/CLI 路線。
6. 唔好 iframe VS Code plugin；需要熟悉介面就做 native CLI PTY。
7. 唔好同時實作所有 adapters；先完成一條垂直 slice：Claude PTY → event → Agent Office → wake/review。
8. 改 VPS 前先讀 project `AGENTS.md`；付費、reboot、security disable、新 UFW port 必須問 Hugo。
9. 唔可以顯示或提交 tokens、passwords、API keys、credentials。
10. 每一步要有 tests、rollback/fallback，同埋清楚 report back。

## 8. 可直接貼俾下一個 AI 嘅 Prompt

```text
Resume the Swarm V5 Multi-runtime Workbench project.

GitHub repo:
https://github.com/polarislt0710/claude-skills-hugo

Branch:
agent/swarm-v5-workbench-handoff

First, read this file completely:
docs/SWARM-V5-WORKBENCH-SESSION-HANDOFF.md

Then read only the relevant sections of:
docs/SWARM-V5-WORKBENCH-MASTER-BACKLOG.md

Before proposing or changing anything, verify drift against:
- docs/INFRASTRUCTURE-MAC.md
- docs/INFRASTRUCTURE-VPS.md
- the deployed VPS source at /home/hugo-orca/services/swarm-mission-v5 (via ssh orca)

Important decisions already made:
- Do not rewrite Swarm V5; preserve its Harness, worktrees, verification, approvals and Agent Office.
- Do not iframe the VS Code Claude Code extension.
- Default Claude experience should be the real Claude Code CLI through persistent PTY + xterm.js.
- Claude Agent SDK is optional, not the default.
- Use openai/codex-plugin-cc as the short-term Claude→Codex bridge; direct Codex app-server is the long-term first-class integration.
- Scheduling must be durable at Swarm/Cronicle level, with worker completion events plus a timed watchdog.
- Agent Office must only show real runtime events.

For your first response, do not start a broad rewrite. Report:
1. what has changed since the handoff,
2. which existing V5 modules can be reused,
3. the smallest end-to-end Phase A vertical slice,
4. exact files/services it would touch,
5. tests and rollback plan.

Then wait for Hugo to confirm the implementation slice if the requested scope is still ambiguous. Follow the project AGENTS.md and never expose secrets.
```
