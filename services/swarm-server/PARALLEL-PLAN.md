# Mission V3 — 真並行升級 PLAN（worktree 隔離）

> 狀態：施工中。Feature-flagged，預設 OFF = 行為 100% 等同現狀。
> 目標：sub-phase 由「per-project lock 順序」升級成「dependency 波次 + git worktree 隔離真並行」。

---

## 0. 點解而家係順序（核心約束）

- `routes/mission.js:657` `acquireProjectLock(targetProject)` — **per-project mutex**，同一 repo 一次一個 mission。
- Batch planner prompt 明寫：`execution will still be serial`（`mission-batches.js:294`）。
- 物理原因：所有 sub-phase 共用同一個 git working tree（`targetProject`）。多 agent 同時改 → `.git/index.lock` 撞、`startCommit..HEAD` diff 計錯、互相覆蓋。

**真並行 = 必須打破「共用 working tree」= 每個並行單位一個 git worktree。**

---

## 1. 架構

```
runExecutionAndSummary
  ├─ MISSION_PARALLEL 未開 → 現有順序 for loop（不變）
  └─ MISSION_PARALLEL 開 →
       waves = planWaves(subPhases)              // 拓樸排序 + 分波
       for each wave (barrier between waves):
         await Promise.all(wave.map(sp =>        // cap MISSION_PARALLEL_MAX (預設 3)
           worktree = createWorktree(baseCommit, branch)
           runSubPhase(ctx, sp, { workdir: worktree.dir })   // coding→review→fix 不變
         ))
         for each sp in wave: mergeWorktree(branch) → removeWorktree()   // 序列 merge 返主 branch
         baseCommit = 新 HEAD                     // 下一波 build on top
```

### 1.1 Feature flags（env）
| Flag | 預設 | 作用 |
|---|---|---|
| `MISSION_PARALLEL` | `0`（OFF）| 開並行路徑。OFF = 現狀 |
| `MISSION_PARALLEL_MAX` | `3` | 每波最大並行數（VPS 8GB RAM 上限，防 OOM）|
| `MISSION_PARALLEL_MERGE` | `auto` | `auto`=clean 就 merge；conflict→該 sub-phase 降級順序重跑 |

### 1.2 Wave planner（`lib/mission-wave-planner.js`，純函數）
- 輸入：subPhases（`.id` / `.dependencies[]` / 可選 `.estFiles[]`）。
- 拓樸排序：Kahn's algorithm。**循環依賴 → throw**（mission error，唔好死跑）。
- 分波規則：一個 sub-phase 入到某 wave ⟺ 所有 deps 已喺前面 wave 完成 **且** 同 wave 內冇 file collision **且** wave 未滿 cap。
- 輸出：`{ waves: [[sp...],...], order, warnings }`。

### 1.3 Collision 策略（雙保險）— 因為 `est_files_touched` 只係數字
1. **Plan-time（eager，best-effort）**：增強 planner prompt，**額外**輸出 optional `est_files`（檔案路徑陣列）。有 → wave-planner 做 file overlap 偵測，撞 file 嘅 sub-phase 強制唔同波次。
2. **Merge-time（lazy，safety net）**：worktree merge 若 conflict → abort merge，該 sub-phase 標記 `needs_serial`，喺後續波次順序 rebuild。**呢個係兜底，就算 planner 漏報 collision 都唔會爆。**

### 1.4 Worktree manager（`lib/mission-worktree.js`）
- `createWorktree(repo, baseCommit, branch, dir)` → `git worktree add -b <branch> <dir> <baseCommit>`。
- `mergeWorktree(repo, branch)` → `git merge --no-ff <branch>`；conflict → `git merge --abort` + return `{ ok:false, conflict:true }`。
- `removeWorktree(repo, dir, branch)` → `git worktree remove --force` + `git branch -D`。
- 防呆：清 stale worktree、index.lock。

### 1.5 State 安全（並行模式）
- `saveState` 包一層**寫入序列化**（簡單 in-process queue / dirty flag），避免並行交錯。
- `resumeCheckpoint` / `currentSubPhaseIdx` 係**單值** → 並行模式改用 **per-subPhase 狀態**（`subPhase.status` / `subPhase.iterations` 已 per-phase，足夠）。Mission-level checkpoint 只記「波次進度」。

### 1.6 Resume multi-cursor
- `findResumeCheckpoint` flag-off 不變。flag-on：搵未完成（非 pass/warn）嘅 sub-phase，按 wave 重建，重開未完波次。

---

## 2. 檔案改動清單

| 檔案 | 改動 | 風險 |
|---|---|---|
| `lib/mission-wave-planner.js` | **新增**（純函數）| 零（唔碰執行）|
| `lib/mission-worktree.js` | **新增** | 零（唔碰執行）|
| `lib/mission-orchestrator.js` | `runInnerPhase`/`runAgentWithObserver` 接 `workdir`；`runExecutionAndSummary` 加 flag 分支；`runSubPhase` 接 workdir | 中（flag-gated）|
| `routes/mission.js` | （可選）batch queue 並行；暫不動 | — |
| `prompts/mission-planner-system.md` | 加 optional `est_files` 欄位 | 低（additive）|
| `public/mission/app.js` + `index.html` | batch analysis 顯示波次/依賴 | 零（前端）|

---

## 3. 向後兼容鐵律
- `MISSION_PARALLEL` 未開時，**所有 code path 與現狀逐行等同**。
- `workdir` 參數預設 `= mission.targetProject`。
- 新模組純新增，唔 import 入現有順序路徑。

---

## 4. 測試計劃
1. **Mac 單元測試**：`mission-wave-planner` — 線性鏈 / 鑽石依賴 / 循環(throw) / collision 分波 / cap 截斷。
2. **Mac throwaway repo**：`mission-worktree` — create→commit→merge→cleanup；conflict→abort。
3. **VPS regression**：flag OFF 跑一個現有 mission，確認行為不變。
4. **VPS 並行**：`MISSION_PARALLEL=1` 跑一個有 2-3 條獨立 sub-phase 嘅 mission，驗 worktree 隔離 + merge + RAM 唔爆（`MISSION_PARALLEL_MAX=3`）。

---

## 5. 分階段 rollout
- **Stage A（今）**：PLAN + wave-planner + worktree manager + 單元測試（全部 Mac 自測，零 production 風險）。
- **Stage B**：orchestrator 接 workdir + flag 分支 + state 序列化 + resume。
- **Stage C**：planner prompt + batch UI。
- **Stage D**：VPS deploy + regression + 真並行測試。
