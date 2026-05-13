// ─── Mission Controller ──────────────────────────────────────────────────
// Sequential pipeline: Opus (planning) → GLM (coding) → Opus (review) → repeat
// Lives alongside the parallel Swarm Run system, but is its own entity type.
//
// State machine:
//   draft → planning → succession → phase_coding → phase_review
//        ↘ (revise) ↗                 ↘ (next) ↗
//                                                  → final_review → complete
//
// File-based handoff: every mission has a directory under MISSIONS_ROOT
// containing mission.md, state.json, phase-N-plan.md, phase-N-review.md,
// final-report.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MISSIONS_ROOT = process.env.MISSIONS_ROOT || path.join(process.env.HOME || '/home/hugo-orca', 'missions');
const MISSION_EXEC_TIMEOUT_MS = Number(process.env.MISSION_EXEC_TIMEOUT_MS || 60 * 60 * 1000); // 60 min per agent
const MAX_REVISION_ATTEMPTS = Number(process.env.MISSION_MAX_REVISIONS || 3);

function id(prefix = 'mission') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function slug(s) {
  return String(s || 'mission')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mission';
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

// ─── Mission entity ──────────────────────────────────────────────────────

function makeMission({ topic, goal, targetProject, plannerModel, coderModel, reviewerModel, autoExecute }) {
  const missionId = id('mission');
  const dir = path.join(MISSIONS_ROOT, `${Date.now()}_${slug(topic)}`);
  ensureDir(dir);
  return {
    id: missionId,
    topic: String(topic || 'Untitled Mission').slice(0, 200),
    goal: String(goal || '').slice(0, 2000),
    targetProject: targetProject || '/home/hugo-orca/orca-platform-mvp',
    dir,
    status: 'draft',
    autoExecute: autoExecute !== false,  // default true; false = pause for approval after planning
    plan: {
      successCriteria: [],
      phases: [],
    },
    currentPhase: 0,
    models: {
      planner: plannerModel || 'claude',     // 'claude' = real Opus
      coder: coderModel || 'glm',            // 'glm' = BigModel via claude CLI
      reviewer: reviewerModel || 'claude',
    },
    reviews: [],
    refinements: [],  // [{ feedback, ts }] for plan iterations
    timeline: [{ event: 'created', ts: nowIso(), summary: 'Mission created' }],
    logs: {},   // phase index -> log string
    finalReport: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function saveMission(mission) {
  mission.updatedAt = nowIso();
  writeFileSafe(path.join(mission.dir, 'state.json'), JSON.stringify(mission, null, 2));
}

function loadAllMissions() {
  ensureDir(MISSIONS_ROOT);
  const dirs = fs.readdirSync(MISSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'));
  return dirs.map((d) => {
    const statePath = path.join(MISSIONS_ROOT, d.name, 'state.json');
    if (!fs.existsSync(statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function publicMission(mission) {
  if (!mission) return null;
  return {
    id: mission.id,
    topic: mission.topic,
    goal: mission.goal,
    targetProject: mission.targetProject,
    dir: mission.dir,
    status: mission.status,
    autoExecute: mission.autoExecute !== false,
    plan: mission.plan,
    currentPhase: mission.currentPhase,
    models: mission.models,
    reviews: mission.reviews,
    refinements: mission.refinements || [],
    timeline: mission.timeline,
    activeAgent: mission.activeAgent || null,
    finalReport: mission.finalReport,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

// ─── CLI spawn helpers ───────────────────────────────────────────────────
// Both Claude (Opus) and GLM share the `claude` binary; GLM just needs
// extra env vars to route to BigModel's Anthropic-compatible endpoint.

// Cache BIGMODEL_API_KEY read from ~/.zhipu_secrets
let cachedBigModelKey = null;
function getBigModelKey() {
  if (cachedBigModelKey) return cachedBigModelKey;
  if (process.env.BIGMODEL_API_KEY) {
    cachedBigModelKey = process.env.BIGMODEL_API_KEY;
    return cachedBigModelKey;
  }
  try {
    const secretsPath = path.join(process.env.HOME || '/home/hugo-orca', '.zhipu_secrets');
    if (fs.existsSync(secretsPath)) {
      const content = fs.readFileSync(secretsPath, 'utf8');
      const m = content.match(/^export\s+BIGMODEL_API_KEY=([^\s]+)/m);
      if (m) {
        cachedBigModelKey = m[1].replace(/^["']|["']$/g, '');
        return cachedBigModelKey;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Resolve a model alias to its actual BigModel name + env config.
// Supports:
//   'claude' / 'opus'              → Claude (Anthropic native)
//   'glm' / 'glm-5.1'              → GLM-5.1 (主力，長程複雜)
//   'glm-4.6'                      → GLM-4.6 (中等)
//   'glm-4.5-air' / 'glm-mini'     → GLM-4.5 Air (簡單、平)
//   'codex'                        → Codex CLI
function resolveModel(model) {
  const m = String(model || 'claude').toLowerCase().trim();
  if (m === 'codex') return { cli: 'codex', label: 'Codex', provider: 'codex' };
  if (m === 'claude' || m === 'opus' || m === '') return { cli: 'claude', label: 'Opus', provider: 'anthropic' };
  if (m.startsWith('glm')) {
    let modelName = 'glm-5.1';
    let label = 'GLM-5.1';
    if (m === 'glm-4.5-air' || m === 'glm-mini' || m === 'glm-air') { modelName = 'glm-4.5-air'; label = 'GLM-4.5-Air'; }
    else if (m === 'glm-4.6') { modelName = 'glm-4.6'; label = 'GLM-4.6'; }
    return { cli: 'claude', label, provider: 'bigmodel', modelName };
  }
  return { cli: 'claude', label: 'Opus', provider: 'anthropic' };
}

function envForModel(model) {
  const info = resolveModel(model);
  if (info.provider === 'bigmodel') {
    const key = getBigModelKey();
    if (!key) {
      throw new Error('BIGMODEL_API_KEY missing (checked process.env + ~/.zhipu_secrets)');
    }
    return {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_DEFAULT_OPUS_MODEL: info.modelName,
      ANTHROPIC_DEFAULT_SONNET_MODEL: info.modelName,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
    };
  }
  return {};
}

function modelLabel(model) {
  return resolveModel(model).label;
}

// Spawn an agent, stream its stdout/stderr via onChunk, resolve when done.
function spawnAgent({ model, prompt, cwd, onChunk, label }) {
  return new Promise((resolve, reject) => {
    const extraEnv = envForModel(model);
    const info = resolveModel(model);

    let shellCmd;
    if (info.cli === 'codex') {
      shellCmd = 'cd "$1" && exec codex exec --cd "$1" --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox "$2"';
    } else {
      // claude or glm (both use claude CLI, glm differs via env vars)
      shellCmd = 'cd "$1" && exec claude -p --permission-mode bypassPermissions "$2"';
    }

    const child = spawn(
      'bash',
      ['-ic', shellCmd, 'mission-agent', cwd, prompt],
      {
        cwd,
        env: { ...process.env, ...extraEnv, TERM: process.env.TERM || 'xterm-256color' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    const timer = setTimeout(() => {
      onChunk?.(`\n[mission] Timeout ${Math.round(MISSION_EXEC_TIMEOUT_MS / 60000)} min — killing ${label}.\n`);
      child.kill('SIGTERM');
    }, MISSION_EXEC_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const t = chunk.toString();
      output += t;
      onChunk?.(t);
    });
    child.stderr.on('data', (chunk) => {
      const t = chunk.toString();
      output += t;
      onChunk?.(t);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ output, exitCode: 0 });
      else resolve({ output, exitCode: code, error: `agent exited with code ${code}` });
    });

    // Return the child so caller can kill if needed
    onChunk?.(`[mission] Spawning ${label} (${info.label}) in ${cwd}\n`);
  });
}

// ─── Prompt templates ────────────────────────────────────────────────────

function planningPrompt(mission) {
  return `你係 Mission Control 嘅 **Planning Architect**（Opus 模型，高階思考者）。

任務 topic：${mission.topic}
User 提供嘅 goal：${mission.goal || '（user 冇明確 goal，由你制定）'}
Target project：${mission.targetProject}

你嘅工作：寫一份 **mission.md**，含以下結構（用 Markdown）：

## 🎯 Goal
3-5 句精準描述呢個 mission 要達成乜。

## ✅ Success Criteria
- 3-7 個 measurable 嘅 criteria（用 bullet）
- 每個 criterion 完成後可以剔走

## 📦 Phases
你要將工作拆成 2-5 個 phases。每個 phase 由 GLM 執行，**single phase 嘅 scope 必須控制喺 ~50K context 之內**（即係幾個 files、一個 feature module、唔好太雜）。

**重要：phases 之間應該係 sequential dependency**（Phase 2 用 Phase 1 嘅成果），唔係 parallel。

每個 phase 用呢個 JSON-like 格式（**呢個會被 parse**，必須準確）：

\`\`\`phase
{
  "id": 1,
  "title": "簡短 title（例如：DB schema + API endpoints）",
  "scope": "2-3 句具體 scope 描述",
  "targetFiles": ["src/path/file1.ts", "src/path/file2.py"],
  "successCheck": "一句講點樣驗證呢 phase 完成（例如：npm test 過、API endpoint 返回 200）",
  "coderModel": "glm-5.1"
}
\`\`\`

### 📌 coderModel 選擇指引
為每個 phase 揀適合嘅 coder model 嚟慳 token：

- **\`"glm-5.1"\`** — 複雜邏輯、跨多 files、需要長程推理、新功能設計、tricky bugs
- **\`"glm-4.6"\`** — 中等複雜度、refactor、加 features 但邏輯清晰
- **\`"glm-4.5-air"\`** — 簡單修改、單一 file 嘅小改動、改 typo / 加 logging / 簡單 boilerplate

預設用 \`glm-5.1\`，但 simple phases **必須** 揀 \`glm-4.5-air\` 嚟慳 cost。

## 🛡️ Risks & Mitigations
2-3 個主要風險 + 應對。

---

**IMPORTANT 輸出規則：**
1. 直接喺呢個 cwd（mission workspace）建立 \`mission.md\` 檔案
2. 用 \`Write\` tool 寫，唔係 echo
3. 寫完之後用 \`Read\` 確認內容
4. 用繁體中文 / 廣東話
5. 唔好改動 target project 任何 code — 你只係 planner
`;
}

function successionPrompt(mission, planContent) {
  return `你係 Mission Control 嘅 **Succession Planner**（GLM 模型）。

Opus 已經寫好咗 master plan，喺呢度：
\`\`\`
${planContent}
\`\`\`

你嘅工作：對 master plan 入面 **每一個 phase**，寫一份詳細嘅 **phase-N-plan.md**，包含：

## Phase N: <title>

### Detailed Steps
- 具體要改邊啲 files、加邊啲 functions、改邊啲 logic
- 寫 pseudocode 或 partial code 示意關鍵變更
- 列出依賴（npm install / pip install / DB migration）

### Test Plan
- 點樣驗證呢 phase 完成（具體 commands / 預期 output）

### Files Expected to Change
具體 file paths（同 plan 嗰啲 targetFiles 對齊）

---

**IMPORTANT 輸出規則：**
1. 喺呢個 cwd 建立 \`phase-1-plan.md\`, \`phase-2-plan.md\` 等
2. 對 plan 入面**每一個 phase** 都要寫一份 plan file
3. 用 \`Write\` tool
4. 寫完用 \`Read\` 確認
5. 用繁體中文 / 廣東話
6. **唔好開始改 target project 嘅 code** — 而家只係寫 plan
`;
}

function codingPrompt(mission, phase, phasePlanContent, previousReviewFeedback) {
  const phaseNum = phase.id;
  const isRevision = !!previousReviewFeedback;
  return `你係 Mission Control 嘅 **Coder**（GLM 模型）。

**Mission topic**：${mission.topic}
**Target project (cwd)**：${mission.targetProject}
**Current phase**：Phase ${phaseNum} — ${phase.title}
**Attempt**：${phase.attempts || 1}${isRevision ? ' (revision)' : ' (first try)'}

### Phase Plan
\`\`\`
${phasePlanContent}
\`\`\`

${isRevision ? `### ⚠️ Previous Review Feedback（你之前 try 過，Opus 唔 pass）
\`\`\`
${previousReviewFeedback}
\`\`\`

針對以上 feedback 修改 — 唔好重複犯同樣錯誤。
` : ''}

### Success Check
${phase.successCheck || '（無明確 success check，盡力完成 phase plan）'}

### 你嘅工作
1. **直接改 target project 嘅 code**（cwd 已經係 ${mission.targetProject}）
2. 用 \`Edit\` / \`Write\` tools 改 files
3. 完成後**喺 mission workspace 寫一份 phase-${phaseNum}-output.md**（path: \`${mission.dir}/phase-${phaseNum}-output.md\`），含：
   - ## Summary（1-2 句）
   - ## Files Changed（list of files + 1 句講改咗乜）
   - ## How to Verify（具體驗證 steps）
   - ## Known Issues / Caveats（如果有）

### Rules
- **唔好** revert 其他 phases 嘅改動
- **唔好** 改 secrets / SSH keys / billing files
- 用繁體中文 / 廣東話寫 phase-${phaseNum}-output.md
- 行 tests 如果 plan 入面有 mention
`;
}

function reviewPrompt(mission, phase, phaseOutputContent, diffSummary) {
  return `你係 Mission Control 嘅 **Reviewer**（Opus 模型，嚴格評審）。

**Mission**：${mission.topic}
**Phase ${phase.id}**：${phase.title}
**Scope**：${phase.scope}
**Success Check**：${phase.successCheck}

### GLM 嘅 phase output
\`\`\`
${phaseOutputContent}
\`\`\`

### Git diff（最多 5000 行）
\`\`\`
${(diffSummary || '').slice(0, 50000)}
\`\`\`

你嘅工作：嚴格評審 GLM 完成嘅 phase。判斷係 ✅ pass 定 ❌ revise。

### Review 標準
- **Pass** 條件：
  - Files Changed 對應 phase scope（冇 scope creep）
  - Code 質素合理（冇明顯 bug、冇 dead code）
  - Success check 可以 verify
- **Revise** 條件：
  - 偏離 phase scope（改錯地方）
  - 明顯 bug（typos in critical logic、無 handle error case）
  - 漏咗 phase plan 入面講嘅關鍵步驟

### 輸出
喺呢個 cwd 寫一份 \`phase-${phase.id}-review.md\`，**第一行必須係：**

\`\`\`
VERDICT: pass
\`\`\`
或
\`\`\`
VERDICT: revise
\`\`\`

之後寫：
## Strengths
- 2-3 個做得好嘅地方

## Issues
- 2-5 個問題（如果係 revise，**每個 issue 必須具體指出邊個 file 邊度錯**，方便 GLM 修改）

## Verdict Reasoning
1-2 句解釋點解 pass / revise

---
用繁體中文 / 廣東話。**嚴格但唔好 perfectionist** — 如果 phase 大致 OK 就 pass，留低嘅小問題喺 final review 處理。
`;
}

function finalReviewPrompt(mission, reviewsContent, allOutputs) {
  return `你係 Mission Control 嘅 **Final Reviewer**（Opus 模型）。

**Mission**：${mission.topic}
**Goal**：${mission.goal}
**Success Criteria**：
${(mission.plan.successCriteria || []).map((c) => `- ${c}`).join('\n')}

### 所有 phase outputs
\`\`\`
${allOutputs}
\`\`\`

### 所有 reviews
\`\`\`
${reviewsContent}
\`\`\`

你嘅工作：寫一份 \`final-report.md\` 俾 user 睇，含：

## ✅ Mission Status
**Verdict**: Success / Partial Success / Failed

## 🎯 Goal Achievement
- 對住每個 success criterion 講係 ✅ 達成 / 🟡 部分 / ❌ 未達成

## 📦 Phase Summary
| Phase | Title | Status | Attempts |
表格列出每個 phase 嘅最終狀態

## ⚠️ Known Issues /未完成
- 列出未解決嘅問題或者後續要跟進嘅嘢

## 💡 Recommendations
- 2-3 個建議下一步

## 📊 Metrics
- 總 phases: N
- Revision attempts: N
- 估計 lines changed: N (從 diffs 數)

---
寫去 \`${mission.dir}/final-report.md\`。用繁體中文 / 廣東話。
`;
}

// ─── Mission state machine drivers ───────────────────────────────────────

function appendLog(mission, phaseIdx, chunk) {
  const key = String(phaseIdx ?? 'system');
  if (!mission.logs[key]) mission.logs[key] = '';
  mission.logs[key] += chunk;
  // Cap at 200K per phase
  if (mission.logs[key].length > 200000) {
    mission.logs[key] = `...[trimmed]\n${mission.logs[key].slice(-200000)}`;
  }
}

function pushTimeline(mission, event, summary) {
  mission.timeline.push({ event, ts: nowIso(), summary });
}

// Parse the phases out of mission.md (looks for ```phase JSON blocks)
function parsePhasesFromMd(md) {
  const phases = [];
  const re = /```phase\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      phases.push({
        id: obj.id || phases.length + 1,
        title: String(obj.title || `Phase ${phases.length + 1}`),
        scope: String(obj.scope || ''),
        targetFiles: Array.isArray(obj.targetFiles) ? obj.targetFiles : [],
        successCheck: String(obj.successCheck || ''),
        coderModel: obj.coderModel ? String(obj.coderModel) : null,  // null = inherit mission.models.coder
        status: 'pending',
        attempts: 0,
      });
    } catch (e) {
      // skip bad block
    }
  }
  return phases;
}

// Parse Success Criteria from mission.md (## ✅ Success Criteria followed by bullets)
function parseSuccessCriteria(md) {
  const m = md.match(/##\s*[✅]?\s*Success Criteria[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
  if (!m) return [];
  return m[1].split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

// Parse VERDICT: pass/revise from review file
function parseVerdict(reviewMd) {
  const m = (reviewMd || '').match(/VERDICT:\s*(pass|revise|fail)/i);
  if (!m) return { verdict: 'unknown', feedback: reviewMd };
  return {
    verdict: m[1].toLowerCase() === 'pass' ? 'pass' : 'revise',
    feedback: reviewMd,
  };
}

// ─── Public API: lifecycle functions ─────────────────────────────────────

async function runPlanning(mission, emit) {
  mission.status = 'planning';
  mission.activeAgent = { role: 'planner', model: mission.models.planner, startedAt: nowIso() };
  pushTimeline(mission, 'planning-start', `${modelLabel(mission.models.planner)} 開始規劃`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const prompt = planningPrompt(mission);
  const result = await spawnAgent({
    model: mission.models.planner,
    prompt,
    cwd: mission.dir,
    label: 'Planner',
    onChunk: (chunk) => {
      appendLog(mission, 'planning', chunk);
      emit('mission-log', { missionId: mission.id, phase: 'planning', chunk });
      saveMission(mission);
    },
  });

  // After planner finishes, read mission.md
  const missionMdPath = path.join(mission.dir, 'mission.md');
  const missionMd = readFileSafe(missionMdPath);
  if (!missionMd) {
    mission.status = 'failed';
    pushTimeline(mission, 'planning-failed', 'mission.md 未生成');
    mission.activeAgent = null;
    saveMission(mission);
    emit('mission-status', publicMission(mission));
    return { ok: false, error: 'mission.md not produced by planner' };
  }

  mission.plan.successCriteria = parseSuccessCriteria(missionMd);
  mission.plan.phases = parsePhasesFromMd(missionMd);
  mission.plan.rawMd = missionMd;
  pushTimeline(mission, 'planning-done', `${mission.plan.phases.length} phases / ${mission.plan.successCriteria.length} criteria`);
  mission.activeAgent = null;
  mission.status = 'succession';
  saveMission(mission);
  emit('mission-status', publicMission(mission));
  return { ok: true, phases: mission.plan.phases.length };
}

async function runSuccession(mission, emit) {
  mission.status = 'succession';
  mission.activeAgent = { role: 'succession', model: mission.models.coder, startedAt: nowIso() };
  pushTimeline(mission, 'succession-start', `${modelLabel(mission.models.coder)} 細化每個 phase plan`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const missionMd = mission.plan.rawMd || readFileSafe(path.join(mission.dir, 'mission.md'));
  const prompt = successionPrompt(mission, missionMd);
  const result = await spawnAgent({
    model: mission.models.coder,
    prompt,
    cwd: mission.dir,
    label: 'Succession Planner',
    onChunk: (chunk) => {
      appendLog(mission, 'succession', chunk);
      emit('mission-log', { missionId: mission.id, phase: 'succession', chunk });
      saveMission(mission);
    },
  });

  // Verify phase-N-plan.md files exist
  const expectedPlans = mission.plan.phases.map((p) => path.join(mission.dir, `phase-${p.id}-plan.md`));
  const missingPlans = expectedPlans.filter((p) => !fs.existsSync(p));
  if (missingPlans.length > 0) {
    pushTimeline(mission, 'succession-warning', `${missingPlans.length} phase plans 未生成 — 仍會繼續`);
  }

  pushTimeline(mission, 'succession-done', 'phase plans ready');
  mission.activeAgent = null;
  mission.status = 'phase_coding';
  mission.currentPhase = 1;
  saveMission(mission);
  emit('mission-status', publicMission(mission));
  return { ok: true };
}

function getGitDiff(targetProject) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', `cd "${targetProject}" && git diff HEAD --stat && echo "--- FULL DIFF ---" && git diff HEAD | head -2000`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => out += c);
    child.stderr.on('data', (c) => out += c);
    child.on('exit', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

async function runPhaseCoding(mission, emit, previousReviewFeedback = null) {
  const phase = mission.plan.phases[mission.currentPhase - 1];
  if (!phase) return { ok: false, error: 'no phase to code' };
  phase.attempts = (phase.attempts || 0) + 1;
  phase.status = 'coding';
  mission.status = 'phase_coding';
  const effectiveCoder = phase.coderModel || mission.models.coder;
  mission.activeAgent = { role: 'coder', model: effectiveCoder, startedAt: nowIso(), phase: phase.id };
  pushTimeline(mission, `phase-${phase.id}-coding-start`, `${modelLabel(effectiveCoder)} 開始 Phase ${phase.id} (attempt ${phase.attempts})`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const phasePlanContent = readFileSafe(path.join(mission.dir, `phase-${phase.id}-plan.md`));
  const prompt = codingPrompt(mission, phase, phasePlanContent, previousReviewFeedback);

  await spawnAgent({
    model: effectiveCoder,
    prompt,
    cwd: mission.targetProject,
    label: `Coder Phase ${phase.id}`,
    onChunk: (chunk) => {
      appendLog(mission, `phase-${phase.id}`, chunk);
      emit('mission-log', { missionId: mission.id, phase: `phase-${phase.id}`, chunk });
      saveMission(mission);
    },
  });

  phase.status = 'coded';
  mission.activeAgent = null;
  mission.status = 'phase_review';
  saveMission(mission);
  emit('mission-status', publicMission(mission));
  return { ok: true };
}

async function runPhaseReview(mission, emit) {
  const phase = mission.plan.phases[mission.currentPhase - 1];
  if (!phase) return { ok: false, error: 'no phase to review' };
  mission.activeAgent = { role: 'reviewer', model: mission.models.reviewer, startedAt: nowIso(), phase: phase.id };
  pushTimeline(mission, `phase-${phase.id}-review-start`, `${modelLabel(mission.models.reviewer)} 審查 Phase ${phase.id}`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const outputPath = path.join(mission.dir, `phase-${phase.id}-output.md`);
  const phaseOutputContent = readFileSafe(outputPath);
  const diffSummary = await getGitDiff(mission.targetProject);
  // Save diff for record
  writeFileSafe(path.join(mission.dir, `phase-${phase.id}.diff`), diffSummary);
  const prompt = reviewPrompt(mission, phase, phaseOutputContent, diffSummary);

  await spawnAgent({
    model: mission.models.reviewer,
    prompt,
    cwd: mission.dir,
    label: `Reviewer Phase ${phase.id}`,
    onChunk: (chunk) => {
      appendLog(mission, `phase-${phase.id}-review`, chunk);
      emit('mission-log', { missionId: mission.id, phase: `phase-${phase.id}-review`, chunk });
      saveMission(mission);
    },
  });

  const reviewPath = path.join(mission.dir, `phase-${phase.id}-review.md`);
  const reviewMd = readFileSafe(reviewPath);
  const { verdict, feedback } = parseVerdict(reviewMd);
  mission.reviews.push({ phaseId: phase.id, attempt: phase.attempts, verdict, feedback, ts: nowIso() });
  phase.lastVerdict = verdict;
  pushTimeline(mission, `phase-${phase.id}-review-${verdict}`, `Verdict: ${verdict}`);

  mission.activeAgent = null;
  saveMission(mission);
  emit('mission-review', { missionId: mission.id, phase: phase.id, verdict, feedback });

  if (verdict === 'pass') {
    phase.status = 'passed';
    if (mission.currentPhase >= mission.plan.phases.length) {
      mission.status = 'final_review';
    } else {
      mission.currentPhase += 1;
      mission.status = 'phase_coding';
    }
  } else if (verdict === 'revise') {
    if (phase.attempts >= MAX_REVISION_ATTEMPTS) {
      phase.status = 'blocked';
      mission.status = 'blocked';
      pushTimeline(mission, `phase-${phase.id}-blocked`, `已超過 ${MAX_REVISION_ATTEMPTS} 次嘗試`);
    } else {
      phase.status = 'revising';
      mission.status = 'phase_coding';  // loop back
    }
  } else {
    phase.status = 'unknown';
    mission.status = 'blocked';
  }

  saveMission(mission);
  emit('mission-status', publicMission(mission));
  return { ok: true, verdict };
}

async function runFinalReview(mission, emit) {
  mission.status = 'final_review';
  mission.activeAgent = { role: 'final-reviewer', model: mission.models.reviewer, startedAt: nowIso() };
  pushTimeline(mission, 'final-review-start', `${modelLabel(mission.models.reviewer)} 開始最終 review`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const reviewsContent = mission.plan.phases.map((p) => {
    const r = readFileSafe(path.join(mission.dir, `phase-${p.id}-review.md`));
    return `--- Phase ${p.id} review ---\n${r}`;
  }).join('\n\n');
  const allOutputs = mission.plan.phases.map((p) => {
    const o = readFileSafe(path.join(mission.dir, `phase-${p.id}-output.md`));
    return `--- Phase ${p.id} output ---\n${o}`;
  }).join('\n\n');
  const prompt = finalReviewPrompt(mission, reviewsContent, allOutputs);

  await spawnAgent({
    model: mission.models.reviewer,
    prompt,
    cwd: mission.dir,
    label: 'Final Reviewer',
    onChunk: (chunk) => {
      appendLog(mission, 'final-review', chunk);
      emit('mission-log', { missionId: mission.id, phase: 'final-review', chunk });
      saveMission(mission);
    },
  });

  const reportPath = path.join(mission.dir, 'final-report.md');
  mission.finalReport = readFileSafe(reportPath);
  mission.status = 'complete';
  mission.activeAgent = null;
  pushTimeline(mission, 'mission-complete', '✅ Mission complete');
  saveMission(mission);
  emit('mission-status', publicMission(mission));
  return { ok: true };
}

// Re-plan with user feedback (draft mode iteration)
async function refinePlan(mission, feedback, emit) {
  mission.refinements.push({ feedback, ts: nowIso() });
  mission.status = 'planning';
  mission.activeAgent = { role: 'planner', model: mission.models.planner, startedAt: nowIso() };
  pushTimeline(mission, 'plan-refine-start', `${modelLabel(mission.models.planner)} 根據 feedback 修改 plan`);
  saveMission(mission);
  emit('mission-status', publicMission(mission));

  const oldPlan = readFileSafe(path.join(mission.dir, 'mission.md'));
  const refinePrompt = `你係 Mission Control 嘅 Planning Architect。

**之前嘅 mission.md：**
\`\`\`
${oldPlan}
\`\`\`

**User 嘅 feedback / 修改要求：**
${feedback}

根據 user feedback 修改 mission.md。**保留 user 滿意嘅部分**，只改 user 指出嘅地方。輸出新版本嘅 mission.md，**直接覆蓋舊嘅 mission.md** 喺 cwd。

保持原有結構（## 🎯 Goal / ## ✅ Success Criteria / ## 📦 Phases / ## 🛡️ Risks）。
每個 phase 仍然要用 \`\`\`phase JSON \`\`\` 格式（包括 coderModel field）。

用繁體中文 / 廣東話。`;

  await spawnAgent({
    model: mission.models.planner,
    prompt: refinePrompt,
    cwd: mission.dir,
    label: 'Planner (refine)',
    onChunk: (chunk) => {
      appendLog(mission, 'planning', chunk);
      emit('mission-log', { missionId: mission.id, phase: 'planning', chunk });
      saveMission(mission);
    },
  });

  const missionMd = readFileSafe(path.join(mission.dir, 'mission.md'));
  mission.plan.successCriteria = parseSuccessCriteria(missionMd);
  mission.plan.phases = parsePhasesFromMd(missionMd);
  mission.plan.rawMd = missionMd;
  pushTimeline(mission, 'plan-refined', `Plan v${mission.refinements.length + 1} ready · ${mission.plan.phases.length} phases`);
  mission.activeAgent = null;
  mission.status = 'awaiting_approval';
  saveMission(mission);
  emit('mission-status', publicMission(mission));
}

// Run only the planning phase, then halt for user approval (if draft mode)
async function runPlanningOnly(mission, emit) {
  await runPlanning(mission, emit);
  if (mission.status === 'failed') return;
  mission.status = 'awaiting_approval';
  pushTimeline(mission, 'awaiting-approval', '等待 user approve plan 先執行 coding');
  saveMission(mission);
  emit('mission-status', publicMission(mission));
}

// Run from succession onwards (after plan is approved)
async function runExecutionPhase(mission, emit) {
  try {
    if (mission.status === 'awaiting_approval' || mission.status === 'planning_review') {
      mission.status = 'succession';
      saveMission(mission);
    }
    if (mission.status === 'succession' && mission.plan.phases.length > 0 && !mission.plan.phases.some(p => p.status !== 'pending')) {
      await runSuccession(mission, emit);
    }
    while (mission.status === 'phase_coding') {
      const phase = mission.plan.phases[mission.currentPhase - 1];
      const previousReview = mission.reviews
        .filter((r) => r.phaseId === phase?.id && r.verdict === 'revise')
        .slice(-1)[0];
      await runPhaseCoding(mission, emit, previousReview?.feedback || null);
      if (mission.status === 'blocked') return;
      await runPhaseReview(mission, emit);
      if (mission.status === 'blocked') return;
    }
    if (mission.status === 'final_review') {
      await runFinalReview(mission, emit);
    }
  } catch (err) {
    pushTimeline(mission, 'error', String(err.message || err));
    mission.status = 'failed';
    mission.activeAgent = null;
    saveMission(mission);
    emit('mission-status', publicMission(mission));
  }
}

// Master driver: respects autoExecute flag
async function runMission(mission, emit) {
  try {
    if (mission.autoExecute === false) {
      // Draft mode: plan only, wait for approval
      await runPlanningOnly(mission, emit);
      return;
    }
    // Auto mode: plan and execute everything
    await runPlanning(mission, emit);
    if (mission.status === 'failed') return;
    await runExecutionPhase(mission, emit);
  } catch (err) {
    pushTimeline(mission, 'error', String(err.message || err));
    mission.status = 'failed';
    mission.activeAgent = null;
    saveMission(mission);
    emit('mission-status', publicMission(mission));
  }
}

// ─── Express routes registration ─────────────────────────────────────────

function registerRoutes(app, io) {
  const emit = (event, data) => io.emit(event, data);

  // In-memory cache of active missions (loaded from disk on startup)
  const missions = new Map();
  loadAllMissions().forEach((m) => missions.set(m.id, m));
  console.log(`[mission] loaded ${missions.size} missions from disk`);

  app.get('/mission/api/list', (req, res) => {
    const list = Array.from(missions.values())
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(publicMission);
    res.json({ missions: list });
  });

  app.get('/mission/api/:id', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json({ mission: publicMission(m), logs: m.logs });
  });

  app.get('/mission/api/:id/file/:filename', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const fn = req.params.filename;
    // Basic safety: only allow specific files
    if (!/^(mission\.md|phase-\d+-(plan|output|review)\.md|phase-\d+\.diff|final-report\.md)$/.test(fn)) {
      return res.status(400).json({ error: 'forbidden filename' });
    }
    const filePath = path.join(m.dir, fn);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
    res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
  });

  app.post('/mission/api/create', (req, res) => {
    try {
      const { topic, goal, targetProject, models, autoExecute } = req.body || {};
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const mission = makeMission({
        topic, goal,
        targetProject: targetProject || '/home/hugo-orca/orca-platform-mvp',
        plannerModel: models?.planner || 'claude',
        coderModel: models?.coder || 'glm',
        reviewerModel: models?.reviewer || 'claude',
        autoExecute,
      });
      missions.set(mission.id, mission);
      saveMission(mission);
      emit('mission-created', publicMission(mission));
      // Kick off async run
      setImmediate(() => runMission(mission, emit));
      res.json({ ok: true, mission: publicMission(mission) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/mission/api/:id/cancel', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    m.status = 'cancelled';
    m.activeAgent = null;
    pushTimeline(m, 'cancelled', 'User cancelled');
    saveMission(m);
    emit('mission-status', publicMission(m));
    res.json({ ok: true });
  });

  // Draft mode: approve plan → start execution
  app.post('/mission/api/:id/approve', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    if (m.status !== 'awaiting_approval') {
      return res.status(400).json({ error: `mission status is ${m.status}, not awaiting_approval` });
    }
    pushTimeline(m, 'plan-approved', 'User approved plan — 開始 execution');
    saveMission(m);
    emit('mission-status', publicMission(m));
    setImmediate(() => runExecutionPhase(m, emit));
    res.json({ ok: true });
  });

  // Draft mode: send feedback → re-plan
  app.post('/mission/api/:id/refine', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const { feedback } = req.body || {};
    if (!feedback || !String(feedback).trim()) {
      return res.status(400).json({ error: 'feedback required' });
    }
    if (m.status !== 'awaiting_approval') {
      return res.status(400).json({ error: `mission status is ${m.status}, not awaiting_approval` });
    }
    res.json({ ok: true });  // respond before kicking off
    setImmediate(() => refinePlan(m, String(feedback), emit));
  });

  // Override coderModel for a specific phase
  app.post('/mission/api/:id/phase/:phaseId/model', (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const phaseId = Number(req.params.phaseId);
    const { coderModel } = req.body || {};
    const phase = m.plan.phases.find((p) => p.id === phaseId);
    if (!phase) return res.status(404).json({ error: 'phase not found' });
    phase.coderModel = coderModel || null;
    pushTimeline(m, `phase-${phaseId}-model-changed`, `Coder for Phase ${phaseId} → ${modelLabel(coderModel || m.models.coder)}`);
    saveMission(m);
    emit('mission-status', publicMission(m));
    res.json({ ok: true });
  });

  console.log('[mission] routes registered: list, get, create, approve, refine, phase/model, cancel');
}

module.exports = { registerRoutes };
