# Swarm V5 Multi-runtime Workbench — Master Backlog

> 呢份文件保留並整理 2026-07-22 架構 session 嘅完整回應。下一個 AI 應先讀 `SWARM-V5-WORKBENCH-SESSION-HANDOFF.md`；只有要規劃／實作相關部分先讀本檔，減少 context。

## 核心結論

唔需要推倒 Swarm V5 重做。保留現有 Harness、Worktree、驗證、審批、Agent Office；主要重構四層：

1. Workbench UI
2. Runtime adapters
3. 持久排程
4. 真實 Agent events

今次只完成盤點同評估，未建立 Plugin，亦未修改／部署 Swarm V5。

## 一、V5 已經有，唔使重做

已核對 VPS `/home/hugo-orca/services/swarm-mission-v5`，現時有：

- Discussion／Chat／Plan 模式
- Plan approval
- Pause／Resume／Stop
- Scout → Plan → Execute → Review → Verify → Report Harness
- Task DAG／wave execution
- 每個 coding task 獨立 Git worktree
- Claude CLI runner
- Claude session ID 及 `--resume`
- Codex CLI cross-review
- Kimi provider，前端任務可先由 Kimi提建議
- 驗證命令、修正回合、JSON contract
- Agent Office、work cards、Socket.IO 即時更新
- Authentication、audit、budgets、permission profile
- Telegram 通知
- Unit／E2E tests

所以今次係將 V5 引擎升級成真正 Multi-runtime Workbench，而唔係另起 V6。

## 二、完整改動清單

### 1. Pipeline／Harness 包裝成 Plugin

既然唔止係 prompt，而係有 Harness、工具、hooks、agents、scheduler，應該做成 Plugin；Skill 只係其中一部分。

| 部件 | 功能 |
|---|---|
| Plugin | 完整安裝包 |
| Pipeline Skill | 教 AI 點分工、驗收、review、停止 |
| Harness | 執行狀態機、測試、budget、worktree |
| MCP tools | 俾 Claude／Codex 操作 Swarm |
| Hooks | Audit、安全規則、completion gate |
| Monitors | 監察 agents、build、logs、CI |

Plugin 應包含：

- `swarm-pipeline`
- `swarm-review`
- `swarm-rescue`
- `swarm-status`
- `swarm-schedule`
- Project Lead／Backend／Frontend／QA／Reviewer agent definitions
- MCP server
- Hooks
- Background monitors
- 共用 JSON schemas
- Mac→VPS 安裝、更新、sync 流程

建議兩個發佈入口：

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

