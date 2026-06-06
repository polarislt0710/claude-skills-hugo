const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Server } = require('socket.io');

// Load .env (Cronicle API key, etc.) before any module reads process.env
require('./lib/env').loadEnv(path.join(__dirname, '.env'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3010;
const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'swarm-v3-state.json');
const DEFAULT_PROJECT_ROOT = process.env.SWARM_PROJECT_ROOT || '/home/hugo-orca/orca-platform-mvp';
const EXEC_TIMEOUT_MS = Number(process.env.SWARM_EXEC_TIMEOUT_MS || 45 * 60 * 1000);
const MAX_LOG_CHARS = 120000;
const MAX_CONTEXT_CHARS = 24000;
const DEFAULT_AGENT_CLI = process.env.SWARM_AGENT_CLI || 'claude';
const SWARM_WORKSPACE = process.env.SWARM_WORKSPACE || path.join(require("os").homedir(), "swarm-workspace");
const MIROFISH_BACKEND_URL = process.env.MIROFISH_BACKEND_URL || 'http://127.0.0.1:5001';
// Parallel build agents share one git working tree → race. SWARM_WORKTREE=1 gives
// each parallel code agent its own git worktree, merged back after the wave.
const SWARM_WORKTREE = process.env.SWARM_WORKTREE === '1';
const worktreeMgr = require('./lib/mission-worktree');
// SWARM_REVIEW_GATE=1 turns review→fix into a quality loop: reviewer emits
// PASS/WARN/FAIL; WARN/FAIL runs fix then re-reviews, up to N iterations.
const SWARM_REVIEW_GATE = process.env.SWARM_REVIEW_GATE === '1';
// Default 1 fix pass (not 2) + soft mode (only FAIL loops; WARN accepted) to
// prevent the slow multi-iteration fix storms seen in Mission Orchestrator.
const SWARM_REVIEW_GATE_MAX = Number(process.env.SWARM_REVIEW_GATE_MAX || 1);
const SWARM_REVIEW_GATE_STRICT = process.env.SWARM_REVIEW_GATE_STRICT === '1';
const SWARM_GATE_TIME_BUDGET_MS = Number(process.env.SWARM_GATE_TIME_BUDGET_MS || 0);
// ─── Swarm Council (三模議會 · Phase 2-4): 三模共識收斂 + 人手御准閘 + 人話講解 ───
// 三個你揀嘅 model 讀真 project + plan,互相博弈到零爭議,moderator 改寫 plan.vN;
// 收斂(或用盡 round)後停低交人手御准,批准後 explainer 用人話講解。全程沿用 CLI spawn
// (OAuth Max,零增量成本)。全部邏輯 gate by p.mode==='council',唔影響既有 code/thinking pipeline。
const SWARM_COUNCIL_MAX_ROUNDS = Number(process.env.SWARM_COUNCIL_MAX_ROUNDS || 6);      // 5-6 round 上限
const SWARM_COUNCIL_TIME_BUDGET_MS = Number(process.env.SWARM_COUNCIL_TIME_BUDGET_MS || 0); // 0 = off
const COUNCIL_DIR = (runId) => path.join(DATA_DIR, 'council', String(runId));
// ─── Swarm Council Phase 1: 定向幕僚 chat (互動單-model brainstorm → mission brief) ───
const MAX_CHAT_MSG_CHARS = 16000;   // 單條 message 上限
const MAX_CHAT_TURNS = 60;          // thread 最多保留幾多 turn(超過 trim 最舊)
const CHAT_TIMEOUT_MS = Number(process.env.SWARM_CHAT_TIMEOUT_MS || 120000); // 單 turn 上限
// SWARM_PLAN_DECOMPOSE=1: a planner agent reads the task and splits the build
// stage into N dependency-aware sub-phases (parallel waves), replacing the fixed
// frontend/backend/test wave. Uses mission-wave-planner for topological waves.
const SWARM_PLAN_DECOMPOSE = process.env.SWARM_PLAN_DECOMPOSE === '1';
const SWARM_PLAN_MAX_PARALLEL = Number(process.env.SWARM_PLAN_MAX_PARALLEL || process.env.MISSION_PARALLEL_MAX || 3);
const { planWaves } = require('./lib/mission-wave-planner');
// SWARM_RUN_QUEUE=1: runs execute one-at-a-time. A RUN issued while another run
// is executing is queued (status 'queued') and auto-started when the active one
// finishes — instead of all runs fighting over the agent pool / 8GB RAM.
const SWARM_RUN_QUEUE = process.env.SWARM_RUN_QUEUE === '1';
const runQueuePending = [];
// Mission Orchestrator soft-disabled by default — superseded by Swarm Desktop.
// Code kept; set MISSION_ORCHESTRATOR_ENABLED=1 to re-enable the /mission routes.
const MISSION_ORCHESTRATOR_ENABLED = process.env.MISSION_ORCHESTRATOR_ENABLED === '1';

// ─── Skill Injection System ───
// Reads skill SKILL.md files at startup and injects relevant content into agent prompts.
// Cache hashes may change on plugin update — resolveSkillPath() uses glob to find them.
const PLUGIN_CACHE_BASE = path.join(process.env.HOME || '/home/hugo-orca', '.claude/plugins/cache/hugo-personal');
const STANDALONE_SKILLS_DIR = path.join(process.env.HOME || '/home/hugo-orca', '.claude/skills');

// Skill name -> path resolver config
// For plugin skills: { plugin, skill } — auto-resolves hash dir at startup
// For standalone skills: { standalone } — reads from ~/.claude/skills/<name>/SKILL.md
const SKILL_REGISTRY = {
  // super-personas plugin
  'architect':             { plugin: 'super-personas', skill: 'architect' },
  'debugger':              { plugin: 'super-personas', skill: 'debugger' },
  'reviewer-persona':      { plugin: 'super-personas', skill: 'reviewer' },
  'security-auditor':      { plugin: 'super-personas', skill: 'security-auditor' },
  'performance-engineer':  { plugin: 'super-personas', skill: 'performance-engineer' },
  'refactor-engineer':     { plugin: 'super-personas', skill: 'refactor-engineer' },
  // design plugin
  'typography':  { plugin: 'design', skill: 'typography' },
  'color':       { plugin: 'design', skill: 'color' },
  'layout':      { plugin: 'design', skill: 'layout' },
  'components':  { plugin: 'design', skill: 'components' },
  // standalone skills
  'brainstormers':  { standalone: 'brainstormers' },
  'taste-skill':    { standalone: 'taste-skill' },
  'execution-discipline': { standalone: 'execution-discipline' },
};

function resolveSkillPath(entry) {
  if (entry.standalone) {
    return path.join(STANDALONE_SKILLS_DIR, entry.standalone, 'SKILL.md');
  }
  // Plugin skill — find the cache hash dir dynamically
  const pluginBase = path.join(PLUGIN_CACHE_BASE, entry.plugin);
  try {
    const dirs = fs.readdirSync(pluginBase).filter((d) => {
      return fs.statSync(path.join(pluginBase, d)).isDirectory();
    });
    if (dirs.length === 0) return null;
    // Use first hash dir (usually the only one)
    const hashDir = dirs[0];
    return path.join(pluginBase, hashDir, 'skills', entry.skill, 'SKILL.md');
  } catch {
    return null;
  }
}

function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length) : content;
}

const MAX_SKILL_CHARS = 6000;

function loadSkills() {
  const cache = {};
  for (const [name, entry] of Object.entries(SKILL_REGISTRY)) {
    const filePath = resolveSkillPath(entry);
    if (!filePath) {
      console.warn('[skill-inject] \u26a0 could not resolve path for skill:', name);
      continue;
    }
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      content = stripFrontmatter(content).trim();
      if (content.length > MAX_SKILL_CHARS) {
        content = content.slice(0, MAX_SKILL_CHARS) + '\n... [truncated]';
      }
      cache[name] = content;
      console.log('[skill-inject] \u2713 loaded:', name, '(' + content.length + ' chars)');
    } catch (err) {
      console.warn('[skill-inject] \u26a0 failed to load ' + name + ' from ' + filePath + ': ' + err.message);
    }
  }
  return cache;
}

const LAYERS = [
  { id: 'research', no: '01', label: '研究', hint: '背景、限制、資料、風險掃描' },
  { id: 'stakeholder', no: '02', label: '協作', hint: '角色 / 利益相關者提出立場' },
  { id: 'debate', no: '03', label: '博弈', hint: '互相挑戰、找矛盾、壓力測試' },
  { id: 'decision', no: '04', label: '決策', hint: '收斂方案、排序、定義下一步' },
  { id: 'delivery', no: '05', label: '交付', hint: '報告、patch、測試、實作輸出' },
  { id: 'review', no: '06', label: '覆核', hint: '交付後 review、風險、回歸檢查' },
];

const EXECUTION_PRESETS = [
  {
    key: 'frontend',
    name: 'Frontend Agent',
    layer: 'delivery',
    role: '前端開發',
    skill: 'UI / CSS / responsive / browser verification',
    scope: '負責前端 UI、互動、responsive、視覺 polish，避免改 backend contract。',
  },
  {
    key: 'backend',
    name: 'Backend Agent',
    layer: 'delivery',
    role: '後端開發',
    skill: 'API / persistence / server workflow',
    scope: '負責 server API、資料模型、持久化、job orchestration，避免無關 UI 重構。',
  },
  {
    key: 'test',
    name: 'Test Agent',
    layer: 'delivery',
    role: '測試 / QA',
    skill: 'tests / smoke checks / regression risks',
    scope: '負責測試、驗證、smoke check、指出未覆蓋風險，必要時補測試。',
  },
  {
    key: 'reviewer',
    name: 'Reviewer Agent',
    layer: 'review',
    role: 'Reviewer',
    skill: 'code review / risk analysis / integration notes',
    scope: '負責 review 現有改動、找 bug / race / security risk，不要 revert 其他 agent 工作。請將發現分成「🔴 必修(會出錯/破壞功能/安全)」同「🟡 建議(風格/邊角)」，並喺最後輸出一個明確標記：若有🔴必修項就寫一行「FIX_NEEDED: <逐項列出>」；若全部乾淨就寫一行「FIX_NEEDED: NONE」。比下游 Fix agent 直接用。',
  },
  {
    key: 'fixer',
    name: 'Fix Agent',
    layer: 'review',
    role: '修正',
    skill: 'targeted fixes / apply review feedback / verify',
    scope: '讀上一個 Reviewer Agent 嘅報告（尤其「FIX_NEEDED:」嗰行）。只修🔴必修項，一次過修晒，修完跑一次測試 / 驗證確認冇 leftover warning。🟡建議項同需要架構決策 / 使錢 / 改 schema 嘅深層問題唔好自作主張，改為清楚 flag 出嚟留俾 Hugo。鐵則：最多做一輪修正，唔好無限重試；若一輪修唔好，停低並寫低剩低咩、點解、建議下一步。不要 revert 其他 agent 工作。',
  },
  {
    key: 'verifier',
    name: 'Verifier Agent',
    layer: 'review',
    role: '實測驗證',
    skill: 'run acceptance commands / paste real output / evidence-gated sign-off',
    scope: '你係最後一關，唔係睇 code，係**真係去 run**。讀 task 嘅驗收條件（acceptance / 「如何驗證」），逐條**實際執行對應指令**（curl / 查 DB / 跑 test / 開 app），並將**真實 output 原文貼返出嚟**做證據。鐵則：唔准淨係講「應該 work」；冇貼到 output 就當未過。任何一條驗收 fail、或者需要嘅嘢做唔到（缺密碼 / 權限）→ 唔好扮過到，照實報告。最後**獨立一行**輸出裁決：全部實測通過寫「VERIFY: PASS」；有 fail 寫「VERIFY: FAIL: <逐項 + 實際 output>」；做唔到驗證寫「VERIFY: BLOCKED: <缺咩>」。不要 revert 其他 agent 工作。',
  },
];

// ─── Swarm Council system prompts (注入 preset.scope) ───
const COUNCIL_REVIEWER_SCOPE = [
  '你係「三模議會」三個共識評審之一。另外仲有兩個*唔同 model* 嘅評審同你並行,之後有一個 moderator 會 merge 大家意見、改寫 plan。',
  '你嘅 cwd 就係真實 project 根目錄。你**必須真係用 Read / grep / Bash(ls/cat/git log)去查項目入面嘅實際文件**先發言,唔准淨係讀 plan 文字就估。',
  '輸入:① 當前 plan(喺下面 task brief)② project 實際 code / 結構 / config。',
  '根據 goal,逐點寫低你嘅評審:',
  '1. 要改善:plan 邊度弱、漏咗咩、邊度過度設計。',
  '2. 要做 / 要捉(fix)/ 要加:實際 code 入面有咩 bug / 缺口 / 風險要喺 plan 反映。',
  '3. 環節之間關係:步驟之間嘅連扣、依賴、UI、UX、data flow 有冇斷層或矛盾。',
  '博弈紀律:主動挑另外兩位(上一 round)嘅論點骨頭,標出歧義同矛盾。目標係**傾到三個全部同意、零爭議**。同意就講同意,唔好為拗而拗。',
  '**唔好自己直接改 plan 文字檔** —— 你只負責提出結構化改動建議,由 moderator 落實(避免三人撞同一個 file)。',
  '最後**必須**用呢個固定格式收尾(俾機器 parse,前後唔好加多餘文字):',
  'CONSENSUS: AGREE        # 或 DISPUTE(你對當前 plan 仲有未解爭議)',
  'OPEN_ISSUES:',
  '- [id] 一句講清未解爭議 / 要 moderator 仲裁嘅點(AGREE 就寫「(none)」)',
  'PROPOSED_CHANGES:',
  '- 對 plan 嘅具體改動(patch 級描述:邊段、改成點)',
].join('\n');

const COUNCIL_MODERATOR_SCOPE = [
  '你係「三模議會」嘅 moderator(仲裁收斂)。三個評審(A/B/C)今 round 嘅完整輸出**會以 file path 形式喺 task brief 列出** —— 你**必須先用 Read tool 逐個讀晒嗰啲 file 全文**先 merge,唔好只靠摘要(摘要會缺料,尤其體積大嗰份)。讀埋當前 plan。',
  '1. Merge:將三人嘅 PROPOSED_CHANGES 合併、去重、解衝突,**改寫出新一版完整 plan**。三人有衝突嘅地方,揀技術上最穩陣嗰個,並一句講點解。若某評審缺席(fail),照 merge 在席者意見,唔好因為少咗一把聲就 block。',
  '2. 重新評估每條 OPEN_ISSUES:已解決就剔走;仍未解就保留,標明邊位提出、卡喺邊。',
  '3. **必須**將新 plan 全文用呢個 fenced block 輸出(系統會寫去 plan.vN.md):',
  '```plan-final',
  '<完整 markdown plan 全文>',
  '```',
  '4. 之後**必須**用呢個固定格式收尾(俾機器 parse):',
  'COUNCIL: CONVERGED      # 三人零未解爭議;仲有爭議就寫 OPEN',
  'OPEN_DISPUTES: <整數>',
  'DISPUTES:',
  '- [id] 一句講未解爭議(CONVERGED 就寫「(none)」)',
].join('\n');

const COUNCIL_EXPLAINER_SCOPE = [
  '你向一個**非技術**用戶講解最終 plan。讀下面 task brief 入面嘅終稿 plan。',
  '用**最短、結果論導向嘅人話(繁體中文 / 廣東話)**,唔好複述步驟細節,只答五件事,每段最多 2-3 句:',
  '**做乜**:一句講要達成咩。',
  '**點解**:解決緊咩痛點。',
  '**出咩**:用戶最後攞到咩成果。',
  '**幾耐**:粗略時間 / 工序量級。',
  '**風險**:最值得擔心嘅 1-2 點 + 點 mitigate。',
  '唔好 emoji、唔好 marketing 語、唔好「綜上所述」。直接俾人睇得明、肯撳批准。',
].join('\n');

