// Mission Intelligence: Ruflo-inspired role catalog + deterministic routing.
// This intentionally does not install Ruflo hooks/MCP; it borrows useful agent
// concepts and keeps Hugo's Mission Pipeline as the control plane.

const GLM_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.SWARM_DISABLE_GLM || ''));
const DEFAULT_CODING_FALLBACK = GLM_DISABLED ? 'gpt-5.5' : (process.env.SWARM_DEFAULT_GLM_MODEL || 'glm-4.5');

const DEFAULT_ROUTE = {
  contextScout: null,
  planner: 'gpt-5.5',
  coding: 'gpt-5.5',
  codingFallback: DEFAULT_CODING_FALLBACK,
  review: 'opus',
  refill: 'opus',
  finalSummary: 'opus',
};

const ROLE_CATALOG = [
  {
    key: 'mission-director',
    name: 'Mission Director',
    icon: '♛',
    group: 'queen',
    source: 'ruflo:hive-mind/queen-coordinator',
    prompt: 'Keep the mission coherent, allocate attention, detect blockers, and decide when to escalate.',
    useWhen: ['always'],
  },
  {
    key: 'goal-planner',
    name: 'Goal Planner',
    icon: '☷',
    group: 'planning',
    source: 'ruflo:goal/goal-planner',
    prompt: 'Turn the desired end state into ordered actions with explicit preconditions, effects, and replanning triggers.',
    useWhen: ['always'],
  },
  {
    key: 'context-scout',
    name: 'Context Scout',
    icon: '⌕',
    group: 'research',
    source: 'ruflo:core/researcher',
    prompt: 'Scan the repo, docs, prior plans, and constraints before implementation starts.',
    useWhen: ['always'],
  },
  {
    key: 'coder',
    name: 'Implementation Coder',
    icon: '⌘',
    group: 'build',
    source: 'ruflo:core/coder',
    prompt: 'Write scoped production code, follow existing patterns, test, and commit small vertical slices.',
    useWhen: ['always'],
  },
  {
    key: 'reviewer',
    name: 'Quality Reviewer',
    icon: '✓',
    group: 'review',
    source: 'ruflo:core/reviewer',
    prompt: 'Review correctness, security, performance, maintainability, tests, and plan fit with evidence.',
    useWhen: ['always'],
  },
  {
    key: 'tester',
    name: 'Test Strategist',
    icon: '◈',
    group: 'quality',
    source: 'ruflo:core/tester',
    prompt: 'Design fast public-interface tests, edge cases, smoke checks, and regression signals.',
    useWhen: ['test', 'qa', 'bug', 'regression', 'critical'],
  },
  {
    key: 'frontend',
    name: 'Frontend Specialist',
    icon: '▣',
    group: 'build',
    source: 'ruflo:v3/typescript-specialist + local design skills',
    prompt: 'Protect UI state, responsive layout, accessibility, visual hierarchy, and browser verification.',
    useWhen: ['ui', 'frontend', 'css', 'layout', 'dashboard', 'browser'],
  },
  {
    key: 'backend',
    name: 'Backend API Specialist',
    icon: '⚙',
    group: 'build',
    source: 'ruflo:development/backend-dev',
    prompt: 'Design robust APIs, persistence flows, validation, error paths, and service boundaries.',
    useWhen: ['api', 'backend', 'server', 'database', 'queue', 'cron'],
  },
  {
    key: 'security-auditor',
    name: 'Security Auditor',
    icon: '◇',
    group: 'risk',
    source: 'ruflo:security-auditor',
    prompt: 'Check authz, injection, path traversal, secret leakage, data exposure, and trust boundaries.',
    useWhen: ['auth', 'security', 'secret', 'payment', 'token', 'permission', 'ssh', 'firewall'],
  },
  {
    key: 'performance-engineer',
    name: 'Performance Engineer',
    icon: '↯',
    group: 'risk',
    source: 'ruflo:v3/v3-performance-engineer',
    prompt: 'Watch hot paths, repeated work, payload growth, latency, memory, and async bottlenecks.',
    useWhen: ['performance', 'latency', 'scale', 'slow', 'memory', 'token'],
  },
  {
    key: 'migration-engineer',
    name: 'Migration Engineer',
    icon: '⇄',
    group: 'risk',
    source: 'ruflo:migrations/migration-engineer',
    prompt: 'Plan reversible data/config migrations, compatibility, rollback, and release ordering.',
    useWhen: ['migration', 'schema', 'database', 'config', 'deploy'],
  },
  {
    key: 'production-validator',
    name: 'Production Validator',
    icon: '◎',
    group: 'quality',
    source: 'ruflo:testing/production-validator',
    prompt: 'Verify no mock-only implementation remains and the feature works in a production-like path.',
    useWhen: ['deploy', 'release', 'production', 'critical', 'integration'],
  },
  {
    key: 'observability-engineer',
    name: 'Observability Engineer',
    icon: '◌',
    group: 'monitoring',
    source: 'ruflo-observability/observability-engineer',
    prompt: 'Track status, traces, durations, recent files, progress signals, and anomalies for the dashboard.',
    useWhen: ['always'],
  },
  {
    key: 'cost-analyst',
    name: 'Cost Analyst',
    icon: '$',
    group: 'budget',
    source: 'ruflo-cost-tracker/cost-analyst',
    prompt: 'Estimate token budgets, attribute model usage, and recommend cheaper routing where safe.',
    useWhen: ['always'],
  },
  {
    key: 'docs-writer',
    name: 'Docs Writer',
    icon: '¶',
    group: 'delivery',
    source: 'ruflo-docs/docs-writer',
    prompt: 'Update summaries, handoff notes, usage docs, and decision records only when useful.',
    useWhen: ['docs', 'readme', 'summary', 'handoff', 'decision'],
  },
];