參考：[Claude Plugin](https://code.claude.com/docs/en/plugins)、[Codex Plugin](https://learn.chatgpt.com/docs/build-plugins)。

### 2. 左邊 AI Chat 改成 Workbench

Workbench 外殼共用，每個 runtime 用合適 renderer：

```text
[ Claude Code Terminal ▼ ]
[ Claude Agent          ]
[ Codex                 ]
[ Kimi                  ]
```

Workbench 要有：

- Runtime／model／effort 選擇
- Plan／Build／Review／Debug 模式
- Permission 狀態
- Tool-call cards
- File changes／diff
- Plan approval
- Ask User Question
- Terminal output
- Agent/subagent status
- Token／cost／時間
- 圖片、附件、拖放檔案
- Cancel／Pause／Resume
- Scheduled follow-ups
- Chat／Terminal／Diff／Plan／Artifacts tabs

明確唔做：

- 將 VS Code Claude Code extension 原封不動 iframe。
- 為 iframe 而裝完整 browser VS Code／code-server。
- 模仿假 Claude Code 畫面。

VS Code extension webview 依賴 host、message bridge、CSP、VS Code API，唔係普通網頁。

### 3. 真正 Claude Code Terminal 模式

建議成為 Claude 預設：

```text
Browser xterm.js
       ↕ WebSocket
Swarm PTY daemon
       ↕
真正 claude CLI
```

優點：

- 真正 Claude Code TUI
- 保留 Claude Max／Claude Code login
- `/goal`、`/loop`、`/permissions`、`/agents`
- Plugins／Skills／Hooks
- 原生 keyboard workflow

要新增：

- xterm.js frontend
- Persistent PTY manager
- Terminal session ID
- Scrollback persistence
- WebSocket reconnect
- Browser 關閉後 process 繼續
- Crash/restart detection
- Claude OSC title／hooks 解析
- Session resume
- Input queue、resize、safe cancellation

參考：[Orca Terminal](https://www.onorca.dev/docs/terminal)、[Orca Session Restore](https://www.onorca.dev/docs/model/session-restore)。

### 4. Claude Agent SDK Adapter

列入 backlog，但唔建議做預設。可提供：

- Structured streaming
- Tool events
- Approvals
- Hooks
- Sessions
- MCP
- Subagents／`parent_tool_use_id`
- Usage／cost
- Structured output

限制：

1. 官方路線主要使用 API key billing；未經批准，第三方產品唔應提供 Claude.ai login／subscription rate limits。
2. SDK 產品應叫 Claude Agent，唔應冒充或模仿 Claude Code branding。

因此：

- `Claude Code Terminal`：預設，保留 Max subscription 及熟悉 UI。
- `Claude Agent`：可選 structured/API runtime。

參考：[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)。

### 5. Codex app-server 正式接入

建立長期運行 adapter：

- `initialize`
- `thread/start`、`thread/resume`
- `turn/start`、`turn/steer`、`turn/interrupt`
- Streaming items
- Tool calls
- File changes
- Plans／approvals／goals
- Subagents
- Usage
- Error／completion events

所有事件轉換成 Swarm 共用格式，顯示落 Workbench 同 Agent Office。

參考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)。

### 6. 先利用 `openai/codex-plugin-cc`

官方 Plugin 已提供：

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:rescue`
- Background jobs
- `/codex:status`、`/codex:result`、`/codex:cancel`
- Claude→Codex session transfer
- Codex review Stop gate

分階段：

1. 先裝入 VPS Claude Code，快速 background delegation。
2. Agent Office 接收 job ID、status、result、Codex session ID。
3. 後期先將 app-server 變成 Workbench 一級 runtime。

參考：[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)。

### 7. Kimi 變成一級 Runtime

- Kimi API／CLI adapter
- Streaming
- Session continuity
- Cancel／retry
- Usage／cost
- Structured tool/result schema
- 獨立 worktree
- Agent Office status
- Screenshot／design context
- Kimi 建議 → Codex／Claude 落手嘅 handoff contract

建議預設角色：

```text
Kimi：Frontend／UX／visual implementation
Claude：Project Lead／complex implementation
Codex：Review／rescue／alternative implementation
```

### 8. Parallel Agent Orchestration

支援四種模式：

1. Independent DAG：無依賴嘅 backend、frontend、tests 同時跑。
2. Specialist Team：Claude Lead 分配 Backend、Kimi Frontend、Codex Reviewer。
3. Model Race：同一問題分俾多個模型，各自 worktree，再揀最好。
4. Builder + Reviewer：一個寫、一個即時 adversarial review。

資料模型：Mission、Task、Dependency、Agent、Dispatch、Provider session、Worktree、Heartbeat、Decision gate、Result、Artifact、Retry attempt。

每次 dispatch 必須有獨立 `dispatchId`，避免舊 agent 遲到 completion 錯誤完成新任務。

### 9. Agent Office 顯示真實 Agents

顯示：

- Parent／child 關係
- Claude／Codex／Kimi、role、task、worktree／branch
- Running／Thinking／Tool use
- Waiting approval／Waiting user／Blocked
- Reviewing／Scheduled／Sleeping／Completed／Failed
- Current action／last message
- Token／cost／duration
- 下次喚醒時間／Unread state

操作：打開 terminal/thread、log、diff、artifacts；send follow-up；pause/cancel；reassign；open worktree。

原則：冇真實 event 就顯示 `unknown`，唔可以估計或製造假進度。

### 10. 自我排程／稍後 Review

新增 Swarm-level tool：

```text
schedule_followup({
  missionId,
  taskId,
  provider,
  sessionId,
  wakeAt,
  prompt,
  maxRuns,
  deadline
})
```

流程：

```text
Agent 完成事件 ───────────────┐
                              ├→ 喚醒 Claude Lead
30 分鐘 watchdog／Cronicle ───┘
                                      ↓
                          review → test → fix → report
```

需要：persistent wake jobs、Cronicle、event-driven wake、Claude resume、Codex thread resume、Kimi recall、missed-run recovery、防重入 lock、max runs、deadline、budget、notifications、Office scheduled status。

Claude `/loop`、`/goal` 可喺 Terminal mode 使用，但 Swarm/Cronicle 仍係可靠主鬧鐘。

### 11. Worktree／合併強化

- 每 dispatch 獨立 worktree
- Base commit、branch ownership
- 同檔案衝突預警
- Merge queue
- Safe delete precheck
- 未 merge branch 保留
- Retry 使用新 dispatch context
- Model race compare／choose／merge
- Cleanup policy
- Artifact／diff snapshot

### 12. State／Database 升級

多 agent、高頻 heartbeat、scheduler、concurrent dispatch 建議使用 SQLite WAL；JSON／Markdown 繼續做人類可讀 artifacts。

建議 tables：

- `missions`
- `tasks`
- `agents`
- `dispatches`
- `messages`
- `decision_gates`
- `wake_jobs`
- `provider_sessions`
- `artifacts`
- `events`
- `automation_runs`

### 13. 安全及批准

- Provider auth 隔離
- Secrets 唔入 prompt/log
- Read／write／network／deploy 分層
- Plan／push／deploy／destructive approval
- 每 agent worktree sandbox
- Max concurrency／runtime／token／cost
- Kill switch
- Stale heartbeat timeout
- Circuit breaker
- Audit
- Terminal escape sanitization

唔應照抄 Orca 預設 full-autonomy dangerous flags；V5 現有 permission profile 更適合。

### 14. Testing／部署／Rollout

必測：

- PTY reconnect、browser close、VPS/PM2 restart
- Claude session resume、Codex thread resume、Kimi retry
- Completion event、stale dispatch、missed/duplicate wake
- Worktree conflict、merge failure
- Auth expiry、agent crash、cancel、budget breach
- Agent Office event correctness

部署：

- 新 `/v5-workbench` feature flag
- 舊 V5 UI保留 fallback
- 先 localhost／authenticated gateway
- 未驗收唔 cutover
- PM2／systemd health check
- Cronicle watchdog

## 三、`stablyai/orca` 評估

[stablyai/orca](https://github.com/stablyai/orca) 係 Claude Code／Codex／Kimi 等 CLI agent orchestrator，具備 parallel worktrees、persistent PTYs、SSH remote agents、agent status、session restore、scheduled automations、task/dispatch/heartbeat/decision gates、notifications、Agents feed、headless VPS server。

Repo 係 MIT license；重用實質代碼時要保留 copyright／license notice。

| Orca 部分 | 對 Swarm 價值 | 建議 |
|---|---|---|
| Orchestration DB schema | 極高 | 借鑑／抽取 |
| Task、dispatch、worker_done | 極高 | 直接參考 |
| Heartbeat／decision gate | 極高 | 直接參考 |
| Scheduled automation schema | 極高 | 參考實作 |
| Worktree safety | 高 | 參考 |
| Agent hooks／OSC detection | 高 | 抽取概念或代碼 |
| Persistent PTY daemon | 高 | 參考架構 |
| xterm.js UI | 高 | 採用相同技術 |
| Headless `orca serve` | 中高 | Sidecar POC |
| Electron UI 全部搬入 Swarm | 低 | 唔建議 |
| Fork 成個 Orca | 低 | 維護成本太高 |

重點參考：

- [Orchestration](https://www.onorca.dev/docs/cli/orchestration)
- [Scheduled Automations](https://www.onorca.dev/docs/cli/automations)
- [Parallel Worktrees](https://www.onorca.dev/docs/model/worktrees)
- [Headless Linux guide](https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md)

Sidecar 可能架構：

```text
Swarm UI + Agent Office
          │
          ▼
Swarm Harness Plugin
          │
          ▼
Orca headless runtime
   ├── Claude terminal
   ├── Codex terminal
   ├── Kimi terminal
   ├── Worktrees
   └── Automations
```

風險：orchestration 仍標示 Experimental；AppImage＋Electron＋Xvfb 較重；internal protocol 可能變；Agent Office adapter 仍要自己寫；新 UFW port 必須先問；淨裝 Orca skill 而冇 runtime 冇作用。

建議只做 1–2 日 localhost-only sidecar spike，暫時唔將 Swarm 綁死落 Orca。

## 四、建議時程

### Phase A：5–8 工作日

1. Harness 抽成 Plugin
2. Claude Code native terminal／PTY
3. 安裝 `codex-plugin-cc`
4. Office 顯示 Claude＋Codex jobs
5. `schedule_followup`
6. Cronicle wakeup
7. Persistent session／scrollback

### Phase B：再 8–12 工作日

1. Unified event schema
2. Codex app-server
3. Kimi first-class adapter
4. SQLite orchestration
5. Task／dispatch／heartbeat／decision gates
6. Parallel worktrees
7. Diff／plan／artifacts UI

### Phase C：再 5–8 工作日

1. Crash／restart recovery
2. Missed schedule recovery
3. Security／budget／concurrency
4. Full E2E
5. Notifications
6. Rollout／fallback

完整 production-ready 粗估 18–25 工作日；第一個日常可用版本約 5–8 工作日。

最終建議：Claude 預設先做真正 CLI／PTY Workbench，而唔係先做 Agent SDK，最符合「熟悉 Claude Code UI、保留原生能力、可以自己排任務」三個核心要求。