const THINKING_PRESETS = [
  {
    key: 'researcher',
    name: 'Research Agent',
    layer: 'research',
    role: '研究整理',
    skill: 'context scan / source notes / constraints',
    scope: '負責整理背景、現有對話、限制、已知資料同未知風險；交付清晰文字研究結果。',
    deliveryMode: 'thinking',
    deliverable: 'research-notes',
  },
  {
    key: 'strategist',
    name: 'Strategy Agent',
    layer: 'decision',
    role: '策略收斂',
    skill: 'tradeoff synthesis / options / next moves',
    scope: '負責比較方案、提出取捨、排序下一步；交付可直接閱讀嘅決策 brief。',
    deliveryMode: 'thinking',
    deliverable: 'decision-brief',
  },
  {
    key: 'synthesis',
    name: 'Synthesis Agent',
    layer: 'delivery',
    role: '文字交付',
    skill: 'summary / research deliverable / handoff',
    scope: '負責將研究同討論收斂成最終文字交付物；唔需要輸出 code、PDF 或 HTML。',
    deliveryMode: 'thinking',
    deliverable: 'text',
  },
  {
    key: 'planner',
    name: 'Planner Agent',
    layer: 'research',
    role: '規劃拆解',
    skill: 'plan decomposition / dependency analysis / vertical slicing',
    scope: '讀 task,將「建造」工作拆成自包含、可獨立驗證嘅 sub-phase,標明依賴同預計改嘅檔案。',
    deliveryMode: 'thinking',
    deliverable: 'plan',
  },
  // ── Swarm Council (三模議會) presets ── 3 reviewer 共用同一 prompt,per-key 指定唔同 model
  {
    key: 'council_a',
    name: 'Council Reviewer A',
    layer: 'research',
    role: '共識評審 A',
    skill: 'critique / improve / dispute-tagging',
    scope: COUNCIL_REVIEWER_SCOPE,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_b',
    name: 'Council Reviewer B',
    layer: 'research',
    role: '共識評審 B',
    skill: 'critique / improve / dispute-tagging',
    scope: COUNCIL_REVIEWER_SCOPE,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_c',
    name: 'Council Reviewer C',
    layer: 'research',
    role: '共識評審 C',
    skill: 'critique / improve / dispute-tagging',
    scope: COUNCIL_REVIEWER_SCOPE,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'moderator',
    name: 'Council Moderator',
    layer: 'decision',
    role: '仲裁收斂',
    skill: 'merge proposals / resolve disputes / rewrite plan',
    scope: COUNCIL_MODERATOR_SCOPE,
    deliveryMode: 'thinking',
    deliverable: 'plan',
  },
  {
    key: 'explainer',
    name: 'Plan Explainer',
    layer: 'delivery',
    role: '人話講解',
    skill: 'plain-language summary / outcome-first',
    scope: COUNCIL_EXPLAINER_SCOPE,
    deliveryMode: 'thinking',
    deliverable: 'text',
  },
];

const ALL_EXECUTION_PRESETS = [...EXECUTION_PRESETS, ...THINKING_PRESETS];

// Load skill content at startup
const SKILL_CACHE = loadSkills();
console.log('[skill-inject] loaded ' + Object.keys(SKILL_CACHE).length + ' / ' + Object.keys(SKILL_REGISTRY).length + ' skills');

// Agent preset key -> list of skill cache keys to inject
const AGENT_SKILL_MAP = {
  planner:     ['architect', 'brainstormers'],
  frontend:    ['typography', 'color', 'layout', 'components', 'taste-skill', 'performance-engineer'],
  backend:     ['architect', 'debugger', 'performance-engineer'],
  test:        ['debugger', 'reviewer-persona'],
  reviewer:    ['reviewer-persona', 'security-auditor', 'refactor-engineer'],
  fixer:       ['debugger', 'refactor-engineer'],
  verifier:    ['debugger', 'reviewer-persona'],
  researcher:  ['brainstormers'],
  strategist:  ['brainstormers', 'architect'],
  synthesis:   ['brainstormers'],
  // Swarm Council — 故意俾 3 reviewer 唔同 skill mix(除咗共有 reviewer-persona),增加博弈視角多樣性
  council_a:   ['brainstormers', 'architect', 'reviewer-persona'],
  council_b:   ['architect', 'reviewer-persona', 'security-auditor'],
  council_c:   ['brainstormers', 'refactor-engineer', 'reviewer-persona'],
  moderator:   ['architect', 'reviewer-persona'],
  explainer:   [],  // 只靠 execution-discipline + tone prompt,免污染人話 tone
};

function getSkillContent(presetKey) {
  const sections = [];
  // 執行紀律 — 鐵則，所有 agent 一律注入（唔理 presetKey），凌駕其他 skill。
  const discipline = SKILL_CACHE['execution-discipline'];
  if (discipline) {
    sections.push('### 執行紀律（鐵則 · 必讀必跟）\n' + discipline);
  }
  const skillKeys = AGENT_SKILL_MAP[presetKey] || [];
  for (const sk of skillKeys) {
    const content = SKILL_CACHE[sk];
    if (content) {
      sections.push('### ' + sk + '\n' + content);
    }
  }
  if (sections.length === 0) return '';
  return '\n\n## Skill Enhancements\n' +
    '以下係你嘅專業技能參考（由 skill system 自動注入）。運用呢啲知識提升你嘅工作質素。\n\n' +
    sections.join('\n\n');
}

app.use('/mirofish-api', (req, res) => {
  const target = new URL(MIROFISH_BACKEND_URL);
  const headers = { ...req.headers, host: target.host };
  delete headers['content-length'];

  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      protocol: target.protocol,
      method: req.method,
      path: req.url || '/',
      headers,
    },
    (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 502;
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        if (value !== undefined) res.setHeader(key, value);
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    console.error('[mirofish-proxy] failed:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'mirofish backend unavailable' });
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
});

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/mirofish/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mirofish', 'index.html'));
});

// Automation Designer (Cronicle-backed) — chat UI + scheduler
app.use('/automation', require('./routes/automation'));

// Mission Controller v2 — handoff plan → coding → refill → review pipeline
if (MISSION_ORCHESTRATOR_ENABLED) {
  app.use('/mission', require('./routes/mission')(io));
} else {
  // Soft-disabled: functionality moved to Swarm Desktop. Set
  // MISSION_ORCHESTRATOR_ENABLED=1 to re-enable. Code is kept intact.
  app.use('/mission/api', (req, res) => res.status(410).json({ error: 'Mission Orchestrator 已停用,功能遷移到 Swarm Desktop。需要回復:MISSION_ORCHESTRATOR_ENABLED=1。' }));
}

fs.mkdirSync(DATA_DIR, { recursive: true });

let store = loadStore();
let saveTimer = null;
const liveJobs = new Map();
// Global concurrency cap so we never overload the VPS with too many CLI processes at once.
const MAX_CONCURRENT = Number(process.env.SWARM_MAX_CONCURRENT || 6);
const spawnQueue = [];
function pumpQueue() {
  while (liveJobs.size < MAX_CONCURRENT && spawnQueue.length) {
    const job = spawnQueue.shift();
    try { job(); } catch (e) { console.error('[queue] launch failed', e.message); }
  }
}
store.runs.forEach(normalizeRun);
reconcileRunsOnBoot();

// On startup the in-memory liveJobs map is empty, so any agent persisted as
// "running" is stale (its child process died with the previous server, or was
// orphaned). Mark those interrupted, try to reap orphan PIDs, and close any
// sessions that were mid-flight so the UI never shows phantom "running" agents.
function reconcileRunsOnBoot() {
  if (process.env.SWARM_NO_RECONCILE === '1') return; // debug/local: keep running agents as-is
  let interrupted = 0;
  let reaped = 0;
  for (const run of store.runs) {
    if (!Array.isArray(run.agents)) continue;
    for (const agent of run.agents) {
      if (agent.status !== 'running') continue;
      if (agent.pid) {
        try {
          process.kill(agent.pid, 0); // throws if not alive
          try { process.kill(agent.pid, 'SIGTERM'); reaped += 1; } catch (_) {}
        } catch (_) { /* already gone */ }
      }
      agent.status = 'interrupted';
      agent.action = '伺服器重啟前中斷';
      agent.summary = '伺服器重啟,呢個 agent 嘅 process 已中斷 — 可重跑。';
      agent.completedAt = new Date().toISOString();
      agent.pid = null;
      interrupted += 1;
    }
    if (Array.isArray(run.sessions)) {
      for (const session of run.sessions) {
        if (session.status === 'running') {
          session.status = 'interrupted';
          session.completedAt = new Date().toISOString();
        }
      }
    }
    if (run.pipeline && Array.isArray(run.pipeline.stages)) {
      let stopped = false;
      run.pipeline.stages.forEach((s) => { if (s.status === 'running') { s.status = 'interrupted'; stopped = true; } });
      if (stopped) run.pipeline.stopped = true;
    }
    if (run.status === 'executing') run.status = 'active';
  }
  if (interrupted) {
    console.log(`[reconcile] ${interrupted} interrupted agent(s) on boot, ${reaped} orphan process(es) reaped`);
    scheduleSave();
  }
}