const KEYWORDS = {
  ui: /(?:ui|ux|frontend|css|html|layout|dashboard|browser|responsive|button|modal|panel|介面|畫面|前端|樣式|監控)/i,
  backend: /(?:api|backend|server|route|express|fastapi|database|db|sql|queue|cron|pm2|後端|服務|資料庫)/i,
  security: /(?:auth|authorization|permission|security|secret|token|password|payment|pii|ssh|ufw|firewall|安全|權限|密碼|付款|私隱)/i,
  migration: /(?:migration|schema|deploy|rollback|config|systemd|infra|vps|部署|遷移|設定)/i,
  performance: /(?:performance|latency|scale|memory|cache|slow|token|cost|budget|速度|成本|延遲|記憶體)/i,
  test: /(?:test|pytest|vitest|playwright|qa|regression|smoke|coverage|測試|驗證|回歸)/i,
  docs: /(?:docs|readme|summary|handoff|adr|decision|文件|總結|紀錄)/i,
  broad: /(?:refactor|architecture|workflow|pipeline|orchestrator|agent|swarm|multi|全面|架構|流程|多個)/i,
};

const DASHBOARD_ONLY_ROLE_KEYS = new Set(['observability-engineer', 'cost-analyst']);

const STAGE_BASE_ROLE_KEYS = {
  preflight: ['context-scout'],
  planner: ['mission-director', 'goal-planner'],
  coding: ['coder'],
  fix: ['coder'],
  review: ['reviewer'],
  'review-after-refill': ['reviewer'],
  refill: [],
  'final-summary': ['docs-writer'],
};

const CODING_SPECIALIST_PRIORITY = [
  'frontend',
  'backend',
  'tester',
  'security-auditor',
  'performance-engineer',
  'migration-engineer',
  'production-validator',
  'docs-writer',
];

const REVIEW_SPECIALIST_PRIORITY = [
  'security-auditor',
  'performance-engineer',
  'tester',
  'migration-engineer',
  'production-validator',
];

const REFILL_SPECIALIST_PRIORITY = [
  'tester',
  'frontend',
  'backend',
  'performance-engineer',
  'docs-writer',
];

function countMatches(text, regex) {
  const matches = String(text || '').match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'));
  return matches ? matches.length : 0;
}

function detectSignals(planText, title = '') {
  const text = `${title}\n${planText || ''}`;
  return Object.fromEntries(Object.entries(KEYWORDS).map(([key, regex]) => [key, regex.test(text)]));
}

