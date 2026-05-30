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

const MAX_SKILL_CHARS = 3000;

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
];

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
];

const ALL_EXECUTION_PRESETS = [...EXECUTION_PRESETS, ...THINKING_PRESETS];

// Load skill content at startup
const SKILL_CACHE = loadSkills();
console.log('[skill-inject] loaded ' + Object.keys(SKILL_CACHE).length + ' / ' + Object.keys(SKILL_REGISTRY).length + ' skills');

// Agent preset key -> list of skill cache keys to inject
const AGENT_SKILL_MAP = {
  frontend:    ['typography', 'color', 'layout', 'components', 'taste-skill', 'performance-engineer'],
  backend:     ['architect', 'debugger', 'performance-engineer'],
  test:        ['debugger', 'reviewer-persona'],
  reviewer:    ['reviewer-persona', 'security-auditor', 'refactor-engineer'],
  fixer:       ['debugger', 'refactor-engineer'],
  researcher:  ['brainstormers'],
  strategist:  ['brainstormers', 'architect'],
  synthesis:   ['brainstormers'],
};

function getSkillContent(presetKey) {
  const skillKeys = AGENT_SKILL_MAP[presetKey];
  if (!skillKeys || skillKeys.length === 0) return '';
  const sections = [];
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
app.use('/mission', require('./routes/mission')(io));

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
  }
  io.emit('session-updated', { runId: run.id, session });
  if (justFinished) maybeAdvancePipeline(run, session);
}

// When a pipeline stage's session finishes, auto-start the next stage (staged fan-out).
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
  advancePipeline(run);
}

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
  const projectPath = fake
    ? require('os').tmpdir()
    : (isThinkingAgent ? safeProjectPath(SWARM_WORKSPACE) : safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT));

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
  const shell = fake
    ? 'cd "$1"; for s in plan code test wrap; do echo "[fake] $s :: ${2:0:48}"; sleep 1; done; echo "[fake] done"'
    : agentCommand.shell;
  const child = spawn(
    'bash',
    ['-ic', shell, 'swarm-agent', projectPath, prompt],
    {
      cwd: projectPath,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
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
  const presets = ALL_EXECUTION_PRESETS.filter((p) => (opts.agentKeys || []).includes(p.key));
  const per = opts.perAgentModels || {};
  const agents = presets.map((p) => startOneExecutionAgent(run, p, {
    deliveryMode: mode,
    session,
    model: (per[p.key] && per[p.key].model) || opts.model,
    cli: (per[p.key] && per[p.key].cli) || opts.cli,
    taskBrief: opts.taskBrief,
  }));
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
  if (['thinking', 'research', 'text'].includes(String(mode))) {
    return [
      { key: 'research', title: '研究 Research', kind: 'research', deliveryMode: 'thinking', agentKeys: ['researcher'] },
      { key: 'strategy', title: '策略 Strategy', kind: 'decision', deliveryMode: 'thinking', agentKeys: ['strategist'] },
      { key: 'synthesis', title: '交付 Synthesis', kind: 'text', deliveryMode: 'thinking', agentKeys: ['synthesis'] },
    ];
  }
  return [
    { key: 'research', title: '研究 Research', kind: 'research', deliveryMode: 'thinking', agentKeys: ['researcher'] },
    { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: ['frontend', 'backend', 'test'] },
    { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'] },
    { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'] },
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
    continueOnFail: !!options.continueOnFail,
    stopped: false,
    current: -1,
    stages,
    startedAt: new Date().toISOString(),
  };
  if (options.taskBrief) run.taskBrief = truncate(options.taskBrief, MAX_CONTEXT_CHARS);
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
  while (next < p.stages.length && !(p.stages[next].agentKeys || []).length) next += 1;
  if (next >= p.stages.length) {
    p.current = p.stages.length;
    run.status = run.synthesis ? 'complete' : 'active';
    addArtifact(run, { type: 'note', title: 'Pipeline 完成 ✓', content: '所有 stage（研究 → 建造 → 覆核）已順序完成。' });
    io.emit('run-updated', publicRun(run));
    scheduleSave();
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
    model: p.model,
    cli: p.cli,
    perAgentModels: p.perAgentModels,
    taskBrief: run.taskBrief,
    stageKey: stage.key,
  });
  stage.sessionId = session.id;
  io.emit('run-updated', publicRun(run));
  scheduleSave();
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
    io.emit('swarm-start', publicRun(run));
    const deliveryMode = body.deliveryMode || body.mode || 'code';
    const deliverable = body.deliverable || (deliveryMode === 'code' ? 'code' : 'text');
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