function loadStore() {
  try {
    if (!fs.existsSync(STATE_FILE)) return freshStore();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 3,
      currentRunId: parsed.currentRunId || null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch (error) {
    console.error('[store] failed to load, starting fresh:', error.message);
    return freshStore();
  }
}

function freshStore() {
  return { version: 3, currentRunId: null, runs: [] };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function saveNow() {
  const payload = JSON.stringify(store, null, 2);
  fs.writeFileSync(STATE_FILE, payload);
}

function id(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function truncate(text, max = MAX_CONTEXT_CHARS) {
  const value = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n...[truncated ${value.length - max} chars]`;
}

function getCurrentRun() {
  const run = store.runs.find((item) => item.id === store.currentRunId) || null;
  if (run) normalizeRun(run);
  return run;
}

function findRunOr404(runId, res) {
  const run = store.runs.find((item) => item.id === runId);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return null;
  }
  normalizeRun(run);
  return run;
}

function normalizeRun(run) {
  if (!run) return run;
  run.layers = LAYERS;
  run.agents = Array.isArray(run.agents) ? run.agents : [];
  run.sessions = Array.isArray(run.sessions) ? run.sessions : [];
  if (run.pipeline === undefined) run.pipeline = null;
  run.agents.forEach((agent) => {
    if (agent.action === undefined) agent.action = '';
    if (agent.model === undefined) agent.model = '';
    if (agent.cli === undefined) agent.cli = '';
    if (agent.pid === undefined) agent.pid = null;
    if (agent.sessionId === undefined) agent.sessionId = null;
  });
  run.edges = Array.isArray(run.edges) ? run.edges : [];
  run.artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  run.contextHistory = Array.isArray(run.contextHistory) ? run.contextHistory : [];
  run.sessionLinks = Array.isArray(run.sessionLinks) ? run.sessionLinks : [];
  run.messages = Array.isArray(run.messages) ? run.messages : [];
  run.proposals = run.proposals || {};
  run.debates = Array.isArray(run.debates) ? run.debates : [];
  run.rebuttals = run.rebuttals || {};
  run.metrics = run.metrics || {};
  run.metrics.layerCounts = layerCounts(run.agents);
  run.projectPath = run.projectPath || DEFAULT_PROJECT_ROOT;
  run.background = typeof run.background === 'string' ? run.background : '';
  run.backgroundSource = run.backgroundSource || (run.background ? 'manual' : '');
  run.taskBrief = typeof run.taskBrief === 'string' ? run.taskBrief : '';
  // 定向幕僚 chat (Phase 1)
  run.chatThread = Array.isArray(run.chatThread) ? run.chatThread : [];
  run.chatModel = run.chatModel || null;
  run.chatProjectPath = run.chatProjectPath || null;
  run.chatBusy = !!run.chatBusy;
  run.missionBrief = run.missionBrief || null;
  return run;
}

function makeAgent(name, layer, role, skill, index, extra = {}) {
  return {
    id: extra.id || id('agent'),
    name,
    layer,
    role,
    skill,
    status: extra.status || 'pending',
    summary: extra.summary || '',
    action: extra.action || '',
    content: extra.content || '',
    logs: extra.logs || '',
    model: extra.model || '',
    cli: extra.cli || '',
    pid: extra.pid || null,
    sessionId: extra.sessionId || null,
    artifactIds: extra.artifactIds || [],
    index,
    startedAt: extra.startedAt || null,
    completedAt: extra.completedAt || null,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Model catalog (which CLI + model each sub-agent can run on) ───
const MODEL_CATALOG = [
  { cli: 'claude', model: 'opus',    label: 'Claude Opus 4.8', short: 'opus',   color: '#c8993f', tier: '旗艦 · 規劃腦' },
  { cli: 'claude', model: 'sonnet',  label: 'Claude Sonnet', short: 'sonnet', color: '#87b7ff', tier: '均衡 · 預設' },
  { cli: 'claude', model: 'haiku',   label: 'Claude Haiku',  short: 'haiku',  color: '#5fb89a', tier: '快 · 輕量' },
  { cli: 'codex',  model: 'gpt-5.5', label: 'Codex gpt-5.5', short: 'codex',  color: '#9aa7b2', tier: 'OpenAI' },
  { cli: 'glm',    model: 'glm-5.1', label: 'GLM 5.1',       short: 'glm',    color: '#b58cff', tier: '實驗', experimental: true },
];

function safeModelFlag(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  if (!/^[a-zA-Z0-9._:/-]{1,60}$/.test(m)) return '';
  return m;
}

function detectDomain(text = '') {
  const value = String(text).toLowerCase();
  if (/(education|school|teacher|student|dse|grading|assessment|rubric|exam|homework|教育|學校|老師|學生|校長|主任|科主任|教育局|評分|評核|考試|功課)/i.test(value)) {
    return 'education';
  }
  if (/(saas|crm|billing|customer|sales|revenue|tenant|subscription|產品|客戶|營收|訂閱)/i.test(value)) {
    return 'product';
  }
  return 'general';
}

function agentBlueprintsForDomain(domain) {
  if (domain === 'education') {
    return [
      ['課程脈絡研究員', 'research', '教育研究', '課程 / DSE / 評核約束'],
      ['數據與流程偵察員', 'research', '系統研究', '資料流 / 現有 workflow / 風險'],
      ['教育局視角', 'stakeholder', '政策持份者', '合規、公平、可審計性'],
      ['校長視角', 'stakeholder', '學校管理', '資源、家長信任、推行節奏'],
      ['科主任視角', 'stakeholder', '科組管理', 'rubric、一致性、老師協作'],
      ['前線老師視角', 'stakeholder', '教學使用者', '批改時間、可操作性、錯判處理'],
      ['學生視角', 'stakeholder', '學習者', '透明度、回饋質素、壓力'],
      ['家長視角', 'stakeholder', '監護者', '信任、私隱、申訴'],
      ['公平性挑戰者', 'debate', '反方挑戰', 'bias、誤判、不同能力學生影響'],
      ['工作量挑戰者', 'debate', '營運挑戰', '老師負擔、培訓、支援成本'],
      ['方案收斂主任', 'decision', '決策整合', '取捨、優先次序、落地步驟'],
      ['Frontend Agent', 'delivery', '前端開發', 'UI / responsive / teacher workflow'],
      ['Backend Agent', 'delivery', '後端開發', 'API / persistence / grading pipeline'],
      ['Test Agent', 'delivery', '測試 / QA', 'rubric cases / regression / smoke checks'],
      ['Reviewer Agent', 'review', '交付覆核', 'code review / pedagogy risk / integration notes'],
      ['安全與私隱覆核', 'review', '安全覆核', '學生資料、權限、audit trail'],
    ];
  }

  if (domain === 'product') {
    return [
      ['Context Mapper', 'research', '需求整理', 'chat summary / constraints'],
      ['Repo Scout', 'research', '系統偵察', 'existing patterns / risk'],
      ['Product Owner', 'stakeholder', '產品視角', 'user value / workflow'],
      ['Customer Voice', 'stakeholder', '客戶視角', 'friction / adoption / support'],
      ['Ops Lead', 'stakeholder', '營運視角', 'process / rollout / support load'],
      ['Risk Analyst', 'stakeholder', '風險視角', 'security / cost / blast radius'],
      ['Frontend Critic', 'debate', '前端挑戰者', 'responsive / state / UX polish'],
      ['Backend Critic', 'debate', '後端挑戰者', 'API / persistence / concurrency'],
      ['Decision Lead', 'decision', '收斂決策', 'priority / scope / next action'],
      ['Frontend Agent', 'delivery', '前端開發', 'UI / responsive / browser verification'],
      ['Backend Agent', 'delivery', '後端開發', 'API / persistence / server workflow'],
      ['Test Agent', 'delivery', '測試 / QA', 'tests / smoke checks / regression risks'],
      ['Reviewer Agent', 'review', '交付覆核', 'code review / risk analysis'],
    ];
  }

  return [
    ['Context Mapper', 'research', 'Chat 史整理', 'session summary / constraints'],
    ['Repo Scout', 'research', 'Codebase 偵察', 'existing patterns / risk'],
    ['Product Owner', 'stakeholder', '產品視角', 'user value / workflow'],
    ['User Advocate', 'stakeholder', '使用者視角', 'friction / UX / clarity'],
    ['Risk Analyst', 'stakeholder', '風險視角', 'security / cost / blast radius'],
    ['Frontend Critic', 'debate', '前端挑戰者', 'responsive / state / UI polish'],
    ['Backend Critic', 'debate', '後端挑戰者', 'API / persistence / concurrency'],
    ['Swarm Lead', 'decision', '收斂決策', 'priority / scope / next action'],
    ['Frontend Agent', 'delivery', '前端開發', 'UI / CSS / responsive / browser verification'],
    ['Backend Agent', 'delivery', '後端開發', 'API / persistence / server workflow'],
    ['Test Agent', 'delivery', '測試 / QA', 'tests / smoke checks / regression risks'],
    ['Reviewer Agent', 'review', '交付覆核', 'code review / risk analysis / integration notes'],
  ];
}

function agentsFromBlueprints(blueprints) {
  return blueprints.map(([name, layer, role, skill], index) => makeAgent(name, layer, role, skill, index + 1));
}

function seedAgents(template = 'cloudcli', contextText = '') {
  if (template === 'stakeholder-sim') {
    return [
      makeAgent('Policy Scout', 'research', '政策研究', 'external signals', 1),
      makeAgent('Market Scout', 'research', '市場研究', 'pricing / supply / demand', 2),
      makeAgent('Operations Scout', 'research', '營運研究', 'logistics / timeline', 3),
      makeAgent('CEO', 'stakeholder', '決策者', 'business pressure', 4),
      makeAgent('Finance Lead', 'stakeholder', '財務', 'cost / ROI', 5),
      makeAgent('Ops Lead', 'stakeholder', '營運', 'execution constraints', 6),
      makeAgent('Customer Voice', 'stakeholder', '使用者代表', 'impact / trust', 7),
      makeAgent('Red Team', 'debate', '反方挑戰', 'failure modes', 8),
      makeAgent('Game Matrix', 'debate', '博弈矩陣', 'stakeholder interactions', 9),
      makeAgent('Decision Lead', 'decision', '總結決策', 'tradeoff synthesis', 10),
      ...EXECUTION_PRESETS.map((preset, i) => makeAgent(preset.name, preset.layer, preset.role, preset.skill, 11 + i)),
    ];
  }

  return agentsFromBlueprints(agentBlueprintsForDomain(detectDomain(contextText)));
}

function autoApplyAgentsFromContext(run, contextText, force = false) {
  if (!run || !contextText) return false;
  if (!force && run.metrics && run.metrics.dynamicAgentSet) return false;
  if (!force && (run.status === 'executing' || run.artifacts.length > 0)) return false;

  const domain = detectDomain(`${run.topic}\n${contextText}`);
  const agents = agentsFromBlueprints(agentBlueprintsForDomain(domain));
  run.agents = agents;
  run.edges = buildDefaultEdges(agents);
  run.layers = LAYERS;
  run.stage = agents.some((agent) => agent.layer === 'research') ? 'research' : 'stakeholder';
  run.metrics = {
    ...(run.metrics || {}),
    layerCounts: layerCounts(agents),
    dynamicAgentSet: domain,
  };
  run.updatedAt = new Date().toISOString();
  scheduleSave();
  return true;
}

function buildDefaultEdges(agents) {
  const byLayer = Object.fromEntries(LAYERS.map((layer) => [layer.id, agents.filter((agent) => agent.layer === layer.id)]));
  const edges = [];
  for (let i = 0; i < LAYERS.length - 1; i += 1) {
    const fromLayer = byLayer[LAYERS[i].id] || [];
    const toLayer = byLayer[LAYERS[i + 1].id] || [];
    fromLayer.forEach((from) => {
      toLayer.forEach((to) => {
        edges.push({ id: id('edge'), from: from.id, to: to.id, type: 'flow' });
      });
    });
  }
  return edges;
}

function layerCounts(agents) {
  return Object.fromEntries(LAYERS.map((layer) => [layer.id, agents.filter((agent) => agent.layer === layer.id).length]));
}

function createRun({ topic, personas, chatContext, sessionId, projectPath, source, template, background, taskBrief, seed } = {}) {
  const now = new Date().toISOString();
  const agents = Array.isArray(personas) && personas.length
    ? personas.map((persona, index) => makeAgent(String(persona), 'stakeholder', 'Persona', 'stakeholder reasoning', index + 1))
    : (seed === false ? [] : seedAgents(template || 'cloudcli', `${topic || ''}\n${chatContext || ''}`));

  const run = {
    id: id('run'),
    version: 3,
    topic: topic || 'CloudCLI Session Swarm',
    source: source || 'manual',
    status: 'active',
    stage: agents.some((agent) => agent.layer === 'research') ? 'research' : 'stakeholder',
    sessionId: sessionId || null,
    projectPath: projectPath ? safeProjectPath(projectPath) : DEFAULT_PROJECT_ROOT,
    background: background || '',
    backgroundSource: background ? 'manual' : '',
    taskBrief: taskBrief || '',
    chatThread: [],
    chatModel: null,
    chatProjectPath: null,
    chatBusy: false,
    missionBrief: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    layers: LAYERS,
    agents,
    sessions: [],
    edges: buildDefaultEdges(agents),
    artifacts: [],
    messages: [],
    contextHistory: [],
    sessionLinks: [],
    proposals: {},
    debates: [],
    synthesis: null,
    rebuttals: {},
    metrics: { layerCounts: layerCounts(agents), executionStarted: 0, executionCompleted: 0 },
  };

  if (chatContext) addContext(run, { context: chatContext, source: 'initial', sessionId, url: null }, false);
  store.runs.unshift(run);
  store.currentRunId = run.id;
  store.runs = store.runs.slice(0, 80);
  scheduleSave();
  return run;
}

function addContext(run, payload, shouldSave = true) {
  const context = truncate(payload.context || payload.text || '');
  if (!context) return null;
  const entry = {
    id: id('ctx'),
    source: payload.source || 'manual',
    sessionId: payload.sessionId || null,
    url: payload.url || null,
    title: payload.title || null,
    hash: hashText(context),
    context,
    instruction: payload.instruction || '',
    createdAt: new Date().toISOString(),
  };

  const duplicate = run.contextHistory.some((item) => item.hash === entry.hash && item.sessionId === entry.sessionId);
  if (duplicate) return null;

  run.contextHistory.push(entry);
  if (entry.sessionId && !run.sessionId) run.sessionId = entry.sessionId;
  if (payload.projectPath && !run.projectPath) run.projectPath = payload.projectPath;
  if (entry.url && !run.sessionLinks.some((item) => item.url === entry.url && item.sessionId === entry.sessionId)) {
    run.sessionLinks.push({ sessionId: entry.sessionId, url: entry.url, title: entry.title, linkedAt: entry.createdAt });
  }
  run.updatedAt = entry.createdAt;
  if (shouldSave) scheduleSave();
  return entry;
}

function addArtifact(run, artifact) {
  const item = {
    id: id('artifact'),
    type: artifact.type || 'note',
    title: artifact.title || 'Untitled artifact',
    content: truncate(artifact.content || '', MAX_LOG_CHARS),
    agentId: artifact.agentId || null,
    createdAt: new Date().toISOString(),
  };
  run.artifacts.unshift(item);
  if (item.agentId) {
    const agent = run.agents.find((candidate) => candidate.id === item.agentId);
    if (agent && !agent.artifactIds.includes(item.id)) agent.artifactIds.push(item.id);
  }
  run.updatedAt = item.createdAt;
  scheduleSave();
  io.emit('artifact-added', { runId: run.id, artifact: item });
  return item;
}

function upsertAgent(run, name, patch = {}) {
  let agent = run.agents.find((item) => item.name === name || item.id === patch.id);
  if (!agent) {
    agent = makeAgent(name, patch.layer || 'stakeholder', patch.role || 'Persona', patch.skill || 'reasoning', run.agents.length + 1, patch);
    run.agents.push(agent);
  }
  Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
  run.metrics.layerCounts = layerCounts(run.agents);
  run.updatedAt = agent.updatedAt;
  scheduleSave();
  return agent;
}

function rebuildEdges(run) {
  run.edges = buildDefaultEdges(run.agents);
  run.metrics.layerCounts = layerCounts(run.agents);
  run.updatedAt = new Date().toISOString();
  scheduleSave();
}

function publicRun(run) {
  if (!run) return freshIdleState();
  return run;
}

function freshIdleState() {
  return {
    id: null,
    version: 3,
    topic: null,
    status: 'idle',
    stage: 'idle',
    layers: LAYERS,
    agents: [],
    sessions: [],
    edges: [],
    artifacts: [],
    messages: [],
    contextHistory: [],
    sessionLinks: [],
    projectPath: DEFAULT_PROJECT_ROOT,
    background: '',
    backgroundSource: '',
    taskBrief: '',
    chatThread: [],
    chatModel: null,
    chatProjectPath: null,
    chatBusy: false,
    missionBrief: null,
    proposals: {},
    debates: [],
    synthesis: null,
    rebuttals: {},
    metrics: { layerCounts: layerCounts([]), executionStarted: 0, executionCompleted: 0 },
  };
}

function safeProjectPath(input) {
  const resolved = path.resolve(input || DEFAULT_PROJECT_ROOT);
  const home = '/home/hugo-orca';
  const blocked = ['/.ssh', '/.Codex', '/.codex', '/.config', '/.npm', '/.local/share'];
  if (!resolved.startsWith(`${home}/`)) {
    throw new Error(`projectPath must stay inside ${home}`);
  }
  if (blocked.some((fragment) => resolved.includes(fragment))) {
    throw new Error('projectPath points at a sensitive folder');
  }
  return resolved;
}

function projectSignals(projectPath) {
  const signals = [];
  const addIfExists = (relative, label) => {
    if (fs.existsSync(path.join(projectPath, relative))) signals.push(label || relative);
  };

  addIfExists('.git', 'git repo');
  addIfExists('package.json');
  addIfExists('pyproject.toml');
  addIfExists('AGENTS.md');
  addIfExists('CLAUDE.md');
  addIfExists('README.md');

  try {
    const packagePath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg.name) signals.push(`package: ${pkg.name}`);
      if (pkg.scripts) signals.push(`npm scripts: ${Object.keys(pkg.scripts).slice(0, 5).join(', ')}`);
    }
  } catch (error) {}

  return signals;
}

function knownProjects() {
  const roots = [
    '/home/hugo-orca/orca-platform-mvp',
    '/home/hugo-orca/services/swarm-server',
  ];
  try {
    fs.readdirSync('/home/hugo-orca', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .forEach((entry) => {
        const candidate = path.join('/home/hugo-orca', entry.name);
        const signals = projectSignals(candidate);
        if (signals.length) roots.push(candidate);
      });
  } catch (error) {}

  return [...new Set(roots)]
    .filter((candidate) => {
      try {
        const resolved = safeProjectPath(candidate);
        return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      } catch (error) {
        return false;
      }
    })
    .map((candidate) => ({
      path: safeProjectPath(candidate),
      label: path.basename(candidate),
      signals: projectSignals(candidate),
    }));
}

function buildAutoBackground(run) {
  const latestContext = run.contextHistory[run.contextHistory.length - 1];
  const signals = projectSignals(run.projectPath || DEFAULT_PROJECT_ROOT);
  return [
    `Auto-generated background for ${run.topic || 'Swarm Session'}`,
    '',
    `Project folder: ${run.projectPath || DEFAULT_PROJECT_ROOT}`,
    signals.length ? `Project signals: ${signals.join(' / ')}` : 'Project signals: none detected yet',
    latestContext ? `Latest context source: ${latestContext.title || latestContext.source || 'context'} (${latestContext.context.length} chars)` : 'Latest context source: none',
    '',
    latestContext
      ? `Context excerpt:\n${truncate(latestContext.context, 3000)}`
      : 'No saved chat context. Ask the user for a task brief before changing code.',
  ].join('\n');
}

function buildAgentCommand(cliName, model) {
  const cli = String(cliName || DEFAULT_AGENT_CLI).trim().toLowerCase();
  const m = safeModelFlag(model);
  if (cli === 'codex') {
    const mflag = m ? ` -m "${m}"` : '';
    return {
      label: 'codex',
      cli: 'codex',
      model: m,
      shell: `cd "$1" && exec codex exec --cd "$1"${mflag} --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox "$2"`,
    };
  }
  if (cli === 'glm') {
    // GLM wrapper script ~/bin/glm — 真 executable，令 non-interactive spawn 搵到（取代舊 ~/.bashrc function；`exec <function>` 行唔通會 127）。Claude-compatible，需 BigModel key。
    const mflag = m ? ` --model "${m}"` : '';
    return {
      label: 'glm',
      cli: 'glm',
      model: m || 'glm-5.1',
      shell: `cd "$1" && exec "$HOME/bin/glm" -p --permission-mode bypassPermissions${mflag} "$2"`,
    };
  }
  const mflag = m ? ` --model "${m}"` : '';
  return {
    label: 'claude',
    cli: 'claude',
    model: m,
    shell: `cd "$1" && exec claude -p --permission-mode bypassPermissions${mflag} "$2"`,
  };
}

// ─── 定向幕僚 chat helpers (Phase 1) ───
function pushChatMessage(run, partial) {
  const msg = {
    id: id('chat'),
    role: partial.role || 'assistant',
    content: truncate(partial.content || '', MAX_CHAT_MSG_CHARS),
    model: partial.model || '',
    cli: partial.cli || '',
    ts: new Date().toISOString(),
    usedProjectPath: partial.usedProjectPath || null,
    durationMs: partial.durationMs || null,
    status: partial.status || 'ok',
    error: partial.error || null,
  };
  if (!Array.isArray(run.chatThread)) run.chatThread = [];
  run.chatThread.push(msg);
  if (run.chatThread.length > MAX_CHAT_TURNS) run.chatThread = run.chatThread.slice(-MAX_CHAT_TURNS);
  run.updatedAt = msg.ts;
  scheduleSave();
  return msg;
}

function resolveChatModel(run, override) {
  if (override && typeof override === 'object' && override.model) {
    return { cli: override.cli || 'claude', model: safeModelFlag(override.model) };
  }
  if (typeof override === 'string' && override) {
    const hit = MODEL_CATALOG.find((m) => m.model === override || m.short === override);
    if (hit) return { cli: hit.cli, model: hit.model };
  }
  if (run.chatModel && run.chatModel.model) return run.chatModel;
  return { cli: 'claude', model: 'sonnet' };
}

function stripChatNoise(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')        // ANSI escape
    .replace(/^\[swarm-[^\]]*\][^\n]*$/gm, '')      // 自家 log 行
    .trim();
}

const CHAT_PROMPT_MAX_CHARS = 90000; // 控 argv $2 長度(Linux MAX_ARG_STRLEN ~128KB)
function buildChatPrompt(run, chatCwd, finalize) {
  const head = [
    '你係 Swarm Dashboard 嘅「策劃幕僚」,同用戶一對一傾偈,用繁體中文 / 廣東話。',
    '目標:透過多回合對話,幫用戶由模糊念頭收斂成一份清晰、可執行嘅 mission brief(之後交俾三模議會落地)。',
    '風格:精簡、直接、追問最關鍵嘅缺口;唔肯定就問,唔好自己亂作 plan 細節。',
  ];
  if (chatCwd) head.push(
    '',
    `用戶揀咗一個 project:${chatCwd}`,
    '你而家身處呢個 project 根目錄,可以用 Read / Bash(ls/cat/grep/git log)查實際文件先答,唔好淨係靠估。引用文件寫清楚 path。brainstorm 階段唔好改任何 file。'
  );
  head.push('', `Run topic:${run.topic || '(未定)'}`, '', '──────── 對話紀錄 ────────');
  let convo = (run.chatThread || []).map((m) => {
    const who = m.role === 'user' ? '【用戶】' : (m.role === 'assistant' ? '【幕僚（你）】' : '【系統】');
    return `${who}\n${m.content}`;
  }).join('\n\n');
  if (convo.length > CHAT_PROMPT_MAX_CHARS) convo = '…(略去較舊對話)…\n\n' + convo.slice(-CHAT_PROMPT_MAX_CHARS);
  const tail = finalize
    ? '\n──────── 請將以上對話收斂成一份完整 mission brief markdown ────────\n結構:## 目標 / ## 範圍同約束 / ## 建議步驟 / ## 風險 / ## 成功標準。淨係輸出 markdown 本身,前後唔好加客套說話。'
    : '\n──────── 請你(幕僚)回覆最新一條用戶訊息 ────────';
  return [head.join('\n'), convo, tail].join('\n');
}

// 獨立 chat spawner:唔行 spawnAgentNow/session/pipeline,唔掂 run.status/metrics(故 chat 唔會觸發 pipeline auto-advance)。
// prompt 經 argv $2(同 agent 一致),靠 CHAT_PROMPT_MAX_CHARS 控長度。
function spawnChatTurn(run, picked, chatCwd, finalize) {
  return new Promise((resolve, reject) => {
    const cmd = buildAgentCommand(picked.cli, picked.model);
    const prompt = buildChatPrompt(run, chatCwd, finalize);
    let cwd;
    try { cwd = chatCwd ? safeProjectPath(chatCwd) : safeProjectPath(SWARM_WORKSPACE); }
    catch (e) { return reject(new Error('cwd 無效: ' + e.message)); }
    io.emit('chat-thinking', { runId: run.id, on: true, model: picked.model, finalize: !!finalize });
    const started = Date.now();
    let out = '', err = '', killed = false;
    const child = spawn('bash', ['-ic', cmd.shell, 'swarm-chat', cwd, prompt], {
      cwd, env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }, CHAT_TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); io.emit('chat-thinking', { runId: run.id, on: false }); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      io.emit('chat-thinking', { runId: run.id, on: false });
      const durationMs = Date.now() - started;
      if (killed) return reject(new Error(`思考超時(${Math.round(CHAT_TIMEOUT_MS / 1000)}s)`));
      if (code !== 0) return reject(new Error(`${cmd.label} exit ${code}: ${stripChatNoise(err || out).slice(-300)}`));
      resolve({ text: stripChatNoise(out) || '(冇輸出)', durationMs, cli: picked.cli, model: picked.model });
    });
  });
}

// ─── Sessions (Plan → Session → Agent nesting) ───
function createSession(run, { title, kind, model, cli } = {}) {
  if (!Array.isArray(run.sessions)) run.sessions = [];
  const cmd = buildAgentCommand(cli, model);
  const session = {
    id: id('session'),
    title: title || (kind ? `${kind} session` : 'Execution session'),
    kind: kind || 'code',
    cli: cmd.label,
    model: cmd.model || '',
    status: 'running',
    agentIds: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  run.sessions.unshift(session);
  return session;
}

// Barrier after a parallel code wave: merge each agent's worktree back into the
// main repo serially, then clean up. Clean merge → kept; conflict → keep the
// branch + warn (no half-merge) so the next stage still builds on a solid HEAD.
function mergeSessionWorktrees(run, session) {
  const repo = safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT);
  for (const wt of session.worktrees) {
    try {
      worktreeMgr.commitWorktree({ dir: wt.dir, message: `swarm ${run.id} ${wt.key}` });
      const merge = worktreeMgr.mergeWorktree({ repo, branch: wt.branch, message: `swarm ${run.id}: merge ${wt.key}` });
      worktreeMgr.removeWorktree({ repo, dir: wt.dir, branch: merge.conflict ? null : wt.branch });
      if (!merge.ok && merge.conflict) {
        addArtifact(run, {
          type: 'execution-error',
          title: `Worktree merge 撞 file: ${wt.key}`,
          content: `衝突檔案: ${(merge.conflictFiles || []).join(', ') || '(未知)'}\n已 abort merge（主 repo 保持乾淨）。${wt.key} 嘅改動留喺 branch \`${wt.branch}\`,可手動 merge。`,
        });
      }
    } catch (e) {
      addArtifact(run, { type: 'execution-error', title: `Worktree 處理失敗: ${wt.key}`, content: e.message });
    }
  }
  session.worktreesMerged = true;
}

