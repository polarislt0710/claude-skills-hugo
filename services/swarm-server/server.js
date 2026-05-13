const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Server } = require('socket.io');

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
    scope: '負責 review 現有改動、找 bug / race / security risk，不要 revert 其他 agent 工作。',
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

fs.mkdirSync(DATA_DIR, { recursive: true });

let store = loadStore();
let saveTimer = null;
const liveJobs = new Map();
store.runs.forEach(normalizeRun);

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
    content: extra.content || '',
    logs: extra.logs || '',
    artifactIds: extra.artifactIds || [],
    index,
    startedAt: extra.startedAt || null,
    completedAt: extra.completedAt || null,
    updatedAt: new Date().toISOString(),
  };
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

function createRun({ topic, personas, chatContext, sessionId, projectPath, source, template, background, taskBrief } = {}) {
  const now = new Date().toISOString();
  const agents = Array.isArray(personas) && personas.length
    ? personas.map((persona, index) => makeAgent(String(persona), 'stakeholder', 'Persona', 'stakeholder reasoning', index + 1))
    : seedAgents(template || 'cloudcli', `${topic || ''}\n${chatContext || ''}`);

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

function buildAgentCommand(cliName) {
  const cli = String(cliName || DEFAULT_AGENT_CLI).trim().toLowerCase();
  if (cli === 'codex') {
    return {
      label: 'codex',
      shell: 'cd "$1" && exec codex exec --cd "$1" --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox "$2"',
    };
  }
  return {
    label: 'claude',
    shell: 'cd "$1" && exec claude -p --permission-mode bypassPermissions "$2"',
  };
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
  agent.updatedAt = new Date().toISOString();
  run.updatedAt = agent.updatedAt;
  io.emit('execution-agent-log', { runId: run.id, agentId: agent.id, chunk: text.slice(-4000) });
  scheduleSave();
}

function startOneExecutionAgent(run, preset, options = {}) {
  const isThinkingAgent = ["thinking", "research", "text"].includes(String(preset.deliveryMode));
  const projectPath = isThinkingAgent ? safeProjectPath(SWARM_WORKSPACE) : safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT);
  let agent = run.agents.find((candidate) => candidate.name === preset.name);
  if (!agent) {
    agent = makeAgent(preset.name, preset.layer, preset.role, preset.skill, run.agents.length + 1);
    run.agents.push(agent);
  }

  if (liveJobs.has(agent.id)) return agent;

  agent.status = 'running';
  agent.startedAt = new Date().toISOString();
  agent.completedAt = null;
  agent.summary = 'Execution agent 正在工作中';
  agent.logs = '';
  run.status = 'executing';
  run.stage = preset.layer || 'delivery';
  run.metrics.executionStarted = (run.metrics.executionStarted || 0) + 1;
  run.updatedAt = agent.startedAt;
  scheduleSave();
  io.emit('execution-agent-started', { runId: run.id, agent });
  io.emit('run-updated', publicRun(run));

  const prompt = buildExecutionPrompt(run, preset, agent, options);
  const agentCommand = buildAgentCommand(options.cli || process.env.SWARM_AGENT_CLI);
  appendAgentLog(run, agent, `[swarm-server] Agent CLI: ${agentCommand.label}\n`);
  const child = spawn(
    'bash',
    ['-ic', agentCommand.shell, 'swarm-agent', projectPath, prompt],
    {
      cwd: projectPath,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

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
    agent.completedAt = new Date().toISOString();
    addArtifact(run, { type: 'execution-error', title: `${preset.name} failed to start`, content: error.stack || error.message, agentId: agent.id });
    io.emit('execution-agent-complete', { runId: run.id, agent });
    io.emit('run-updated', publicRun(run));
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    liveJobs.delete(agent.id);
    agent.status = code === 0 ? 'completed' : 'failed';
    agent.completedAt = new Date().toISOString();
    agent.summary = code === 0 ? '已完成 execution job' : `退出碼 ${code}${signal ? ` / ${signal}` : ''}`;
    run.metrics.executionCompleted = (run.metrics.executionCompleted || 0) + 1;
    addArtifact(run, {
      type: code === 0 ? 'execution-report' : 'execution-error',
      title: `${preset.name} ${code === 0 ? 'report' : 'error'}`,
      content: agent.logs || agent.summary,
      agentId: agent.id,
    });
    if (!run.agents.some((item) => ['delivery', 'review'].includes(item.layer) && item.status === 'running')) {
      run.status = run.synthesis ? 'complete' : 'active';
    }
    run.updatedAt = agent.completedAt;
    scheduleSave();
    io.emit('execution-agent-complete', { runId: run.id, agent });
    io.emit('run-updated', publicRun(run));
  });

  return agent;
}

function startExecutionAgents(run, keys, options = {}) {
  const mode = options.deliveryMode || options.mode || 'code';
  const defaults = ['thinking', 'research', 'text'].includes(String(mode)) ? THINKING_PRESETS : EXECUTION_PRESETS;
  const wanted = Array.isArray(keys) && keys.length
    ? ALL_EXECUTION_PRESETS.filter((preset) => keys.includes(preset.key))
    : defaults;
  run.metrics.deliveryMode = mode;
  run.metrics.deliverable = options.deliverable || (mode === 'code' ? 'code' : 'text');
  run.metrics.agentCli = buildAgentCommand(options.cli || process.env.SWARM_AGENT_CLI).label;
  if (!run.background) {
    run.background = buildAutoBackground(run);
    run.backgroundSource = 'auto';
  }
  if (options.taskBrief) run.taskBrief = truncate(options.taskBrief, MAX_CONTEXT_CHARS);
  return wanted.map((preset) => startOneExecutionAgent(run, preset, { ...options, deliveryMode: mode }));
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
    artifactCount: run.artifacts.length,
    contextCount: run.contextHistory.length,
    dynamicAgentSet: run.metrics && run.metrics.dynamicAgentSet,
  }));
  res.json({ currentRunId: store.currentRunId, runs });
});

app.get('/api/runs/:id', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (run) res.json(run);
});

app.get('/api/projects', (req, res) => {
  res.json({ defaultProjectRoot: DEFAULT_PROJECT_ROOT, projects: knownProjects() });
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
    const agents = startExecutionAgents(run, body.agents, {
      cli: body.cli,
      deliveryMode,
      deliverable,
      taskBrief: body.taskBrief,
    });
    res.json({ ok: true, agents, run });
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
  socket.on('disconnect', () => console.log(`[ws] client disconnected (${io.engine.clientsCount} total)`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Swarm V3 dashboard server on http://0.0.0.0:${PORT}`);
  console.log(`[store] ${store.runs.length} saved runs; current=${store.currentRunId || 'none'}`);
});
