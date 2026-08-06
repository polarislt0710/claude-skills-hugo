# codex-watchdog

Codex 背景 job 嘅**監看＋自動恢復** wrapper plugin。唔 fork、唔 patch 官方 `openai-codex` plugin，
只係讀（同修正）佢寫低嘅 job state。

## 係乜

四個子命令（純 Node ≥22，零 npm 依賴）：

| 命令 | 做乜 |
| --- | --- |
| `check` | 一次過分類 workspace 內所有 job 嘅**真實**狀態：`running` / `stalled` / `dead` / `timed-out` / 終態，附判斷依據（pid 生死、log mtime、elapsed、用咗邊條門檻） |
| `watch` | 長行監看單一 job（或成個 workspace），每 30 秒 poll；一有變化就出一個 JSON 事件並退出 — 設計係畀 Claude 用 background Bash 行，退出時自動喚醒 Claude |
| `reap` | 將確認死咗嘅 job 喺 state 度標記返 `failed`，errorMessage 註明係 watchdog 收屍。只改 status 欄位，**唔刪 log** |
| `doctor` | 環境自檢：搵到邊啲 state dir、format version 啱唔啱、node 版本、殭屍 job 數量 |
| `dispatch --bypass` | **Sandbox escape hatch**（唯一會派工嘅命令）：用 `codex exec --sandbox danger-full-access` 開背景 job。只限官方 plugin 嘅 sandbox 真係擋死咗（要上網／要出 workspace）先用 |

`check` 每個 job 同 `watch` 嘅 `failed`/`stalled`/`dead` 事件都會帶 `sandboxDeny`
（`{suspected, matches:[{line, pattern}]}`）：掃 log 尾 256KB 揾 sandbox 被拒嘅痕跡。
**純 annotation，唔會改 classification** — 係畀 Claude 判斷「今次死係咪畀 sandbox 擋」嘅證據。

另外附一個 `codex-watchdog` skill，教 Claude 全套「派工 → 監看 → 恢復」紀律（恢復上限 2 次、
write 任務 retry 前必須 `git status` + `git diff --stat`、timed-out 唔自動重派、破壞性操作永遠問 Hugo）。

## 點解要有

官方 plugin 派完 job 之後**唔會察覺 worker process 死咗**。process 一冇，job 嘅 status 就永遠釘死喺
`running`，`/codex:status` 照報「行緊」，Claude 就對住一具屍體等到天光。

真實個案：`Claude-Code-VPS-setting` workspace 有兩個 **2026-07-30** 派出去嘅 job（`task-ms7i7ifh`、
`task-ms7i4x4j`），pid 23748 / 22204 一早唔存在、log 停咗喺 7 月 30 號，但到今日官方 status 仍然
列佢哋做 `running`。呢個 plugin 就係為咗令呢種情況即刻被發現、被收屍、被恢復。

## 安裝

Phase 1 本機試用，直接由本地路徑裝：

```bash
claude plugin install /path/to/codex-watchdog
```

Phase 2 收編入 `hugo-personal` marketplace（**要 Hugo 批咗先做**，涉及 push public repo）：

1. 將成個 `codex-watchdog/` 目錄放入 `~/.claude/local-marketplace/local-plugins/codex-watchdog/`
2. 喺 marketplace 嘅 plugin 清單（`.claude-plugin/marketplace.json`）加返 `codex-watchdog` 一項
3. commit + push `~/.claude/local-marketplace`
4. Mac：`claude plugin marketplace update hugo-personal && claude plugin install codex-watchdog@hugo-personal`
5. VPS：`ssh orca '~/.nvm/versions/node/v22.22.2/bin/claude plugin marketplace update hugo-personal && ~/.nvm/versions/node/v22.22.2/bin/claude plugin install codex-watchdog@hugo-personal'`
6. update 之後記得 prune 舊 cache version dir（每個 plugin 只留一個）

前置條件：官方 `codex@openai-codex` plugin 已裝（v1.0.6 驗過），Node ≥ 22。

## 用法