function updateSessionStatus(run, sessionId) {
  if (!sessionId) return;
  const session = (run.sessions || []).find((item) => item.id === sessionId);
  if (!session) return;
  const agents = run.agents.filter((agent) => agent.sessionId === sessionId);
  // "active" = still running OR queued (pending = waiting for a concurrency slot).
  const active = agents.some((agent) => agent.status === 'running' || agent.status === 'pending');
  const anyFailed = agents.some((agent) => agent.status === 'failed' || agent.status === 'interrupted');
  const justFinished = (!active && session.status === 'running');
  if (justFinished) {
    session.status = anyFailed ? 'failed' : 'complete';
    session.completedAt = new Date().toISOString();
    if (SWARM_WORKTREE && Array.isArray(session.worktrees) && session.worktrees.length) {
      mergeSessionWorktrees(run, session);
    }
  }
  io.emit('session-updated', { runId: run.id, session });
  if (justFinished) maybeAdvancePipeline(run, session);
}

// When a pipeline stage's session finishes, auto-start the next stage (staged fan-out).
// Parse the planner agent's ```subphases JSON block from its logs.
function parsePlannerSubphases(run, session) {
  const agents = run.agents.filter((a) => a.sessionId === session.id);
  const planner = agents.find((a) => a.layer === 'research') || agents[0];
  const logs = (planner && planner.logs) || '';
  const m = logs.match(/```subphases\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    return Array.isArray(parsed.phases) && parsed.phases.length ? parsed.phases : null;
  } catch {
    return null;
  }
}

// Turn planner sub-phases into dependency-ordered build wave stages, each with
// dynamic per-sub-phase agents (worktree-isolated when a wave has >1).
function generateBuildWaves(phases) {
  const subPhases = phases.map((p, i) => ({
    id: String(p.id || `p${i + 1}`),
    title: String(p.title || `Sub-phase ${i + 1}`),
    scope_md: String(p.scope_md || p.scope || ''),
    dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
    estFiles: Array.isArray(p.est_files) ? p.est_files : (Array.isArray(p.estFiles) ? p.estFiles : []),
  }));
  let plan;
  try {
    plan = planWaves(subPhases, { maxConcurrency: SWARM_PLAN_MAX_PARALLEL });
  } catch (e) {
    return { error: e.message, stages: [] };
  }
  const byId = new Map(subPhases.map((sp) => [sp.id, sp]));
  const stages = plan.waves.map((wave, wi) => ({
    key: `build-w${wi + 1}`,
    title: `建造 Build · wave ${wi + 1}`,
    kind: 'code',
    deliveryMode: 'code',
    status: 'pending',
    sessionId: null,
    dynamicAgents: wave.map((spStub) => {
      const sp = byId.get(spStub.id) || spStub;
      return {
        key: `build-${sp.id}`,
        name: `Build ${sp.id}: ${sp.title}`.slice(0, 58),
        layer: 'delivery',
        role: '建造',
        skill: 'targeted implementation per sub-phase scope',
        scope: '按下面 sub-phase scope 實作,只做你 scope 範圍內嘅嘢,避免改其他 sub-phase 嘅檔案。',
        subScope: sp.scope_md,
        deliveryMode: 'code',
      };
    }),
  }));
  return { stages, warnings: plan.warnings };
}

// Read the reviewer agent's PASS/WARN/FAIL verdict from its logs. No explicit
// verdict → WARN (conservative: run one fix pass rather than blindly accepting).
function parseVerdict(run, session) {
  const agents = run.agents.filter((a) => a.sessionId === session.id);
  const reviewer = agents.find((a) => a.layer === 'review') || agents[0];
  const logs = (reviewer && reviewer.logs) || '';
  const m = logs.match(/VERDICT\s*[:：]?\s*[`'"]?\s*(PASS|WARN|FAIL)/i)
    || logs.match(/\*\*\s*Verdict\s*\*\*\s*[:：]?\s*[`'"]?\s*(PASS|WARN|FAIL)/i);
  return m ? m[1].toUpperCase() : 'WARN';
}

// ─── Swarm Council parsers + plan IO (三模議會) ───
// 讀最新一版 plan(plan.vN.md);冇就 fallback brief.md → run.taskBrief。
function readLatestPlan(run) {
  const dir = COUNCIL_DIR(run.id);
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^plan\.v\d+\.md$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (files.length) {
      const last = files[files.length - 1];
      return { v: Number(last.match(/\d+/)[0]), md: fs.readFileSync(path.join(dir, last), 'utf8') };
    }
  } catch (_) {}
  try { return { v: 0, md: fs.readFileSync(path.join(dir, 'brief.md'), 'utf8') }; } catch (_) {}
  return { v: 0, md: run.taskBrief || run.background || '' };
}

function writeCouncilPlan(run, version, md) {
  const dir = COUNCIL_DIR(run.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `plan.v${version}.md`), md || '');
  } catch (e) {
    console.warn('[council] writeCouncilPlan failed:', e.message);
  }
}

// 由 consensus session 嘅 reviewer logs 抽 CONSENSUS + OPEN_ISSUES。只 map 有 logs 嘅 agent →
// glm 等 fail 咗就自動 degrade(在席者照計)。
function parseCouncilReviews(run, session) {
  const agents = run.agents.filter((a) => a.sessionId === session.id);
  return agents.map((a) => {
    const logs = a.logs || '';
    const verdict = (logs.match(/CONSENSUS\s*[:：]\s*(AGREE|DISPUTE)/i) || [])[1] || 'DISPUTE';
    const issues = (logs.match(/OPEN_ISSUES:\s*\n([\s\S]*?)(?:\nPROPOSED_CHANGES:|\n```|$)/i) || [, ''])[1];
    return {
      name: a.name, model: a.model || '',
      agree: /AGREE/i.test(verdict),
      failed: a.status === 'failed' || a.status === 'interrupted',
      issuesRaw: (issues || '').trim(), logs,
    };
  });
}

// 由 moderator session 抽 plan-final 全文 + 收斂判定(CONVERGED + OPEN_DISPUTES)。
function parseModerator(run, session) {
  const agents = run.agents.filter((a) => a.sessionId === session.id);
  const mod = agents.find((a) => a.layer === 'decision') || agents[0];
  const logs = (mod && mod.logs) || '';
  const planMd = (logs.match(/```plan-final\s*\n([\s\S]*?)\n```/) || [, ''])[1].trim();
  const converged = /COUNCIL\s*[:：]\s*CONVERGED/i.test(logs);
  const openMatch = logs.match(/OPEN_DISPUTES\s*[:：]\s*(\d+)/i);
  const openDisputes = openMatch ? Number(openMatch[1]) : (converged ? 0 : 99);
  const disputes = (logs.match(/DISPUTES:\s*\n([\s\S]*?)$/i) || [, ''])[1].trim();
  return { planMd, converged, openDisputes, disputes, logs };
}

// Re-run the review stage after a fix pass (reset review + fix stages to pending,
// rewind current so advancePipeline re-enters review).
function loopBackToReview(run, p) {
  const reviewIdx = p.stages.findIndex((s) => s.gate);
  if (reviewIdx < 0) { p.gateDone = true; advancePipeline(run); return; }
  // Time-budget guard: if the pipeline already ran too long, stop looping and
  // finish — don't keep burning fix sessions.
  if (SWARM_GATE_TIME_BUDGET_MS > 0) {
    const elapsed = Date.now() - new Date(p.startedAt).getTime();
    if (elapsed > SWARM_GATE_TIME_BUDGET_MS) {
      p.gateDone = true;
      p.stages.forEach((s) => { if (s.isFix) { s.agentKeys = []; s.status = 'skipped'; } });
      addArtifact(run, { type: 'note', title: '⏱ 覆核 Gate: 時間預算用盡', content: `已跑 ${Math.round(elapsed / 60000)} 分鐘,停止 fix loop,剩餘問題人手跟進。` });
      advancePipeline(run);
      return;
    }
  }
  for (let i = reviewIdx; i < p.stages.length; i += 1) {
    p.stages[i].status = 'pending';
    p.stages[i].sessionId = null;
  }
  p.current = reviewIdx - 1;
  addArtifact(run, {
    type: 'note',
    title: `🔁 覆核 Gate: ${p.gateVerdict} → 第 ${p.gateIteration} 次修正後 re-review`,
    content: `Reviewer 裁決 ${p.gateVerdict},已跑 fix,重新覆核（iteration ${p.gateIteration}/${p.maxGateIterations}）。`,
  });
  advancePipeline(run);
}