function estimateFilesTouched(planText) {
  const text = String(planText || '');
  const pathMatches = text.match(/[A-Za-z0-9_\-/]+\.(?:js|ts|tsx|jsx|py|css|html|md|json|toml|ya?ml|sh)/g) || [];
  const uniquePaths = new Set(pathMatches.map((p) => p.replace(/^`|`$/g, '')));
  const explicit = text.match(/est_files_touched["':\s]+(\d+)/i);
  return explicit ? Number(explicit[1]) : Math.min(uniquePaths.size || Math.ceil(text.length / 9000), 30);
}

function scoreMission(planText, title = '') {
  const text = String(planText || '');
  const signals = detectSignals(text, title);
  const reasons = [];
  let score = 12;

  if (text.length > 60000) { score += 24; reasons.push('plan 好長，需要拆細同控制 context'); }
  else if (text.length > 30000) { score += 16; reasons.push('plan 中大型，需要 planner 保持邊界'); }
  else if (text.length > 12000) { score += 8; reasons.push('plan 有一定篇幅'); }

  const files = estimateFilesTouched(text);
  if (files >= 15) { score += 20; reasons.push(`估計會碰 ${files}+ 個檔案`); }
  else if (files >= 8) { score += 12; reasons.push(`估計會碰約 ${files} 個檔案`); }
  else if (files >= 4) { score += 6; reasons.push(`估計會碰 ${files} 個檔案`); }

  const weights = {
    security: 24,
    migration: 18,
    backend: 12,
    ui: 8,
    performance: 8,
    test: 6,
    docs: -4,
    broad: 12,
  };
  for (const [key, active] of Object.entries(signals)) {
    if (!active) continue;
    score += weights[key] || 0;
  }
  if (signals.security) reasons.push('涉及 auth/security/secrets/trust boundary');
  if (signals.migration) reasons.push('涉及 deploy/config/migration/rollback');
  if (signals.backend) reasons.push('涉及 backend/API/persistence');
  if (signals.ui) reasons.push('涉及 UI/前端驗證');
  if (signals.performance) reasons.push('涉及 performance/token/cost');
  if (signals.broad) reasons.push('屬於 workflow/架構/多 agent 類任務');

  const ambiguity = countMatches(text, /(?:maybe|unsure|unknown|唔知|可能|TBD|待確認)/i);
  if (ambiguity >= 3) {
    score += 8;
    reasons.push('plan 入面有幾個未確定點');
  }

  score = Math.max(5, Math.min(100, score));
  let band = 'simple';
  if (score >= 86) band = 'critical';
  else if (score >= 66) band = 'complex';
  else if (score >= 31) band = 'standard';

  return { score, band, reasons, signals, estFilesTouched: files, planChars: text.length };
}

function routeForComplexity(complexity) {
  const { band } = complexity;
  const route = { ...DEFAULT_ROUTE };
  let strategy = 'gpt-plan-gpt-build-opus-guard';

  if (band === 'simple') {
    strategy = 'gpt-fast-opus-guard';
  } else if (band === 'standard') {
    strategy = 'gpt-plan-gpt-build-opus-guard';
  } else if (band === 'complex') {
    strategy = 'gpt-plan-gpt-build-opus-review';
  } else {
    strategy = 'gpt-plan-gpt-build-opus-critical';
  }

  return { strategy, models: route };
}

function tokenBudgetFor(complexity, route) {
  const planTokens = Math.max(800, Math.round(complexity.planChars / 4));
  const multiplier = {
    simple: 3.2,
    standard: 5.4,
    complex: 8.2,
    critical: 11.5,
  }[complexity.band] || 5;
  const estimatedTokens = Math.round(planTokens * multiplier);

  const savingsPct = {
    'glm-first': 52,
    'glm-sonnet-guard': 42,
    'glm-build-opus-guard': 34,
    'opus-plan-glm-build': 34,
    'opus-guarded': 22,
    'opus-led': 12,
    'opus-guarded-critical': 28,
    'opus-led-critical': 0,
    'gpt-fast-opus-guard': 30,
    'gpt-plan-gpt-build-opus-guard': 24,
    'gpt-plan-gpt-build-opus-review': 18,
    'gpt-plan-gpt-build-opus-critical': 12,
  }[route.strategy] ?? 20;

  const expandedUsage = savingsPct > 0 ? Number((100 / (100 - savingsPct)).toFixed(2)) : 1;
  const modelValues = Object.values(route.models || {}).filter(Boolean);
  const opusCount = modelValues.filter((model) => String(model).toLowerCase() === 'opus').length;
  return {
    estimatedTokens,
    estimatedOpusSharePct: modelValues.length ? Math.round((opusCount / modelValues.length) * 100) : 0,
    savingsPct,
    expandedUsage,
    note: savingsPct >= 50
      ? '接近 Ruflo 式 simple-task routing；實際節省要靠 telemetry 驗證'
      : '保守路由：優先守 correctness，節省會較少但風險低',
  };
}

function roleMatches(role, signals, band) {
  if (role.useWhen.includes('always')) return true;
  if (band === 'critical' && role.useWhen.includes('critical')) return true;
  return role.useWhen.some((key) => signals[key]);
}

function roleMatchesStageText(role, stageText, signals) {
  if (!role || DASHBOARD_ONLY_ROLE_KEYS.has(role.key)) return false;
  if (role.key === 'tester') return !!signals.test;
  if (role.key === 'frontend') return !!signals.ui;
  if (role.key === 'backend') return !!signals.backend;
  if (role.key === 'security-auditor') return !!signals.security;
  if (role.key === 'performance-engineer') return !!signals.performance;
  if (role.key === 'migration-engineer') return !!signals.migration;
  if (role.key === 'production-validator') return !!(signals.migration || signals.test);
  if (role.key === 'docs-writer') return !!signals.docs;
  return role.useWhen.some((key) => key !== 'always' && String(stageText || '').toLowerCase().includes(key));
}

function modelForRole(role, route) {
  if (role.group === 'planning' || role.group === 'queen') return route.models.planner;
  if (role.group === 'review') return route.models.review;
  if (role.key === 'security-auditor') return route.models.review;
  if (role.group === 'risk') return route.models.refill || 'sonnet';
  if (role.group === 'budget' || role.group === 'monitoring') return DEFAULT_CODING_FALLBACK;
  if (role.group === 'quality') return route.models.refill || route.models.review;
  if (role.group === 'delivery') return route.models.finalSummary || route.models.refill || 'opus';
  return route.models.coding;
}

function selectRoster(complexity, route) {
  const maxRoles = { simple: 5, standard: 7, complex: 9, critical: 11 }[complexity.band] || 7;
  const selected = ROLE_CATALOG.filter((role) => roleMatches(role, complexity.signals, complexity.band));
  const priority = ['mission-director', 'goal-planner', 'context-scout', 'coder', 'reviewer', 'tester', 'frontend', 'backend', 'security-auditor', 'performance-engineer', 'migration-engineer', 'production-validator', 'observability-engineer', 'cost-analyst', 'docs-writer'];
  selected.sort((a, b) => priority.indexOf(a.key) - priority.indexOf(b.key));

  return selected.slice(0, maxRoles).map((role, idx) => ({
    ...role,
    idx: idx + 1,
    model: modelForRole(role, route),
    status: 'queued',
    currentStep: idx === 0 ? '等待 mission 開始' : '待命',
    memoryNamespace: `mission/${role.group}/${role.key}`,
    dashboardOnly: DASHBOARD_ONLY_ROLE_KEYS.has(role.key),
    tokenBudgetPct: role.group === 'queen' || role.group === 'planning' ? 18 : role.group === 'review' || role.group === 'risk' ? 16 : 10,
  }));
}

function buildIntelligence(planText, options = {}) {
  const complexity = scoreMission(planText, options.title || '');
  const route = routeForComplexity(complexity);
  const tokenBudget = tokenBudgetFor(complexity, route);
  const roster = selectRoster(complexity, route);
  return {
    source: 'local mission-intelligence + Ruflo-inspired role catalog',
    rufloMode: 'concepts-only',
    complexity,
    route,
    tokenBudget,
    roster,
  };
}

function normalizeModel(model) {
  if (!model) return model;
  const value = String(model).toLowerCase();
  if (value === 'glm' || (GLM_DISABLED && value.startsWith('glm'))) return DEFAULT_CODING_FALLBACK;
  if (value === 'claude') return 'opus';
  return value;
}

function normalizeModels(models) {
  return Object.fromEntries(
    Object.entries(models || {}).map(([key, value]) => [key, normalizeModel(value)])
  );
}

function mergeModelsWithRoute(inputModels, route, smartRoute) {
  const explicit = normalizeModels(inputModels || {});
  const routed = normalizeModels(route.models || {});
  const merged = smartRoute === false
    ? { ...DEFAULT_ROUTE, ...explicit }
    : { ...DEFAULT_ROUTE, ...routed, ...explicit };
  if (!merged.contextScout) merged.contextScout = merged.planner || DEFAULT_ROUTE.contextScout;
  return merged;
}

function applyResolvedModelsToIntelligence(intelligence, models) {
  if (!intelligence || !intelligence.route) return intelligence;
  const resolved = normalizeModels(models || {});
  const route = {
    ...intelligence.route,
    models: { ...DEFAULT_ROUTE, ...(intelligence.route.models || {}), ...resolved },
  };
  return {
    ...intelligence,
    route,
    tokenBudget: tokenBudgetFor(intelligence.complexity, route),
    roster: Array.isArray(intelligence.roster)
      ? intelligence.roster.map((role) => ({
          ...role,
          model: modelForRole(role, route),
        }))
      : intelligence.roster,
  };
}

function stageKey(stage) {
  const s = String(stage || '').toLowerCase();
  if (s === 'phase_review') return 'review';
  if (s === 'review-after-refill') return 'review-after-refill';
  if (s === 'finalsummary') return 'final-summary';
  return s || 'coding';
}

function promptActiveRolesForStage(roster, stage, stageText = '') {
  if (!Array.isArray(roster) || roster.length === 0) return [];
  const normalizedStage = stageKey(stage);
  const byKey = new Map(roster.map((role) => [role.key, role]));
  const selectedKeys = new Set(STAGE_BASE_ROLE_KEYS[normalizedStage] || []);
  const signals = detectSignals(stageText, '');

  const addSpecialists = (priority, limit) => {
    let added = 0;
    for (const key of priority) {
      if (added >= limit) break;
      if (selectedKeys.has(key)) continue;
      const role = byKey.get(key);
      if (!role || !roleMatchesStageText(role, stageText, signals)) continue;
      selectedKeys.add(key);
      added += 1;
    }
  };

  if (normalizedStage === 'coding' || normalizedStage === 'fix') {
    addSpecialists(CODING_SPECIALIST_PRIORITY, 2);
  } else if (normalizedStage === 'review' || normalizedStage === 'review-after-refill') {
    addSpecialists(REVIEW_SPECIALIST_PRIORITY, 4);
  } else if (normalizedStage === 'refill') {
    addSpecialists(REFILL_SPECIALIST_PRIORITY, 3);
  }

  return Array.from(selectedKeys)
    .map((key) => byKey.get(key))
    .filter((role) => role && !DASHBOARD_ONLY_ROLE_KEYS.has(role.key));
}

function promptActiveRoleKeysForStage(roster, stage, stageText = '') {
  return promptActiveRolesForStage(roster, stage, stageText).map((role) => role.key);
}

function compactAgentBriefForStage(roster, stage, stageText = '') {
  const activeRoles = promptActiveRolesForStage(roster, stage, stageText);
  if (!activeRoles.length) return '';
  const rows = activeRoles.map((agent) => (
    `- ${agent.name} (${agent.key}, model=${agent.model}): ${agent.prompt}`
  ));
  return [
    `# Prompt-active Agent Roles (${stageKey(stage)})`,
    '',
    '只以下角色會進入今個 stage 嘅 working context；其他 roster roles 只留喺 Mission Panel 做狀態/路由說明，唔好自行展開全員角色。',
    '',
    ...rows,
    '',
  ].join('\n');
}

module.exports = {
  ROLE_CATALOG,
  buildIntelligence,
  mergeModelsWithRoute,
  applyResolvedModelsToIntelligence,
  compactAgentBriefForStage,
  promptActiveRoleKeysForStage,
  promptActiveRolesForStage,
};