```bash
# 睇晒呢個 workspace 所有 job 嘅真身
node scripts/watchdog.mjs check --json
node scripts/watchdog.mjs check --all              # 連舊終態 job 都出

# 監看（實際用法係 Claude 用 background Bash 行）
node scripts/watchdog.mjs watch task-ms7i7ifh
node scripts/watchdog.mjs watch --poll-ms 10000 --max-wait-ms 600000

# 收屍
node scripts/watchdog.mjs reap --dry-run           # 只報唔改
node scripts/watchdog.mjs reap task-ms7i7ifh

# 自檢
node scripts/watchdog.mjs doctor --json
```

### `dispatch --bypass`（sandbox escape hatch）

```bash
node scripts/watchdog.mjs dispatch --bypass \
  [--model gpt-5.6-sol] [--effort high] [--cwd <dir>] "<prompt>"
# prompt 亦可以由 stdin 入：
echo "<prompt>" | node scripts/watchdog.mjs dispatch --bypass
```

即時出一行 JSON `{jobId, status:"queued", stateDir, logFile, bypass:true}` 就退出，
實際工作喺 detach 咗嘅 worker 度行（`codex exec --sandbox danger-full-access --skip-git-repo-check`，
stdout/stderr 逐行寫入 `[ISO] line` 格式嘅 log，exit 0 → `completed`、非 0 → `failed`）。
job 寫入 watchdog 自己嘅 namespace `~/.claude/plugins/data/codex-watchdog/state/<slug>-<hash>/`，
用返官方 version 1 schema，所以 `check` / `watch` / `reap` 全部照樣搵到佢。

**點解要有**：官方 `openai-codex` plugin 派工時**硬性覆蓋** sandbox（`read-only` 或
`workspace-write`）＋ `approvalPolicy:"never"`，你 `~/.codex/config.toml` 入面嘅 `danger-full-access`
對 plugin 派嘅工**完全冇效**。所以要上網／要出 workspace 嘅工，經官方 plugin 一定靜靜雞死。

**⚠️ 風險聲明**

- `danger-full-access` = **冇 sandbox、冇 approval**。Codex 喺呢個 mode 可以掂到你個 user 掂到嘅任何嘢。
- 淨係喺**有證據**（`sandboxDeny` 嘅 matches）證明 sandbox 係真兇、而且份工真係要網絡／要出 workspace 先用。
  淨係要喺 workspace 入面寫檔 → 用官方 plugin 加 `--write` 就得，唔好用 bypass。
- prompt **必須**寫明 `Do not run destructive commands.` 同埋容許掂邊啲範圍 —— sandbox 冇咗，prompt 就係最後一道閘。
- 紅線唔會因為 bypass 而放鬆：`rm`／force push／碰 production／防火牆／CLAUDE.md 🛑 清單，一律要問 Hugo。
- 冇 `--bypass` 行 `dispatch` 會直接報錯叫你用官方 plugin（`/codex:rescue`）—— 呢個係故意嘅。
- 揾唔到 PATH 上面嘅 `codex` binary 會即刻 fail loud，唔會靜靜咁降級。

Slash commands：`/codex-watchdog:status`（= check）、`/codex-watchdog:watch`、`/codex-watchdog:reap`。

共通 flag：`--cwd <dir>` 指定 workspace、`--state-dir <path>` 直接指定官方 state 目錄（跳過自動推算）、
`--json` 出機讀 JSON。**stdout 只出 JSON（機讀），人讀嘅嘢一律落 stderr。**

## Config 檔

`~/.codex-watchdog.json`，優先序：**CLI flags > config 檔 > defaults**。

```json
{
  "pollMs": 30000,
  "stallMinutes": {
    "low": 5,
    "medium": 5,
    "high": 10,
    "xhigh": 20,
    "default": 10
  },
  "hardTimeoutMinutes": 60,
  "allowBypassDispatch": true
}
```

- `pollMs` — `watch` 每次 poll 相隔幾耐
- `stallMinutes` — log 幾耐冇郁就當 `stalled`，按 job 嘅 effort 分層；job 冇 effort 資料用 `default`
- `hardTimeoutMinutes` — 硬超時，超過就算 log 仲郁都當 `timed-out`
- `allowBypassDispatch` — boolean，default `true`。設成 `false` 之後 `dispatch --bypass` 直接報錯退出，
  成條 escape hatch 封死

## 邊界

唔 fork／唔 patch 官方 plugin、唔自動批破壞性操作、唔起 web UI、
唔監看 interactive `codex` CLI session。官方 state format 一旦改 version，watchdog 會**即刻報錯退出**，
唔會靜默亂改。