// ─── Swarm Council 收斂引擎 (三模議會) ───
// consensus wave 完 → 砌 moderator input(plan + 三人全文) → 行 moderator;
// moderator wave 完 → 寫 plan vN、判收斂(CONVERGED 且 未解==0)/rewind 再 round/pause 交人手。
function advanceCouncil(run, p, stage, session) {
  p.councilRound = p.councilRound || 1;

  // (A) consensus wave 完 → moderator
  if (stage.kind === 'consensus') {
    stage.status = 'complete';
    const reviews = parseCouncilReviews(run, session);
    stage.reviews = reviews.map((r) => ({ name: r.name, model: r.model, agree: r.agree, failed: r.failed }));
    const present = reviews.filter((r) => !r.failed && r.logs.trim());
    const plan = readLatestPlan(run);
    // 把每位評審完整輸出寫去 file → moderator 用 Read 讀全文(避免 taskBrief argv 上限截斷而丟失 reviewer)。
    const cdir = COUNCIL_DIR(run.id);
    const reviewFiles = [];
    try {
      fs.mkdirSync(cdir, { recursive: true });
      present.forEach((r, i) => {
        const fn = `round-${p.councilRound}-reviewer-${i + 1}.md`;
        fs.writeFileSync(path.join(cdir, fn), `# ${r.name}${r.model ? ` (${r.model})` : ''}\n\n${r.logs}`);
        reviewFiles.push({ name: r.name, model: r.model, path: path.join(cdir, fn) });
      });
    } catch (e) { console.warn('[council] write review files failed:', e.message); }
    run.taskBrief = truncate(
      `## Goal\n${run.background || run.topic || ''}\n\n## 當前 Plan (v${plan.v})\n${plan.md}\n\n` +
      `## 三位評審今 round 完整輸出（已各自寫去 file）\n你**必須逐個用 Read tool 讀晒以下每個 file 全文先 merge**，唔好淨係靠下面摘要（摘要只係索引，會缺料）：\n` +
      reviewFiles.map((f) => `- ${f.name}${f.model ? ` (${f.model})` : ''}: \`${f.path}\``).join('\n') +
      (present.length < reviews.length ? `\n(註:${reviews.length - present.length} 位評審缺席/失敗,照 merge 在席者)` : '') +
      `\n\n## 各評審摘要（索引用，完整內容請 Read 上面 file）\n` +
      present.map((r) => `### ${r.name}${r.model ? ` (${r.model})` : ''}\n${truncate(r.logs, 1800)}`).join('\n\n'),
      MAX_CONTEXT_CHARS);
    // 第一輪三模獨立 review 完 → 停低俾用戶睇齊三份 + 撳「開始拗」先入辯論收斂
    if (p.councilRound === 1 && !p.councilDebateStarted) {
      pauseForReviewGate(run, p, reviews);
      return;
    }
    advancePipeline(run);
    return;
  }

  // (B) moderator wave 完 → 寫 plan vN、判收斂
  stage.status = 'complete';
  const mod = parseModerator(run, session);
  const nextV = (readLatestPlan(run).v || 0) + 1;
  if (mod.planMd) { writeCouncilPlan(run, nextV, mod.planMd); p.councilPlanVersion = nextV; }
  p.councilOpenDisputes = mod.openDisputes;
  p.councilDisputes = mod.disputes;
  addArtifact(run, {
    type: 'note',
    title: `🗳 共識 Round ${p.councilRound}/${SWARM_COUNCIL_MAX_ROUNDS} → plan v${p.councilPlanVersion}`,
    content: `未解爭議: ${mod.openDisputes}\n${mod.disputes || '(none)'}${mod.planMd ? '' : '\n⚠ moderator 未輸出 plan-final block,沿用上一版。'}`,
  });

  const converged = mod.converged && mod.openDisputes === 0;
  const maxedOut = p.councilRound >= SWARM_COUNCIL_MAX_ROUNDS;
  const overBudget = SWARM_COUNCIL_TIME_BUDGET_MS > 0 &&
    (Date.now() - new Date(p.startedAt).getTime()) > SWARM_COUNCIL_TIME_BUDGET_MS;
  if (converged || maxedOut || overBudget) {
    pauseForHumanGate(run, p, { converged, maxedOut, overBudget });
    return;
  }

  // 未收斂 → rewind consensus+moderator stage,round+1,plan vN 做下一 round input
  p.councilRound += 1;
  const cIdx = p.stages.findIndex((s) => s.kind === 'consensus');
  for (let i = cIdx; i < p.stages.length && ['consensus', 'moderator'].includes(p.stages[i].kind); i += 1) {
    p.stages[i].status = 'pending';
    p.stages[i].sessionId = null;
  }
  const plan = readLatestPlan(run);
  run.taskBrief = truncate(
    `## Goal\n${run.background || run.topic || ''}\n\n## 要評審嘅當前 Plan (v${plan.v})\n${plan.md}\n\n` +
    `## 上一 round 未解爭議(請優先處理 / 表態)\n${mod.disputes || '(none)'}`,
    MAX_CONTEXT_CHARS);
  p.current = cIdx - 1;
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
}

// Phase 3 御准閘:收斂(或用盡 round)後停低,唔自動 advance,等用戶撳批准 / 再改。
function pauseForHumanGate(run, p, why) {
  p.stopped = true;
  p.councilPaused = true;
  const plan = readLatestPlan(run);
  const reason = why.converged ? '三模零爭議收斂'
    : (why.maxedOut ? `用盡 ${SWARM_COUNCIL_MAX_ROUNDS} round` : '時間預算用盡');
  addArtifact(run, {
    type: 'council-gate',
    title: `⏸ 御准閘:${reason}（plan v${p.councilPlanVersion}）`,
    content: `# Plan 終稿 v${p.councilPlanVersion}\n\n${plan.md}\n\n---\n## 未解爭議 (${p.councilOpenDisputes == null ? 0 : p.councilOpenDisputes})\n${p.councilDisputes || '(無 — 全部收斂)'}\n\n_撳「✅ 批准」出人話講解,或「✍️ 再改」加指示重跑一 round。_`,
  });
  run.status = 'active';
  io.emit('run-updated', publicRun(run));
  io.emit('council-paused', { runId: run.id, planVersion: p.councilPlanVersion, openDisputes: p.councilOpenDisputes });
  scheduleSave();
}

// Review 閘:第一輪三模獨立 review(每個自己掃 project + plan)完,停低俾用戶睇齊三份,
// 撳「開始拗」先入 moderator + 辯論收斂。
function pauseForReviewGate(run, p, reviews) {
  p.stopped = true;
  p.councilReviewPaused = true;
  const body = reviews.map((r) => {
    const head = `### ${r.name}${r.model ? ` · ${r.model}` : ''}${r.failed ? ' ⚠(缺席/失敗)' : ''} — ${r.agree ? '同意' : '有異議'}`;
    const txt = (r.logs || '').trim().slice(-3000) || '(冇輸出)';
    return `${head}\n\n${txt}`;
  }).join('\n\n---\n\n');
  addArtifact(run, {
    type: 'council-review-gate',
    title: `🔎 三模獨立 review（${reviews.length} 份）— 撳「開始拗」入辯論`,
    content: `# 三模獨立 review\n三個 model 各自掃過 project + plan,以下係佢哋嘅獨立評審。睇完撳「🥊 開始拗」,佢哋就會互相挑戰、收斂改 plan。\n\n${body}`,
  });
  run.status = 'active';
  io.emit('run-updated', publicRun(run));
  io.emit('council-review-paused', { runId: run.id, reviewCount: reviews.length });
  scheduleSave();
}

function maybeAdvancePipeline(run, session) {
  const p = run.pipeline;
  if (!p || p.stopped || !Array.isArray(p.stages) || !p.stages[p.current]) return;
  const stage = p.stages[p.current];
  if (stage.sessionId !== session.id) return;
  stage.status = session.status;
  if (session.status === 'failed' && !p.continueOnFail) {
    p.stopped = true;
    addArtifact(run, { type: 'execution-error', title: `Pipeline 喺「${stage.title}」中止`, content: '呢個 stage 有 agent 失敗,pipeline 已停。可重跑該 agent 或手動續行。' });
    run.status = 'active';
    io.emit('run-updated', publicRun(run));
    scheduleSave();
    return;
  }

  // ── Swarm Council consensus loop (三模議會):consensus → moderator → 收斂/rewind/pause ──
  if (p.mode === 'council' && (stage.kind === 'consensus' || stage.kind === 'moderator')) {
    advanceCouncil(run, p, stage, session);
    return;
  }

  // ── Plan decompose: planner output → dynamic build waves spliced after plan ──
  if (SWARM_PLAN_DECOMPOSE && stage.decompose && !stage.decomposed) {
    stage.decomposed = true;
    const fixedBuild = { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: ['frontend', 'backend', 'test'], status: 'pending', sessionId: null };
    const phases = parsePlannerSubphases(run, session);
    if (!phases) {
      addArtifact(run, { type: 'execution-error', title: '⚠ Planner 拆解失敗', content: 'Planner 冇輸出有效 subphases JSON,fallback 用固定 build (frontend/backend/test)。' });
      p.stages.splice(p.current + 1, 0, fixedBuild);
    } else {
      const gen = generateBuildWaves(phases);
      if (gen.error || !gen.stages.length) {
        addArtifact(run, { type: 'execution-error', title: '⚠ 波次規劃失敗', content: `${gen.error || '冇 wave'},fallback 固定 build。` });
        p.stages.splice(p.current + 1, 0, fixedBuild);
      } else {
        p.stages.splice(p.current + 1, 0, ...gen.stages);
        addArtifact(run, {
          type: 'note',
          title: `🧩 Planner 拆咗 ${phases.length} 個 sub-phase → ${gen.stages.length} 波並行`,
          content: gen.stages.map((s, i) => `Wave ${i + 1}: ${s.dynamicAgents.map((a) => a.name).join(', ')}`).join('\n'),
        });
      }
    }
    advancePipeline(run);
    return;
  }

  // ── Review gate loop: PASS skips fix; WARN/FAIL runs fix then re-reviews ──
  if (SWARM_REVIEW_GATE && !p.gateDone) {
    if (stage.gate) {
      const verdict = parseVerdict(run, session);
      p.gateVerdict = verdict;
      stage.verdict = verdict;
      // soft (default): only FAIL loops a fix pass; WARN is accepted as-is.
      // strict (SWARM_REVIEW_GATE_STRICT=1): WARN also loops. This is the main
      // guard against the slow multi-iteration fix storms (WARN ≠ must-fix).
      const needsFix = verdict === 'FAIL' || (SWARM_REVIEW_GATE_STRICT && verdict === 'WARN');
      if (!needsFix) {
        p.gateDone = true;
        p.stages.forEach((s) => { if (s.isFix) { s.agentKeys = []; s.status = 'skipped'; } });
        addArtifact(run, {
          type: 'note',
          title: `✅ 覆核 Gate: ${verdict}（接受）`,
          content: verdict === 'PASS' ? 'Reviewer 裁定 PASS,跳過修正。' : 'WARN — soft 模式接受,跳過修正（FAIL 先會 loop fix；要嚴格就開 SWARM_REVIEW_GATE_STRICT）。',
        });
        advancePipeline(run);
        return;
      }
      // needsFix → fall through → advancePipeline runs the fix stage.
    } else if (stage.isFix) {
      p.gateIteration = (p.gateIteration || 0) + 1;
      if (p.gateIteration < p.maxGateIterations) {
        loopBackToReview(run, p);
        return;
      }
      p.gateDone = true;
      addArtifact(run, {
        type: 'note',
        title: `⚠ 覆核 Gate: 用盡 ${p.maxGateIterations} 次修正`,
        content: `最後裁決 ${p.gateVerdict || '-'}。pipeline 完成,剩餘問題請人手跟進。`,
      });
    }
  }

  advancePipeline(run);
}

const PLANNER_DECOMPOSE_PROMPT = [
  '',
  '## 你嘅任務:拆 build sub-phase（必須,最重要）',
  '讀上面 task brief / background,將「建造」工作拆成 1-6 個自包含 sub-phase。',
  '每個 sub-phase 會交俾一個獨立 build agent 並行做,所以:',
  '- scope_md 必須自包含（build agent 唔會見到原 task,淨係見你寫嘅 scope_md）',
  '- 按模組 / 檔案邊界拆,盡量唔好兩個 sub-phase 改同一個 file（會撞,拖慢）',
  '- 無依賴嘅 sub-phase 會並行；B 要用 A 嘅成果就喺 dependencies 寫 ["A"]',
  '- 細 task 出 1 個 phase 就夠,唔好硬拆',
  '',
  '只輸出一個 ```subphases code block,純 JSON,前後唔好加其他文字:',
  '```subphases',
  '{"phases":[{"id":"p1","title":"≤40字標題","scope_md":"完整自包含建造說明:做乜/deliverable/success criteria","dependencies":[],"est_files":["src/foo.js"]}]}',
  '```',
].join('\n');

function buildExecutionPrompt(run, preset, agent, options = {}) {
  const contexts = run.contextHistory
    .slice(-3)
    .map((ctx, index) => `### Chat Context ${index + 1}\n${ctx.context}`)
    .join('\n\n');
  const artifacts = run.artifacts
    .slice(0, 5)
    .map((artifact) => `- ${artifact.title} (${artifact.type})`)
    .join('\n');
  const deliveryMode = options.deliveryMode || preset.deliveryMode || run.metrics.deliveryMode || 'code';
  const deliverable = options.deliverable || preset.deliverable || run.metrics.deliverable || (deliveryMode === 'thinking' ? 'text' : 'code');
  const isThinkingMode = ['thinking', 'research', 'text'].includes(String(deliveryMode));
  const background = run.background || buildAutoBackground(run);
  const taskBrief = run.taskBrief || options.taskBrief || '';

  return [
    `你係 CloudCLI Agent Swarm V3 嘅 execution sub-agent：${preset.name}。`,
    `你嘅角色：${preset.role}`,
    `你嘅技能範圍：${preset.skill}`,
    `你嘅責任邊界：${preset.scope}`,
    `今次工作模式：${deliveryMode}`,
    `預期交付物：${deliverable}`,
    '',
    '重要工作方式：',
    '- 你唔係獨自一個喺 codebase，可能有其他 agent 同時工作。',
    '- 不要 revert 其他人或其他 agent 嘅改動。',
    isThinkingMode
      ? '- 今次係思考 / 研究 / 文字交付：不要改 code、不要產生 PDF / HTML，除非題目明確要求。'
      : '- 盡量做你責任範圍內嘅實際工作；需要改 code 就直接改。',
    isThinkingMode
      ? '- 請交付可閱讀嘅文字結果：重點結論、理據、風險、可選下一步；需要時用表格或 bullets。'
      : '- 若有測試或驗證方法，完成後請執行並回報結果。',
    isThinkingMode
      ? ''
      : '- 修正紀律（重要）：完成主要工作後，最多做「一輪」自我 review + 修正就收手。唔好為咗清零散 warning 而無限重試 / 反覆改同一個位（呢樣會拖慢成個流程）。一輪之後若仲有未解決嘅 warning / 風險，唔好繼續鑽，直接喺回報度列出「剩低咩、點解、建議下一步」，留俾 Reviewer / Fix stage 處理。',
    '- 避免觸碰 secrets、SSH key、credentials、billing、安全設定。',
    '- 完成後用繁體中文 / 廣東話簡潔回報：改咗乜、測試結果、剩低風險。',
    '',
    `Swarm Run: ${run.id}`,
    `Topic: ${run.topic}`,
    `Project Path: ${run.projectPath}`,
    '',
    '## Background',
    background,
    '',
    '## This Run Task Brief',
    taskBrief || '未有手動任務說明。請先根據 Background / Chat Context 做保守分析；除非題目明確要求，不要主動改 code。',
    '',
    artifacts ? `Existing artifacts:\n${artifacts}` : 'Existing artifacts: none yet',
    contexts || 'Chat Context: 暫時未收到 CloudCLI chat context。',
      getSkillContent(preset.key),
    ...(options.gate ? [[
      '',
      '## 覆核裁決（必須）',
      '完成 review 之後,喺回報最後**獨立一行**輸出裁決:',
      '`VERDICT: PASS` = 冇問題,可收貨',
      '`VERDICT: WARN` = 有小問題但可接受',
      '`VERDICT: FAIL` = 有必須修嘅問題',
      'WARN / FAIL 時請具體列出要修嘅項目,俾 Fix agent 跟進。',
    ].join('\n')] : []),
    ...(preset.key === 'planner' ? [PLANNER_DECOMPOSE_PROMPT] : []),
  ].join('\n');
}

function appendAgentLog(run, agent, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  agent.logs = `${agent.logs || ''}${text}`;
  if (agent.logs.length > MAX_LOG_CHARS) {
    agent.logs = `...[trimmed]\n${agent.logs.slice(-MAX_LOG_CHARS)}`;
  }
  // Derive a short "current action" from the latest meaningful log line (strip ANSI).
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((line) => line && !line.startsWith('[swarm-server]'));
  if (lines.length) agent.action = lines[lines.length - 1].slice(0, 160);
  agent.updatedAt = new Date().toISOString();
  run.updatedAt = agent.updatedAt;
  io.emit('execution-agent-log', { runId: run.id, agentId: agent.id, chunk: text.slice(-4000), action: agent.action });
  scheduleSave();
}

function startOneExecutionAgent(run, preset, options = {}) {
  let agent = run.agents.find((candidate) => candidate.name === preset.name);
  if (!agent) {
    agent = makeAgent(preset.name, preset.layer, preset.role, preset.skill, run.agents.length + 1);
    run.agents.push(agent);
  }
  if (liveJobs.has(agent.id)) return agent;

  const agentCommand = buildAgentCommand(options.cli || process.env.SWARM_AGENT_CLI, options.model);
  const session = options.session || null;
  agent.cli = agentCommand.label;
  agent.model = agentCommand.model || '';
  agent.completedAt = null;
  if (options.worktree) agent.worktree = options.worktree;
  if (session) {
    agent.sessionId = session.id;
    if (!session.agentIds.includes(agent.id)) session.agentIds.push(agent.id);
  }

  const launch = () => {
    try {
      spawnAgentNow(run, preset, agent, agentCommand, options);
    } catch (e) {
      agent.status = 'failed';
      agent.summary = e.message;
      agent.action = `啟動失敗:${e.message}`.slice(0, 160);
      agent.completedAt = new Date().toISOString();
      agent.pid = null;
      io.emit('execution-agent-complete', { runId: run.id, agent });
      updateSessionStatus(run, agent.sessionId);
      io.emit('run-updated', publicRun(run));
      pumpQueue();
    }
  };
  if (liveJobs.size >= MAX_CONCURRENT) {
    // Over the concurrency cap → queue it; show as waiting until a slot frees up.
    agent.status = 'pending';
    agent.action = `排隊中…（並發上限 ${MAX_CONCURRENT}）`;
    agent.summary = '排隊等候執行 slot';
    agent.startedAt = null;
    spawnQueue.push(launch);
    scheduleSave();
    io.emit('execution-agent-started', { runId: run.id, agent });
    io.emit('run-updated', publicRun(run));
  } else {
    launch();
  }
  return agent;
}

function spawnAgentNow(run, preset, agent, agentCommand, options = {}) {
  if (liveJobs.has(agent.id)) return;
  const fake = process.env.SWARM_FAKE_AGENT === '1';
  const isThinkingAgent = ["thinking", "research", "text"].includes(String(preset.deliveryMode));
  // Council reviewer/moderator/explainer 雖然係 thinking,但要喺真 project 查文件 → 用 run.projectPath 做 cwd
  // (其餘 thinking agent 照舊用共享 SWARM_WORKSPACE,唔受影響)。
  const isCouncilAgent = ['council_a', 'council_b', 'council_c', 'moderator', 'explainer'].includes(preset.key);
  const useProjectCwd = !isThinkingAgent || isCouncilAgent;
  // Create this agent's isolated worktree (parallel code waves only). On failure,
  // fall back to the shared repo so the agent still runs (degraded, not broken).
  if (options.worktree && !fake) {
    try {
      worktreeMgr.createWorktree({
        repo: safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT),
        baseCommit: options.worktree.base,
        branch: options.worktree.branch,
        dir: options.worktree.dir,
      });
    } catch (e) {
      appendAgentLog(run, agent, `[swarm-server] worktree 建立失敗,fallback 共享 repo: ${e.message}\n`);
      const failedBranch = options.worktree.branch;
      options.worktree = null;
      agent.worktree = null;
      if (options.session && Array.isArray(options.session.worktrees)) {
        options.session.worktrees = options.session.worktrees.filter((w) => w.branch !== failedBranch);
      }
    }
  }
  const projectPath = fake
    ? require('os').tmpdir()
    : (options.worktree ? options.worktree.dir
       : (useProjectCwd ? safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT) : safeProjectPath(SWARM_WORKSPACE)));

  agent.status = 'running';
  agent.startedAt = new Date().toISOString();
  agent.completedAt = null;
  agent.summary = 'Execution agent 正在工作中';
  agent.action = '啟動中…';
  agent.logs = '';
  run.status = 'executing';
  run.stage = preset.layer || 'delivery';
  run.metrics.executionStarted = (run.metrics.executionStarted || 0) + 1;
  run.updatedAt = agent.startedAt;
  scheduleSave();
  io.emit('execution-agent-started', { runId: run.id, agent });
  io.emit('run-updated', publicRun(run));

  const prompt = buildExecutionPrompt(run, preset, agent, options);
  appendAgentLog(run, agent, `[swarm-server] Agent CLI: ${agentCommand.label}${agentCommand.model ? ` · ${agentCommand.model}` : ''}\n`);
  let shell = fake
    ? 'cd "$1"; for s in plan code test wrap; do echo "[fake] $s :: ${2:0:48}"; sleep 1; done; echo "[fake] done"'
    : agentCommand.shell;
  // ─── Council 開盡 reasoning（只影響議會,唔掂 mission/coding agent）───
  // Codex: default medium → high effort;Claude/Opus: 開 extended thinking。
  // GLM(council_c) 故意唔掂——BigModel 按 token 收費,要 Hugo 開聲先調(CLAUDE.md decision boundary)。
  // 全部可由 env 覆寫:SWARM_COUNCIL_CODEX_EFFORT / SWARM_COUNCIL_THINKING。
  const councilEnv = {};
  if (isCouncilAgent && !fake) {
    if (agentCommand.cli === 'codex') {
      const effort = process.env.SWARM_COUNCIL_CODEX_EFFORT || 'high';
      shell = shell.replace('codex exec', `codex exec -c model_reasoning_effort="${effort}"`);
      appendAgentLog(run, agent, `[swarm-server] Council Codex reasoning_effort=${effort}\n`);
    } else if (agentCommand.cli === 'claude') {
      councilEnv.MAX_THINKING_TOKENS = process.env.SWARM_COUNCIL_THINKING || '31999';
      appendAgentLog(run, agent, `[swarm-server] Council Claude MAX_THINKING_TOKENS=${councilEnv.MAX_THINKING_TOKENS}\n`);
    }
  }
  const child = spawn(
    'bash',
    ['-ic', shell, 'swarm-agent', projectPath, prompt],
    {
      cwd: projectPath,
      env: { ...process.env, ...councilEnv, TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  agent.pid = child.pid || null;
  liveJobs.set(agent.id, child);
  const timer = setTimeout(() => {
    appendAgentLog(run, agent, `\n[swarm-server] Timeout after ${Math.round(EXEC_TIMEOUT_MS / 60000)} minutes. Terminating agent.\n`);
    child.kill('SIGTERM');
  }, EXEC_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => appendAgentLog(run, agent, chunk));
  child.stderr.on('data', (chunk) => appendAgentLog(run, agent, chunk));
  child.on('error', (error) => {
    clearTimeout(timer);
    liveJobs.delete(agent.id);
    agent.status = 'failed';
    agent.summary = error.message;
    agent.action = `啟動失敗:${error.message}`.slice(0, 160);
    agent.pid = null;
    agent.completedAt = new Date().toISOString();
    addArtifact(run, { type: 'execution-error', title: `${preset.name} failed to start`, content: error.stack || error.message, agentId: agent.id });
    updateSessionStatus(run, agent.sessionId);
    io.emit('execution-agent-complete', { runId: run.id, agent });
    io.emit('run-updated', publicRun(run));
    pumpQueue();
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    liveJobs.delete(agent.id);
    agent.status = code === 0 ? 'completed' : 'failed';
    agent.completedAt = new Date().toISOString();
    agent.summary = code === 0 ? '已完成 execution job' : `退出碼 ${code}${signal ? ` / ${signal}` : ''}`;
    agent.action = code === 0 ? '✓ 完成' : `退出碼 ${code}${signal ? ` / ${signal}` : ''}`;
    agent.pid = null;
    run.metrics.executionCompleted = (run.metrics.executionCompleted || 0) + 1;
    addArtifact(run, {
      type: code === 0 ? 'execution-report' : 'execution-error',
      title: `${preset.name} ${code === 0 ? 'report' : 'error'}`,
      content: agent.logs || agent.summary,
      agentId: agent.id,
    });
    updateSessionStatus(run, agent.sessionId);
    if (!run.pipeline && !run.agents.some((item) => ['delivery', 'review'].includes(item.layer) && item.status === 'running')) {
      run.status = run.synthesis ? 'complete' : 'active';
      pumpRunQueue();
    }
    run.updatedAt = agent.completedAt;
    scheduleSave();
    io.emit('execution-agent-complete', { runId: run.id, agent });
    io.emit('run-updated', publicRun(run));
    pumpQueue();
  });
}

// Spawn one "wave" = one session containing N agents that run in parallel.
function runWave(run, opts) {
  const mode = opts.deliveryMode || 'code';
  const session = createSession(run, { title: opts.title, kind: opts.kind || mode, model: opts.model, cli: opts.cli });
  if (opts.stageKey) session.pipelineStageKey = opts.stageKey;
  // dynamicAgents (Phase 2 planner waves) override the fixed preset roster.
  const presets = (Array.isArray(opts.dynamicAgents) && opts.dynamicAgents.length)
    ? opts.dynamicAgents
    : ALL_EXECUTION_PRESETS.filter((p) => (opts.agentKeys || []).includes(p.key));
  const per = opts.perAgentModels || {};
  // Worktree isolation only for parallel CODE waves (>1 code agent — e.g. build
  // stage frontend+backend+test). Single-agent / thinking waves stay on the
  // shared repo, byte-for-byte unchanged.
  const isCodeWave = !['thinking', 'research', 'text'].includes(String(mode));
  const useWorktree = SWARM_WORKTREE && isCodeWave && presets.length > 1;
  let waveBase = null;
  if (useWorktree) {
    waveBase = worktreeMgr.headSha(safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT));
    session.worktrees = [];
  }
  const agents = presets.map((p) => {
    const agentOpts = {
      deliveryMode: mode,
      session,
      model: (per[p.key] && per[p.key].model) || opts.model,
      cli: (per[p.key] && per[p.key].cli) || opts.cli,
      taskBrief: p.subScope || opts.taskBrief,
      gate: !!opts.gate,
    };
    if (useWorktree) {
      const dir = path.join(require('os').tmpdir(), 'swarm-wt', String(run.id), p.key);
      const branch = `swarm/${run.id}/${p.key}`;
      agentOpts.worktree = { dir, branch, base: waveBase };
      session.worktrees.push({ key: p.key, dir, branch });
    }
    return startOneExecutionAgent(run, p, agentOpts);
  });
  io.emit('session-started', { runId: run.id, session });
  io.emit('run-updated', publicRun(run));
  scheduleSave();
  return { session, agents };
}

function startExecutionAgents(run, keys, options = {}) {
  const mode = options.deliveryMode || options.mode || 'code';
  const defaults = ['thinking', 'research', 'text'].includes(String(mode)) ? THINKING_PRESETS : EXECUTION_PRESETS;
  // keys may be an array of strings (preset keys) OR objects { key, model, cli } for per-agent model.
  const perKey = {};
  let keyList = null;
  if (Array.isArray(keys) && keys.length) {
    keyList = keys
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && entry.key) {
          perKey[entry.key] = { model: entry.model, cli: entry.cli };
          return entry.key;
        }
        return null;
      })
      .filter(Boolean);
  }
  const wanted = (keyList && keyList.length ? keyList : defaults.map((p) => p.key));
  run.metrics.deliveryMode = mode;
  run.metrics.deliverable = options.deliverable || (mode === 'code' ? 'code' : 'text');
  run.metrics.agentCli = buildAgentCommand(options.cli || process.env.SWARM_AGENT_CLI, options.model).label;
  if (!run.background) {
    run.background = buildAutoBackground(run);
    run.backgroundSource = 'auto';
  }
  if (options.taskBrief) run.taskBrief = truncate(options.taskBrief, MAX_CONTEXT_CHARS);
  return runWave(run, {
    title: options.sessionTitle || `${mode} session`,
    kind: mode,
    deliveryMode: mode,
    agentKeys: wanted,
    model: options.model,
    cli: options.cli,
    perAgentModels: perKey,
    taskBrief: options.taskBrief,
  });
}

// ─── Staged fan-out pipeline: research → build → review, each wave parallel, waves in order ───
function defaultStages(mode) {
  if (mode === 'council') {
    // Swarm Council:consensus(3 reviewer 並行)→ moderate(仲裁改寫 plan)→ explain(人話講解)。
    // consensus+moderate 會被 advanceCouncil rewind 重入,循環到收斂 / maxRounds;
    // Phase 3 御准閘喺 moderate 收斂後、explain 之前發生(pauseForHumanGate 用 p.stopped)。
    return [
      { key: 'consensus', title: '共識評審 Consensus', kind: 'consensus', deliveryMode: 'thinking', agentKeys: ['council_a', 'council_b', 'council_c'] },
      { key: 'moderate', title: '仲裁收斂 Moderate', kind: 'moderator', deliveryMode: 'thinking', agentKeys: ['moderator'] },
      { key: 'explain', title: '人話講解 Explain', kind: 'explainer', deliveryMode: 'thinking', agentKeys: ['explainer'] },
    ];
  }
  if (['thinking', 'research', 'text'].includes(String(mode))) {
    return [
      { key: 'research', title: '研究 Research', kind: 'research', deliveryMode: 'thinking', agentKeys: ['researcher'] },
      { key: 'strategy', title: '策略 Strategy', kind: 'decision', deliveryMode: 'thinking', agentKeys: ['strategist'] },
      { key: 'synthesis', title: '交付 Synthesis', kind: 'text', deliveryMode: 'thinking', agentKeys: ['synthesis'] },
    ];
  }
  if (SWARM_PLAN_DECOMPOSE) {
    // Planner splits the build into dynamic sub-phase waves, spliced in after the
    // plan stage completes (research folded into the planner stage).
    return [
      { key: 'plan', title: '規劃拆解 Plan', kind: 'research', deliveryMode: 'thinking', agentKeys: ['planner'], decompose: true },
      { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'], gate: true },
      { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'], isFix: true },
    ];
  }
  return [
    { key: 'research', title: '研究 Research', kind: 'research', deliveryMode: 'thinking', agentKeys: ['researcher'] },
    { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: ['frontend', 'backend', 'test'] },
    { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'], gate: true },
    { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'], isFix: true },
  ];
}

function startPipeline(run, options = {}) {
  const mode = options.deliveryMode || 'code';
  const stages = (Array.isArray(options.stages) && options.stages.length ? options.stages : defaultStages(mode))
    .map((s) => ({ ...s, status: 'pending', sessionId: null }));
  run.pipeline = {
    mode,
    model: options.model,
    cli: options.cli,
    perAgentModels: options.perAgentModels || {},
    // Council 一律 continueOnFail:一個 model(例 glm)死唔應該炸成個議會,要 degrade 到在席者。
    continueOnFail: !!options.continueOnFail || mode === 'council',
    stopped: false,
    current: -1,
    stages,
    gateIteration: 0,
    maxGateIterations: SWARM_REVIEW_GATE_MAX,
    gateDone: false,
    startedAt: new Date().toISOString(),
    // Swarm Council 收斂狀態
    councilRound: 0,
    councilPlanVersion: 0,
    councilOpenDisputes: null,
    councilDisputes: '',
    councilPaused: false,
    councilReviewPaused: false,  // 第一輪三模獨立 review 後嘅「開始拗」閘
    councilDebateStarted: false,
  };
  if (options.taskBrief) run.taskBrief = truncate(options.taskBrief, MAX_CONTEXT_CHARS);
  // Council:把初始 brief 寫去 brief.md,令 readLatestPlan 有乾淨 v0 baseline(唔受之後 taskBrief 改寫影響)。
  if (mode === 'council') {
    try {
      fs.mkdirSync(COUNCIL_DIR(run.id), { recursive: true });
      fs.writeFileSync(path.join(COUNCIL_DIR(run.id), 'brief.md'), run.taskBrief || run.topic || '');
    } catch (e) { console.warn('[council] write brief.md failed:', e.message); }
  }
  if (!run.background) { run.background = buildAutoBackground(run); run.backgroundSource = 'auto'; }
  run.metrics.deliveryMode = mode;
  scheduleSave();
  advancePipeline(run);
  return run.pipeline;
}

function advancePipeline(run) {
  const p = run.pipeline;
  if (!p || p.stopped) return;
  let next = p.current + 1;
  while (next < p.stages.length && !(p.stages[next].agentKeys || []).length && !(p.stages[next].dynamicAgents || []).length) next += 1;
  if (next >= p.stages.length) {
    p.current = p.stages.length;
    run.status = run.synthesis ? 'complete' : 'active';
    addArtifact(run, { type: 'note', title: 'Pipeline 完成 ✓', content: '所有 stage（研究 → 建造 → 覆核）已順序完成。' });
    io.emit('run-updated', publicRun(run));
    scheduleSave();
    pumpRunQueue();
    return;
  }
  p.current = next;
  const stage = p.stages[next];
  stage.status = 'running';
  const { session } = runWave(run, {
    title: stage.title,
    kind: stage.kind,
    deliveryMode: stage.deliveryMode,
    agentKeys: stage.agentKeys,
    dynamicAgents: stage.dynamicAgents,
    model: p.model,
    cli: p.cli,
    perAgentModels: p.perAgentModels,
    taskBrief: run.taskBrief,
    stageKey: stage.key,
    gate: SWARM_REVIEW_GATE && !!stage.gate,
  });
  stage.sessionId = session.id;
  io.emit('run-updated', publicRun(run));
  scheduleSave();
}

// First pipeline stage that isn't complete/skipped — the resume checkpoint.
function findPipelineCheckpoint(p) {
  if (!p || !Array.isArray(p.stages)) return -1;
  return p.stages.findIndex((s) => !['complete', 'skipped'].includes(s.status));
}

// Resolve (or synthesize) a preset so an arbitrary agent can be re-spawned.
function presetForAgent(agent) {
  const byName = ALL_EXECUTION_PRESETS.find((preset) => preset.name === agent.name);
  if (byName) return byName;
  return {
    key: agent.name,
    name: agent.name,
    layer: agent.layer || 'delivery',
    role: agent.role || 'Agent',
    skill: agent.skill || '',
    scope: agent.summary || '負責本身角色範圍內嘅工作。',
    deliveryMode: ['research', 'decision'].includes(agent.layer) ? 'thinking' : 'code',
  };
}

function emitSnapshot() {
  io.emit('state-snapshot', publicRun(getCurrentRun()));
}

// ─── Run queue (SWARM_RUN_QUEUE): one run at a time, auto-start the next ───
function isRunActive() {
  return store.runs.some((r) => r.status === 'executing');
}

function pumpRunQueue() {
  if (!SWARM_RUN_QUEUE || isRunActive()) return;
  while (runQueuePending.length) {
    const run = store.runs.find((r) => r.id === runQueuePending.shift());
    if (!run || run.status !== 'queued') continue;
    const opt = run.queuedStart || {};
    io.emit('swarm-start', publicRun(run));
    if (opt.staged) {
      startPipeline(run, opt);
    } else {
      startExecutionAgents(run, opt.agents, opt);
    }
    emitSnapshot();
    return; // one at a time; next dequeues when this run finishes
  }
}

app.get('/api/state', (req, res) => res.json(publicRun(getCurrentRun())));

app.get('/api/runs', (req, res) => {
  const runs = store.runs.map((run) => ({
    id: run.id,
    topic: run.topic,
    status: run.status,
    stage: run.stage,
    source: run.source,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    agentCount: run.agents.length,
    runningAgents: run.agents.filter((agent) => agent.status === 'running').length,
    artifactCount: run.artifacts.length,
    contextCount: run.contextHistory.length,
    sessionCount: (run.sessions || []).length,
    sessions: (run.sessions || []).map((session) => ({
      id: session.id,
      title: session.title,
      kind: session.kind,
      model: session.model,
      cli: session.cli,
      status: session.status,
      agentCount: (session.agentIds || []).length,
    })),
    dynamicAgentSet: run.metrics && run.metrics.dynamicAgentSet,
  }));
  res.json({ currentRunId: store.currentRunId, runs });
});

app.get('/api/models', (req, res) => {
  res.json({ defaultCli: DEFAULT_AGENT_CLI, models: MODEL_CATALOG });
});

app.get('/api/runs/:id', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (run) res.json(run);
});

app.get('/api/projects', (req, res) => {
  res.json({ defaultProjectRoot: DEFAULT_PROJECT_ROOT, projects: knownProjects() });
});

// Task-file picker: scan MISSION-*.md in the project root + a dedicated tasks folder.
const SWARM_TASKS_DIR = process.env.SWARM_TASKS_DIR || path.join(process.env.HOME || '/home/hugo-orca', 'swarm-tasks');
app.get('/api/tasks', (req, res) => {
  const out = [];
  const readTaskFile = (dir, file, source) => {
    try {
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) return;
      const raw = fs.readFileSync(full, 'utf8');
      const titleLine = raw.split('\n').find((line) => line.trim()) || file;
      const title = titleLine.replace(/^#+\s*/, '').replace(/^MISSION\s*[—-]\s*/i, '').trim().slice(0, 80) || file;
      out.push({ name: file, source, title, brief: raw.slice(0, 12000) });
    } catch (_) {}
  };
  try {
    fs.readdirSync(DEFAULT_PROJECT_ROOT)
      .filter((f) => /^MISSION-.*\.md$/i.test(f))
      .forEach((f) => readTaskFile(DEFAULT_PROJECT_ROOT, f, 'mission'));
  } catch (_) {}
  try {
    fs.readdirSync(SWARM_TASKS_DIR)
      .filter((f) => /\.(md|markdown|txt)$/i.test(f))
      .forEach((f) => readTaskFile(SWARM_TASKS_DIR, f, 'tasks'));
  } catch (_) {}
  res.json({ tasksDir: SWARM_TASKS_DIR, tasks: out.slice(0, 60) });
});

app.post('/api/runs', (req, res) => {
  const run = createRun(req.body || {});
  io.emit('swarm-start', publicRun(run));
  emitSnapshot();
  res.json({ ok: true, run });
});

app.patch('/api/runs/:id/settings', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  try {
    const body = req.body || {};
    if (body.projectPath !== undefined) run.projectPath = safeProjectPath(body.projectPath);
    if (body.background !== undefined) {
      run.background = truncate(body.background, MAX_CONTEXT_CHARS);
      run.backgroundSource = run.background ? 'manual' : '';
    }
    if (body.taskBrief !== undefined) run.taskBrief = truncate(body.taskBrief, MAX_CONTEXT_CHARS);
    if (body.autoBackground && !run.background) {
      run.background = buildAutoBackground(run);
      run.backgroundSource = 'auto';
    }
    run.updatedAt = new Date().toISOString();
    scheduleSave();
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/runs/:id/agents', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'agent name required' });
  const layer = LAYERS.some((item) => item.id === body.layer) ? body.layer : 'stakeholder';
  const agent = upsertAgent(run, name, {
    layer,
    role: String(body.role || 'Persona').trim(),
    skill: String(body.skill || 'stakeholder reasoning').trim(),
    summary: String(body.summary || '').trim(),
    status: 'pending',
  });
  rebuildEdges(run);
  io.emit('persona-added', { runId: run.id, agent: agent.name, content: agent.summary, run: publicRun(run) });
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, agent, run });
});

app.post('/api/runs/:id/reopen', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  store.currentRunId = run.id;
  run.updatedAt = new Date().toISOString();
  scheduleSave();
  emitSnapshot();
  res.json({ ok: true, run });
});

app.post('/api/runs/:id/context', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const entry = addContext(run, req.body || {});
  const contextText = entry ? entry.context : (req.body && (req.body.context || req.body.text));
  const autoAgents = autoApplyAgentsFromContext(run, contextText, Boolean(req.body && req.body.autoAgents));
  io.emit('context-update', { runId: run.id, entry, run: publicRun(run) });
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, entry, autoAgents, run });
});

app.post('/api/context/cloudcli', (req, res) => {
  const body = req.body || {};
  let run = getCurrentRun();
  if (!run || run.status === 'idle') {
    run = createRun({
      topic: body.topic || body.title || 'CloudCLI Session Swarm',
      sessionId: body.sessionId,
      projectPath: body.projectPath || DEFAULT_PROJECT_ROOT,
      source: 'cloudcli',
      template: 'cloudcli',
    });
  }
  const entry = addContext(run, { ...body, source: 'cloudcli' });
  const contextText = entry ? entry.context : (body.context || body.text || '');
  const autoAgents = autoApplyAgentsFromContext(run, contextText, body.autoAgents !== false);
  io.emit('cloudcli-context', { runId: run.id, entry, autoAgents, run: publicRun(run) });
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, entry, autoAgents, run });
});

app.post('/api/runs/:id/agents/auto', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const latestContext = run.contextHistory[run.contextHistory.length - 1];
  const contextText = req.body && (req.body.context || req.body.text)
    ? (req.body.context || req.body.text)
    : `${run.topic}\n${latestContext ? latestContext.context : ''}`;
  const autoAgents = autoApplyAgentsFromContext(run, contextText, true);
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, autoAgents, dynamicAgentSet: run.metrics.dynamicAgentSet, run });
});

app.delete('/api/runs/:id', (req, res) => {
  const runId = req.params.id;
  const before = store.runs.length;
  store.runs = store.runs.filter((run) => run.id !== runId);
  if (before === store.runs.length) return res.status(404).json({ error: 'run not found' });
  if (store.currentRunId === runId) store.currentRunId = store.runs[0] ? store.runs[0].id : null;
  scheduleSave();
  emitSnapshot();
  io.emit('runs-deleted', { deletedRunId: runId, currentRunId: store.currentRunId });
  res.json({ ok: true, deletedRunId: runId, currentRunId: store.currentRunId });
});

app.post('/api/runs/:id/execution/start', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  try {
    const body = req.body || {};
    const deliveryMode = body.deliveryMode || body.mode || 'code';
    const deliverable = body.deliverable || (deliveryMode === 'code' ? 'code' : 'text');
    const presetDefaults = ['thinking', 'research', 'text'].includes(String(deliveryMode)) ? THINKING_PRESETS : EXECUTION_PRESETS;
    if (req.body && req.body.projectPath) run.projectPath = safeProjectPath(req.body.projectPath);
    if (body.background !== undefined) {
      run.background = truncate(body.background, MAX_CONTEXT_CHARS);
      run.backgroundSource = run.background ? 'manual' : '';
    }
    if (body.taskBrief !== undefined) run.taskBrief = truncate(body.taskBrief, MAX_CONTEXT_CHARS);
    if (req.body && req.body.dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        projectPath: safeProjectPath(run.projectPath),
        agentCli: buildAgentCommand(body.cli || process.env.SWARM_AGENT_CLI).label,
        deliveryMode,
        deliverable,
        agents: presetDefaults.map((preset) => ({
          key: preset.key,
          name: preset.name,
          role: preset.role,
          scope: preset.scope,
        })),
      });
    }
    const { agents } = startExecutionAgents(run, body.agents, {
      cli: body.cli,
      model: body.model,
      deliveryMode,
      deliverable,
      taskBrief: body.taskBrief,
    });
    res.json({ ok: true, agents, run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Drop-zone one-shot: create a plan AND start its first execution session in one call.
app.post('/api/plans/run', (req, res) => {
  try {
    const body = req.body || {};
    const taskBrief = String(body.taskBrief || body.task || '').trim();
    const topic = String(body.topic || '').trim() || (taskBrief ? taskBrief.split('\n')[0].slice(0, 70) : 'Swarm Plan');
    const run = createRun({
      topic,
      taskBrief,
      chatContext: body.chatContext,
      sessionId: body.sessionId,
      projectPath: body.projectPath,
      source: body.source || 'dropzone',
      template: body.template || 'cloudcli',
      seed: false, // drop-zone plans start clean; agents come from the wave/pipeline we spawn
    });
    const deliveryMode = body.deliveryMode || body.mode || 'code';
    const deliverable = body.deliverable || (deliveryMode === 'code' ? 'code' : 'text');
    // Run queue: if another run is executing, queue this one instead of starting.
    if (SWARM_RUN_QUEUE && isRunActive()) {
      run.status = 'queued';
      run.queuedStart = {
        staged: !!body.staged, deliveryMode, deliverable,
        model: body.model, cli: body.cli, perAgentModels: body.perAgentModels || {},
        stages: Array.isArray(body.stages) ? body.stages : null,
        agents: body.agents, taskBrief, sessionTitle: body.sessionTitle,
      };
      runQueuePending.push(run.id);
      scheduleSave();
      io.emit('run-updated', publicRun(run));
      return res.json({ ok: true, queued: true, position: runQueuePending.length, run });
    }
    io.emit('swarm-start', publicRun(run));
    if (body.staged) {
      const pipeline = startPipeline(run, {
        deliveryMode,
        model: body.model,
        cli: body.cli,
        perAgentModels: body.perAgentModels || {},
        stages: Array.isArray(body.stages) ? body.stages : null,
        taskBrief,
      });
      emitSnapshot();
      return res.json({ ok: true, run, pipeline });
    }
    const { agents } = startExecutionAgents(run, body.agents, {
      cli: body.cli,
      model: body.model,
      deliveryMode,
      deliverable,
      taskBrief,
      sessionTitle: body.sessionTitle,
    });
    emitSnapshot();
    res.json({ ok: true, run, agents });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Re-run a single agent (after a crash/interruption or failure).
app.post('/api/runs/:id/agents/:agentId/rerun', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const agent = run.agents.find((item) => item.id === req.params.agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  if (liveJobs.has(agent.id)) return res.status(409).json({ error: 'agent already running' });
  try {
    const body = req.body || {};
    const preset = presetForAgent(agent);
    const model = body.model || agent.model || undefined;
    const cli = body.cli || agent.cli || undefined;
    const session = createSession(run, { title: `Re-run · ${agent.name}`, kind: 'rerun', model, cli });
    agent.status = 'pending';
    startOneExecutionAgent(run, preset, {
      session,
      model,
      cli,
      deliveryMode: preset.deliveryMode || run.metrics.deliveryMode || 'code',
    });
    io.emit('session-started', { runId: run.id, session });
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, agent, session });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Resume a stopped / interrupted pipeline from its checkpoint (last unfinished
// stage). Re-runs that stage onward; complete/skipped stages are left alone.
app.post('/api/runs/:id/resume', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  if (!p || !Array.isArray(p.stages) || !p.stages.length) {
    return res.status(400).json({ error: 'no pipeline to resume' });
  }
  const idx = findPipelineCheckpoint(p);
  if (idx < 0) {
    return res.json({ ok: true, done: true, message: 'pipeline 已完成,冇嘢續' });
  }
  try {
    p.stopped = false;
    // Reset the checkpoint stage + any downstream non-complete stages so
    // advancePipeline re-runs them cleanly.
    for (let i = idx; i < p.stages.length; i += 1) {
      if (['interrupted', 'running', 'failed', 'pending'].includes(p.stages[i].status)) {
        p.stages[i].status = 'pending';
        p.stages[i].sessionId = null;
      }
    }
    p.current = idx - 1;
    run.status = 'executing';
    addArtifact(run, { type: 'note', title: `▶ Pipeline 續行 @ ${p.stages[idx].title}`, content: `由斷點「${p.stages[idx].title}」重新開始。` });
    scheduleSave();
    io.emit('run-updated', publicRun(run));
    advancePipeline(run);
    res.json({ ok: true, resumedFrom: p.stages[idx].key });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── Swarm Council 御准閘 endpoints (三模議會) ───
// 批准 → 解 pause、用終稿 plan 行 explainer stage(Phase 4)。
app.post('/api/runs/:id/council/approve', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  if (!p || !p.councilPaused) return res.status(400).json({ error: '冇 council 御准閘可批准' });
  const idx = p.stages.findIndex((s) => s.kind === 'explainer');
  if (idx < 0) return res.status(400).json({ error: '冇 explainer stage' });
  const plan = readLatestPlan(run);
  run.taskBrief = truncate(`## 已批准嘅終稿 Plan (v${plan.v})\n\n${plan.md}`, MAX_CONTEXT_CHARS);
  p.councilPaused = false;
  p.stopped = false;
  p.stages[idx].status = 'pending';
  p.stages[idx].sessionId = null;
  p.current = idx - 1;
  run.status = 'executing';
  addArtifact(run, { type: 'note', title: `✅ 已批准 plan v${plan.v} → 生成人話講解`, content: '' });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
  res.json({ ok: true, approvedVersion: plan.v });
});

// 再改 → 加用戶指示(最高優先)、重跑一 round consensus(councilRound++,封頂 MAX)。
app.post('/api/runs/:id/council/revise', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  if (!p || !p.councilPaused) return res.status(400).json({ error: '冇 council 御准閘可再改' });
  const cIdx = p.stages.findIndex((s) => s.kind === 'consensus');
  if (cIdx < 0) return res.status(400).json({ error: '冇 consensus stage' });
  const note = String((req.body || {}).note || '').trim();
  const plan = readLatestPlan(run);
  for (let i = cIdx; i < p.stages.length && ['consensus', 'moderator'].includes(p.stages[i].kind); i += 1) {
    p.stages[i].status = 'pending';
    p.stages[i].sessionId = null;
  }
  p.councilPaused = false;
  p.stopped = false;
  p.councilRound = Math.min((p.councilRound || 1) + 1, SWARM_COUNCIL_MAX_ROUNDS);
  run.taskBrief = truncate(
    `## Goal\n${run.background || run.topic || ''}\n\n## 當前 Plan (v${plan.v})\n${plan.md}\n\n` +
    `## 用戶人手指示(最高優先)\n${note || '(用戶冇額外指示,請就未解爭議再收斂一次)'}\n\n` +
    `## 仍未解爭議\n${p.councilDisputes || '(none)'}`,
    MAX_CONTEXT_CHARS);
  p.current = cIdx - 1;
  run.status = 'executing';
  addArtifact(run, { type: 'note', title: '✍️ 用戶要求再改 → 重跑一 round 共識', content: note || '(就未解爭議再收斂)' });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
  res.json({ ok: true, revising: true, round: p.councilRound });
});

// 開始拗:三模獨立 review 後,用戶撳掣 → 入 moderator + 辯論收斂(consensus 已 complete,advancePipeline 行 moderator)。
app.post('/api/runs/:id/council/debate', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  if (!p || !p.councilReviewPaused) return res.status(400).json({ error: '冇 review 閘可開拗' });
  p.councilReviewPaused = false;
  p.councilDebateStarted = true;
  p.stopped = false;
  run.status = 'executing';
  addArtifact(run, { type: 'note', title: '🥊 開始辯論 → moderator 收斂', content: '三模獨立 review 完,用戶開拗。' });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
  res.json({ ok: true });
});

// 落實:批准後將議會終稿 plan 交 code pipeline(build→review→fix)真正喺 project 實作。
app.post('/api/runs/:id/council/execute', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const plan = readLatestPlan(run);
  if (!plan.md || !plan.md.trim() || (plan.v || 0) < 1) {
    return res.status(400).json({ error: '未有議會終稿 plan 可落實(請先跑完議會 + 批准)' });
  }
  const body = req.body || {};
  const model = body.model || 'sonnet';
  const perAgentModels = body.perAgentModels || { reviewer: { cli: 'claude', model: 'opus' } };
  const taskBrief = `# 落實以下已通過三模議會審議嘅 plan（v${plan.v}）\n\n按呢個 plan 直接喺 project 落手實作,完成後跑驗證 / 測試。唔好重新爭論 plan 本身,佢已經三模收斂 + 人手批准。\n\n${plan.md}`;
  try {
    const pipeline = startPipeline(run, {
      deliveryMode: 'code',
      model,
      perAgentModels,
      // 跳過 research(plan 已係研究成果),直接 build → review → fix
      stages: [
        { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: ['frontend', 'backend', 'test'] },
        { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'], gate: true },
        { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'], isFix: true },
      ],
      taskBrief,
    });
    addArtifact(run, { type: 'note', title: `▶ 落實 plan v${plan.v} → code pipeline 開波`, content: `已交 build → review → fix 喺 ${run.projectPath} 實作。` });
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, executingVersion: plan.v, pipeline });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── 定向幕僚 chat endpoints (Phase 1) ───
// 即回 200 + 背景 spawn(唔 block REST 等 10-60s),assistant turn 經 socket push。
app.post('/api/runs/:id/chat', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (run.chatBusy) return res.status(409).json({ error: '上一回合仲傾緊,等陣先' });
  const picked = resolveChatModel(run, body.modelOverride);
  run.chatModel = picked;
  if (body.projectPath !== undefined) {
    if (body.projectPath) { try { run.chatProjectPath = safeProjectPath(body.projectPath); } catch (e) { return res.status(400).json({ error: e.message }); } }
    else run.chatProjectPath = null;
  }
  const chatCwd = run.chatProjectPath;
  const userMsg = pushChatMessage(run, { role: 'user', content: message });
  io.emit('chat-message', { runId: run.id, message: userMsg });
  run.chatBusy = true;
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, accepted: userMsg.id });
  spawnChatTurn(run, picked, chatCwd, false)
    .then((r) => {
      const m = pushChatMessage(run, { role: 'assistant', content: r.text, model: r.model, cli: r.cli, durationMs: r.durationMs, usedProjectPath: chatCwd, status: 'ok' });
      io.emit('chat-message', { runId: run.id, message: m });
    })
    .catch((e) => {
      const m = pushChatMessage(run, { role: 'assistant', content: `（傾偈失敗:${e.message}）`, model: picked.model, cli: picked.cli, status: 'failed', error: e.message });
      io.emit('chat-message', { runId: run.id, message: m });
    })
    .finally(() => { run.chatBusy = false; io.emit('run-updated', publicRun(run)); scheduleSave(); });
});

// 定稿:用較強 model 將全 thread 收斂成 mission brief,寫 brief.md + missionBrief + artifact。
app.post('/api/runs/:id/chat/finalize', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  if (!Array.isArray(run.chatThread) || !run.chatThread.length) return res.status(400).json({ error: '冇對話內容可定稿' });
  if (run.chatBusy) return res.status(409).json({ error: '傾緊偈,等陣先定稿' });
  const body = req.body || {};
  run.chatBusy = true;
  io.emit('run-updated', publicRun(run));
  res.json({ ok: true, finalizing: true });
  const picked = (run.chatModel && run.chatModel.model) ? run.chatModel : { cli: 'claude', model: 'opus' };
  const chatCwd = run.chatProjectPath;
  spawnChatTurn(run, picked, chatCwd, true)
    .then((r) => {
      const intentType = body.intentType || (chatCwd ? 'review-project' : 'new-plan');
      const goalText = String(body.goalText || run.topic || '').slice(0, 2000);
      const draftPlanMd = r.text;
      const briefMd = `---\nintentType: ${intentType}\ngoalText: ${goalText.replace(/\n/g, ' ')}\nprojectPath: ${chatCwd || ''}\n---\n\n${draftPlanMd}`;
      const dir = COUNCIL_DIR(run.id);
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'brief.md'), briefMd); } catch (e) { console.warn('[chat] write brief.md:', e.message); }
      run.missionBrief = { intentType, goalText, projectPath: chatCwd || null, draftPlanMd, briefPath: path.join(dir, 'brief.md'), finalizedAt: new Date().toISOString() };
      if (intentType === 'review-project' && chatCwd) run.projectPath = chatCwd;
      run.taskBrief = truncate(`【${intentType}】${goalText}\n\n${draftPlanMd}`, MAX_CONTEXT_CHARS);
      addArtifact(run, { type: 'mission-brief', title: `📋 Mission Brief（${intentType}）`, content: briefMd });
      addContext(run, { context: `# Mission Brief\nIntent: ${intentType}\nGoal: ${goalText}\n\n${draftPlanMd}`, source: 'chat-finalize' });
      io.emit('chat-finalized', { runId: run.id, brief: run.missionBrief });
    })
    .catch((e) => { io.emit('chat-finalized', { runId: run.id, error: e.message }); })
    .finally(() => { run.chatBusy = false; io.emit('run-updated', publicRun(run)); scheduleSave(); });
});

// 交議會:用 chat 定稿嘅 brief,喺同一 run 開 council pipeline(Phase 2)。
app.post('/api/runs/:id/council/start', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const brief = run.missionBrief;
  // taskBrief 優先序:已定稿 brief > run.taskBrief > 直接用 chat 對話(免一定要先定稿)
  let taskBrief = run.taskBrief || (brief && brief.draftPlanMd) || '';
  if (!taskBrief.trim() && Array.isArray(run.chatThread) && run.chatThread.length) {
    taskBrief = '## 用戶 review 目標 / prompt(由 chat 對話收集)\n\n' +
      run.chatThread.map((m) => `【${m.role === 'user' ? '用戶' : '幕僚'}】${m.content}`).join('\n\n');
  }
  if (!taskBrief.trim()) return res.status(400).json({ error: '未有 brief / 對話,請先喺 chat 寫低你想 review 乜' });
  const per = (req.body || {}).perAgentModels || {};
  // 預設 model 組合,可由前端逐個覆寫
  const perAgentModels = {
    council_a: per.council_a || { cli: 'claude', model: 'opus' },
    council_b: per.council_b || { cli: 'codex', model: 'gpt-5.5' },
    council_c: per.council_c || { cli: 'glm', model: 'glm-5.1' },
    moderator: per.moderator || { cli: 'claude', model: 'opus' },
    explainer: per.explainer || { cli: 'claude', model: 'sonnet' },
  };
  const wantPath = (brief && brief.projectPath) || run.chatProjectPath;
  if (wantPath) { try { run.projectPath = safeProjectPath(wantPath); } catch (_) {} }
  try {
    const pipeline = startPipeline(run, { deliveryMode: 'council', perAgentModels, taskBrief });
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, pipeline });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/health', (req, res) => {
  const run = getCurrentRun();
  res.json({
    ok: true,
    status: run ? run.status : 'idle',
    currentRunId: store.currentRunId,
    runs: store.runs.length,
    liveJobs: liveJobs.size,
    queued: spawnQueue.length,
    maxConcurrent: MAX_CONCURRENT,
    agentCli: buildAgentCommand(process.env.SWARM_AGENT_CLI).label,
  });
});

app.post('/api/reset', (req, res) => {
  store.currentRunId = null;
  scheduleSave();
  io.emit('swarm-reset');
  res.json({ ok: true });
});

// Legacy event API kept for existing skills / one-liners.
app.post('/events/swarm-start', (req, res) => {
  const { topic, personas } = req.body || {};
  if (!topic || !Array.isArray(personas)) return res.status(400).json({ error: 'topic + personas required' });
  const run = createRun({ topic, personas, source: 'legacy-event' });
  io.emit('swarm-start', publicRun(run));
  console.log(`[swarm-start] ${topic} | ${personas.length} personas`);
  res.json({ ok: true, id: run.id });
});

app.post('/events/agent-proposal', (req, res) => {
  const run = getCurrentRun();
  const { agent, content } = req.body || {};
  if (!run || !agent || !content) return res.status(400).json({ error: 'active run + agent + content required' });
  const item = upsertAgent(run, agent, {
    content,
    summary: String(content).split('\n').find(Boolean) || '已提交觀點',
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  run.proposals[agent] = content;
  addArtifact(run, { type: 'proposal', title: `${agent} proposal`, content, agentId: item.id });
  io.emit('agent-proposal', { runId: run.id, agent, content, status: run.status, run: publicRun(run) });
  res.json({ ok: true });
});

app.post('/events/debate-message', (req, res) => {
  const run = getCurrentRun();
  const { from, to, content } = req.body || {};
  if (!run || !from || !to || !content) return res.status(400).json({ error: 'active run + from + to + content required' });
  const msg = { id: id('msg'), from, to, content, ts: Date.now(), createdAt: new Date().toISOString() };
  run.debates.push(msg);
  run.messages.push({ ...msg, type: 'debate' });
  const fromAgent = run.agents.find((agent) => agent.name === from);
  const toAgent = run.agents.find((agent) => agent.name === to);
  if (fromAgent && toAgent) run.edges.push({ id: id('edge'), from: fromAgent.id, to: toAgent.id, type: 'challenge', label: 'challenge' });
  run.stage = 'debate';
  run.updatedAt = msg.createdAt;
  scheduleSave();
  io.emit('debate-message', { runId: run.id, ...msg, run: publicRun(run) });
  res.json({ ok: true });
});

app.post('/events/synthesis-complete', (req, res) => {
  const run = getCurrentRun();
  const { content } = req.body || {};
  if (!run || !content) return res.status(400).json({ error: 'active run + content required' });
  run.synthesis = content;
  run.status = 'complete';
  run.stage = 'complete';
  run.completedAt = new Date().toISOString();
  addArtifact(run, { type: 'synthesis', title: '收斂決策', content });
  scheduleSave();
  io.emit('synthesis-complete', { runId: run.id, content, run: publicRun(run) });
  res.json({ ok: true });
});

app.post('/events/persona-added', (req, res) => {
  const run = getCurrentRun();
  const { agent, content } = req.body || {};
  if (!run || !agent) return res.status(400).json({ error: 'active run + agent required' });
  upsertAgent(run, agent, {
    layer: 'stakeholder',
    role: 'Persona',
    skill: 'stakeholder reasoning',
    content: content || '',
    status: content ? 'completed' : 'pending',
  });
  io.emit('persona-added', { runId: run.id, agent, content, run: publicRun(run) });
  res.json({ ok: true });
});

app.post('/events/context-update', (req, res) => {
  const run = getCurrentRun();
  const { context, instruction } = req.body || {};
  if (!run || !context) return res.status(400).json({ error: 'active run + context required' });
  const entry = addContext(run, { context, instruction, source: 'legacy-event' });
  io.emit('context-update', { runId: run.id, entry, run: publicRun(run) });
  res.json({ ok: true });
});

app.post('/events/rebuttal', (req, res) => {
  const run = getCurrentRun();
  const { agent, critic, content } = req.body || {};
  if (!run || !agent || !critic || !content) return res.status(400).json({ error: 'active run + agent + critic + content required' });
  if (!run.rebuttals[agent]) run.rebuttals[agent] = [];
  run.rebuttals[agent].push({ critic, content, ts: Date.now() });
  run.messages.push({ id: id('msg'), type: 'rebuttal', from: agent, to: critic, content, createdAt: new Date().toISOString() });
  run.updatedAt = new Date().toISOString();
  scheduleSave();
  io.emit('rebuttal', { runId: run.id, agent, critic, content, run: publicRun(run) });
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`[ws] client connected (${io.engine.clientsCount} total)`);
  socket.emit('state-snapshot', publicRun(getCurrentRun()));
  socket.on('mission:join', (room) => {
    if (typeof room === 'string' && room.startsWith('mission-')) socket.join(room);
  });
  socket.on('mission:leave', (room) => {
    if (typeof room === 'string') socket.leave(room);
  });
  socket.on('disconnect', () => console.log(`[ws] client disconnected (${io.engine.clientsCount} total)`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Swarm V3 dashboard server on http://0.0.0.0:${PORT}`);
  console.log(`[store] ${store.runs.length} saved runs; current=${store.currentRunId || 'none'}`);
});
