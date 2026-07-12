// Telegram inbound control for swarm-server.
//
// Long-polls getUpdates and maps authorized commands / inline-button callbacks
// onto the LOCAL REST API (http://127.0.0.1:PORT) — it reuses every endpoint's
// existing validation instead of touching internals.
//
// SECURITY: only updates from ALLOWED_CHAT_ID are honoured; everything else is
// ignored. Uses long-polling (outbound HTTPS) so NO inbound firewall port is
// needed. On boot it drains any backlog so a restart never replays stale
// commands (e.g. an old /mission).
//
// /mission and /council flow: Opus 先完善 prompt → 過目 preview →
//   ✅ 用完善版 / ✍️ 再俾意見完善（Opus 按意見再改，可無限重複）/ ↩️ 用我原本 / ❌ 取消
//   確認後：mission 再揀 build model 落 code；council 揀快速 / 平衡 / 深度 6-review / 9-grid。

const http = require('http');
const tg = require('./telegram');

// Build-model choices offered when writing code. First = default (Codex).
const GLM_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.SWARM_DISABLE_GLM || ''));
const MODEL_CHOICES_ALL = [
  { cli: 'codex',  model: 'gpt-5.5', label: 'Codex gpt-5.5' },
  { cli: 'claude', model: 'opus',    label: 'Opus 4.8' },
  { cli: 'claude', model: 'sonnet',  label: 'Sonnet' },
  { cli: 'glm',    model: 'glm-4.5', label: 'GLM 4.5' },
  { cli: 'glm',    model: 'glm-5.2', label: 'GLM 5.2（高負載）' },
];
const MODEL_CHOICES = GLM_DISABLED ? MODEL_CHOICES_ALL.filter((m) => m.cli !== 'glm') : MODEL_CHOICES_ALL;

const COUNCIL_MODES = {
  quick: { mode: 'quick', label: '快速', desc: '3份：A 架構 · B 實作 · C 風險' },
  balanced: { mode: 'balanced', label: '平衡', desc: '6份：3 model 自由觀點 + 3硬角色' },
  deep6: { mode: 'deep-6', label: '深度 6-review', desc: '6份：Opus + GPT-5.5 × 架構 / 實作 / 風險' },
  deep: { mode: 'deep-grid', label: '深度 9-grid', desc: '9份：3 model × 架構 / 實作 / 風險' },
};

const HELP = [
  '🤖 *Swarm 控制 bot*',
  '',
  '*同總管傾偈*（唔使指令，直接打字）',
  '直接打一句 → 總管 AI 睇晒所有 run/project 答你。',
  '預設 *自動*：傾 idea 快答(Sonnet)，叫佢 review/查 bug 先深入(Opus+skill)。',
  '`/auto` `/fast` `/deep` 揀模式｜`/brain opus` 切深入腦',
  '📷 直接傳截圖（可加文字）→ 總管睇圖分析 error/bug/UI，仲可交去議會',
  '',
  '*睇嘢*',
  '`/status` — 當前 run 狀態',
  '`/runs` — 列出最近 run（狀態 / stage）',
  '`/show [id]` — 某 run 詳情（gate / plan / 最近產出）；唔帶 id = 當前',
  '`/projects` — 列出可用 project',
  '`/project <編號或 run id 尾段>` — 設定 Telegram 新 mission / council 用邊個 project',
  '`/intentpack [auto|general|mvp|full]` — 設定新 mission / council 用邊套 Intent Pack',
  '`/domainmodule [auto|none|assessment|ui|assessment,ui]` — 設定 domain module',
  '',
  '*開工*',
  '`/council <題目>` — Opus 完善 → 過目 → 揀快速 / 平衡 / 深度 6-review / 9-grid → 開 AI 聯合國',
  '自然講法亦得：「開聯合國議會」「將呢個 plan 擺去聯合國」「叫 AI 聯合國審一審」。',
  '`/mission <plan>` — Opus 完善 → 過目 → 揀 model 落 code',
  '`/debate [id尾段]` — Council 獨立 review 完後，開始拗入 moderator 收斂',
  '`/revise [id尾段] <指示>` — 御准閘度叫議會就你意見再收斂一 round',
  '`/approve [id尾段]` — 批准御准閘',
  '`/execute [id尾段]` — 將議會終稿落實（揀 build model）',
  '`/stop` — 中途停止當前 run（殺晒 running agent）',
  '`/resume` — 由上次未完成 stage 重跑（修咗 code 後用嚟重試 verifier）',
  '',
  '御准／收斂通知會帶掣，直接撳就得。',
].join('\n');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tgline(s) {
  return String(s == null ? '' : s).replace(/[_*`\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function startBot({ apiBase, chatId, ownerUsers = [], allowedUsers = [], log = () => {} }) {
  if (!tg.tgEnabled()) { log('inbound bot disabled (no TG_BOT_TOKEN / TG_CHAT_ID)'); return { stop() {} }; }
  const norm = (arr) => new Set((Array.isArray(arr) ? arr : String(arr || '').split(','))
    .map((u) => String(u).trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
  const OWNER = String(chatId);          // owner chat id = full power
  const OWNER_USERS = norm(ownerUsers);  // 額外 full-power username（owner-tier）
  const GUESTS = norm(allowedUsers);     // 唯讀 guest username 白名單
  log(`auth: owner chat=${OWNER}${OWNER_USERS.size ? ', owner-users=' + [...OWNER_USERS].join(',') : ''}${GUESTS.size ? ', guests=' + [...GUESTS].join(',') : ''}`);
  let offset = 0;
  let running = true;

  // ── 每個 user 一份獨立 state（pending picks + overseer 記憶/模式），overseer 記憶持久化到 data/ ──
  const MEM_FILE = require('path').join(__dirname, '..', 'data', 'overseer-mem.json');
  const states = new Map();
  function blankState() {
    return { pendingMission: null, pendingCouncil: null, pendingRefine: null, awaitingRefineNote: false,
      pendingPush: null, awaitingPushBranch: false,
      pendingOverseerRevise: null, selectedProjectPath: null, selectedIntentPackKey: null, selectedDomainModuleKeys: null,
      overseerHistory: [], overseerModel: 'opus', overseerMode: 'auto' };
  }
  function stateFor(key) { if (!states.has(key)) states.set(key, blankState()); return states.get(key); }

  // 當前 dispatch 嘅 working set（updates 係 sequential 處理,逐個 await,唔會 race）
  let replyChatId = OWNER, currentRole = 'owner';
  let pendingMission, pendingCouncil, pendingRefine, awaitingRefineNote, pendingOverseerRevise, overseerHistory, overseerModel, overseerMode;
  let pendingPush, awaitingPushBranch, selectedProjectPath, selectedIntentPackKey, selectedDomainModuleKeys;
  function loadState(key) {
    const s = stateFor(key);
    pendingMission = s.pendingMission; pendingCouncil = s.pendingCouncil; pendingRefine = s.pendingRefine;
    awaitingRefineNote = s.awaitingRefineNote; pendingOverseerRevise = s.pendingOverseerRevise;
    pendingPush = s.pendingPush; awaitingPushBranch = s.awaitingPushBranch;
    selectedProjectPath = s.selectedProjectPath || null;
    selectedIntentPackKey = s.selectedIntentPackKey || null;
    selectedDomainModuleKeys = Array.isArray(s.selectedDomainModuleKeys) ? s.selectedDomainModuleKeys : null;
    overseerHistory = s.overseerHistory; overseerModel = s.overseerModel; overseerMode = s.overseerMode;
    if (overseerModel === 'claude-fable-5') overseerModel = 'opus';
  }
  function saveState(key) {
    const s = stateFor(key);
    s.pendingMission = pendingMission; s.pendingCouncil = pendingCouncil; s.pendingRefine = pendingRefine;
    s.awaitingRefineNote = awaitingRefineNote; s.pendingOverseerRevise = pendingOverseerRevise;
    s.pendingPush = pendingPush; s.awaitingPushBranch = awaitingPushBranch;
    s.selectedProjectPath = selectedProjectPath || null;
    s.selectedIntentPackKey = selectedIntentPackKey || null;
    s.selectedDomainModuleKeys = Array.isArray(selectedDomainModuleKeys) ? selectedDomainModuleKeys : null;
    if (overseerModel === 'claude-fable-5') overseerModel = 'opus';
    s.overseerHistory = overseerHistory; s.overseerModel = overseerModel; s.overseerMode = overseerMode;
    persistMem();
  }
  function persistMem() {
    try {
      const fs = require('fs');
      const out = {};
      for (const [k, s] of states) out[k] = { overseerHistory: s.overseerHistory, overseerModel: s.overseerModel === 'claude-fable-5' ? 'opus' : s.overseerModel, overseerMode: s.overseerMode, selectedProjectPath: s.selectedProjectPath || null, selectedIntentPackKey: s.selectedIntentPackKey || null, selectedDomainModuleKeys: Array.isArray(s.selectedDomainModuleKeys) ? s.selectedDomainModuleKeys : null };
      fs.writeFileSync(MEM_FILE, JSON.stringify(out));
    } catch (e) { log('persistMem: ' + e.message); }
  }
  function loadMem() {
    try {
      const raw = JSON.parse(require('fs').readFileSync(MEM_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        const s = stateFor(k);
        s.overseerHistory = Array.isArray(v.overseerHistory) ? v.overseerHistory : [];
        s.overseerModel = v.overseerModel === 'claude-fable-5' ? 'opus' : (v.overseerModel || 'opus');
        s.overseerMode = v.overseerMode || 'auto';
        s.selectedProjectPath = v.selectedProjectPath || null;
        s.selectedIntentPackKey = v.selectedIntentPackKey || null;
        s.selectedDomainModuleKeys = Array.isArray(v.selectedDomainModuleKeys) ? v.selectedDomainModuleKeys : null;
      }
    } catch (_) { /* first run / no file */ }
  }
  loadMem();
  loadState(OWNER);

  // 所有 bot 回覆都回返「講嘢嗰個 chat」（多 user 各自 chat）。
  function say(text, opts = {}) { return tg.sendMessage(text, { ...opts, chatId: replyChatId }); }
  function ownerOnly() { return currentRole === 'owner'; }
  async function denyGuest() { await say('🔒 呢個動作淨係 owner 做到。你而家係 guest——可以同總管傾偈 + 睇嘢（/runs /show /status /projects）。'); }

  // 記低每個接觸過 bot 嘅人:username / first_name → chatId,存 data/tg-users.json。
  // 用嚟畀 console（dashboard）揀「通知邊個」——server resolve username→chatId→run.tgChatId。
  // 連未授權嘅都記（淨係攞 chatId 嚟發通知,唔等於畀佢落指令）。
  const USERS_FILE = require('path').join(__dirname, '..', 'data', 'tg-users.json');
  function recordUser(from, chat) {
    try {
      if (!from || !chat || chat.id == null) return;
      const fs = require('fs');
      let reg = {};
      try { reg = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) {}
      const cid = String(chat.id);
      const prev = reg[cid] || {};
      reg[cid] = {
        chatId: cid,
        username: from.username ? String(from.username) : (prev.username || null),
        name: from.first_name ? String(from.first_name) : (prev.name || null),
        ts: Date.now(),
      };
      fs.writeFileSync(USERS_FILE, JSON.stringify(reg));
    } catch (e) { log('recordUser: ' + e.message); }
  }

  // 快答/深入:auto = 自己判斷（message 含 review/audit/bug/深入… → deep，否則 fast）；/fast /deep 係人手 sticky override。
  const DEEP_HINT = /review|audit|security|安全|\bbug\b|race|漏洞|refactor|重構|architect|架構|深入|睇.{0,4}code|檢查|核實|trace|root\s*cause|點解.{0,6}(錯|fail|crash|爆)/i;
  function pickMode(msg) {
    if (overseerMode === 'fast' || overseerMode === 'deep') return overseerMode;
    return DEEP_HINT.test(String(msg || '')) ? 'deep' : 'fast';
  }

  // Local REST helper → http://127.0.0.1:PORT
  function api(method, pathName, body, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const u = new URL(apiBase + pathName);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method,
          headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, json: {} }); } });
        }
      );
      req.on('error', (e) => resolve({ status: 0, json: { error: e.message } }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: { error: 'timeout' } }); });
      if (data) req.write(data);
      req.end();
    });
  }

  async function currentRun() {
    const r = await api('GET', '/api/state');
    return r.json && r.json.id ? r.json : null;
  }

  // 由 run id 尾段搵返個 run（push gate callback 用 <runTail> 鎖死目標 run，唔靠「當前 run」）。
  async function findRunByTail(tail) {
    const r = await api('GET', '/api/runs');
    const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.runs) || [];
    return arr.find((x) => String(x.id).endsWith(String(tail))) || null;
  }

  function projectPathOf(item) {
    return typeof item === 'string' ? item : (item && (item.path || item.projectPath || item.name)) || '';
  }

  function projectName(item) {
    const p = projectPathOf(item);
    return (item && item.label) || (p ? p.split('/').filter(Boolean).pop() : '') || 'project';
  }

  async function projectsPayload() {
    const r = await api('GET', '/api/projects');
    const projects = (r.json && r.json.projects) || [];
    const rows = [];
    if (r.json && r.json.defaultProjectRoot) rows.push({ path: r.json.defaultProjectRoot, label: 'default' });
    projects.forEach((p) => {
      const path = projectPathOf(p);
      if (path && !rows.some((x) => x.path === path)) rows.push({ path, label: projectName(p) });
    });
    return { defaultProjectRoot: (r.json && r.json.defaultProjectRoot) || '', projects: rows };
  }

  async function projectForNewRun() {
    if (selectedProjectPath) return selectedProjectPath;
    const payload = await projectsPayload();
    return (payload.projects[0] && payload.projects[0].path) || payload.defaultProjectRoot || undefined;
  }

  function normalizeIntentPackChoice(value) {
    const k = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!k || k === 'auto' || k === 'default') return null;
    if (k === 'mvp' || k === 'school_tracker' || k === 'mvp_school_tracker') return 'school_mvp';
    if (k === 'full' || k === 'school_os' || k === 'learning_os') return 'school_os_full';
    if (['general', 'school_mvp', 'school_os_full'].includes(k)) return k;
    return undefined;
  }

  async function intentPacksPayload(projectPath) {
    const p = projectPath || selectedProjectPath || await projectForNewRun();
    const r = await api('GET', `/api/intent-packs?projectPath=${encodeURIComponent(p || '')}`);
    return {
      defaultIntentPackKey: (r.json && r.json.defaultIntentPackKey) || 'general',
      defaultDomainModuleKeys: (r.json && r.json.defaultDomainModuleKeys) || [],
      packs: (r.json && (r.json.productScopes || r.json.packs)) || [],
      domainModules: (r.json && r.json.domainModules) || [],
      projectPath: (r.json && r.json.projectPath) || p || '',
    };
  }

  function intentPackLabel(packs, key) {
    const p = (packs || []).find((x) => x.key === key);
    return p ? (p.shortLabel || p.label || key) : key;
  }

  function domainModuleLabel(modules, key) {
    const m = (modules || []).find((x) => x.key === key);
    return m ? (m.shortLabel || m.label || key) : key;
  }

  function normalizeDomainModuleChoice(value) {
    const k = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!k || k === 'auto' || k === 'default') return null;
    if (k === 'none' || k === 'off') return [];
    if (/[,\|]/.test(String(value || ''))) {
      const out = [];
      String(value || '').split(/[,\|]+/).forEach((item) => {
        const picked = normalizeDomainModuleChoice(item);
        if (Array.isArray(picked)) picked.forEach((key) => { if (!out.includes(key)) out.push(key); });
      });
      return out;
    }
    if (['assessment', 'assessment_suite', 'assessment_intelligence', 'grading', 'marking', 'rubric'].includes(k)) return ['assessment_intelligence'];
    if (['ui', 'ux', 'visual', 'visual_qa', 'ui_qa', 'ui_visual', 'ui_visual_qa', 'screenshot', 'screenshot_loop', 'frontend_visual'].includes(k)) return ['ui_visual_qa'];
    if (k === 'assessment_ui' || k === 'ui_assessment') return ['assessment_intelligence', 'ui_visual_qa'];
    return undefined;
  }

  async function intentPackForNewRun(projectPath) {
    if (selectedIntentPackKey) return selectedIntentPackKey;
    const payload = await intentPacksPayload(projectPath);
    return payload.defaultIntentPackKey || 'general';
  }

  async function intentPackLine(projectPath, key) {
    const payload = await intentPacksPayload(projectPath);
    const k = key || selectedIntentPackKey || payload.defaultIntentPackKey || 'general';
    return {
      key: k,
      label: intentPackLabel(payload.packs, k),
      mode: selectedIntentPackKey ? 'manual' : 'auto',
      projectPath: payload.projectPath,
      packs: payload.packs,
      defaultIntentPackKey: payload.defaultIntentPackKey,
    };
  }

  async function domainModuleLine(projectPath) {
    const payload = await intentPacksPayload(projectPath);
    const keys = Array.isArray(selectedDomainModuleKeys) ? selectedDomainModuleKeys : (payload.defaultDomainModuleKeys || []);
    return {
      keys,
      labels: keys.map((key) => domainModuleLabel(payload.domainModules || [], key)),
      mode: Array.isArray(selectedDomainModuleKeys) ? 'manual' : 'auto',
      modules: payload.domainModules || [],
    };
  }

  function domainModuleKeyboard(modules) {
    const keys = Array.isArray(selectedDomainModuleKeys) ? selectedDomainModuleKeys : null;
    const rows = [
      [{ text: keys === null ? '✅ Auto' : 'Auto', callback_data: 'dm:auto' }],
      [{ text: Array.isArray(keys) && keys.length === 0 ? '✅ None' : 'None', callback_data: 'dm:none' }],
    ];
    (modules || []).forEach((m) => rows.push([{ text: `${keys && keys.includes(m.key) ? '✅ ' : ''}${m.shortLabel || m.label}`, callback_data: `dm:${m.key}` }]));
    return { inline_keyboard: rows };
  }

  function intentPackKeyboard(packs, selectedKey) {
    const rows = [[{ text: selectedKey ? '跟 project default' : '✅ 跟 project default', callback_data: 'ip:auto' }]];
    (packs || []).forEach((p) => rows.push([{ text: `${selectedKey === p.key ? '✅ ' : ''}${p.shortLabel || p.label}`, callback_data: `ip:${p.key}` }]));
    return { inline_keyboard: rows };
  }

  async function resolveRunFromTailOrCurrent(tail) {
    if (tail && tail !== 'current') return findRunByTail(tail);
    return currentRun();
  }

  function modelKeyboard(prefix) {
    return { inline_keyboard: MODEL_CHOICES.map((m, i) => [{ text: (i === 0 ? '✅ ' : '') + m.label, callback_data: `${prefix}:${m.cli}:${m.model}` }]) };
  }

  function councilModeKeyboard() {
    return { inline_keyboard: [
      [{ text: `⚡ ${COUNCIL_MODES.quick.label} — ${COUNCIL_MODES.quick.desc}`, callback_data: 'cm:quick' }],
      [{ text: `⚖️ ${COUNCIL_MODES.balanced.label} — ${COUNCIL_MODES.balanced.desc}`, callback_data: 'cm:balanced' }],
      [{ text: `🔬 ${COUNCIL_MODES.deep6.label} — ${COUNCIL_MODES.deep6.desc}`, callback_data: 'cm:deep6' }],
      [{ text: `🔬 ${COUNCIL_MODES.deep.label} — ${COUNCIL_MODES.deep.desc}`, callback_data: 'cm:deep' }],
    ] };
  }

  // council 落實：build agents = 揀嘅 model；reviewer/verifier 維持 Claude（verifier 一定要明設,否則 cli 跌 claude+gpt model 唔夾炸）。
  function execPerAgent(cli, model) {
    const build = { cli, model };
    return { frontend: build, backend: build, database: build, test: build, fixer: build, reviewer: { cli: 'claude', model: 'opus' }, verifier: { cli: 'claude', model: 'sonnet' } };
  }

  // mission：寫 code 嘅 agent = 揀嘅 model；研究／規劃／覆核／驗證固定 Claude。
  function missionPerAgent(cli, model) {
    const build = { cli, model };
    return {
      researcher: { cli: 'claude', model: 'opus' },
      planner: { cli: 'claude', model: 'opus' },
      reviewer: { cli: 'claude', model: 'opus' },
      verifier: { cli: 'claude', model: 'sonnet' },
      frontend: build, backend: build, database: build, test: build, fixer: build,
    };
  }

  // ── Opus 完善 → 過目 gate（可反覆改善）──
  async function sendRefinePreview() {
    if (!pendingRefine) return;
    const { kind, refined } = pendingRefine;
    const verb = kind === 'council' ? '開 AI 聯合國（Council）' : '落 code';
    const body = refined.length > 3400 ? refined.slice(0, 3400) + '\n…（preview 截短）' : refined;
    await say(
      `📝 Opus 完善版（${kind === 'council' ? '議題' : 'mission'}）：\n\n${body}\n\n——\n用呢個版本${verb}？或者再俾意見完善（可反覆）。`,
      {
        plain: true,
        replyMarkup: { inline_keyboard: [
          [{ text: '✅ 用完善版', callback_data: 'rf:use' }],
          [{ text: '✍️ 再俾意見完善', callback_data: 'rf:more' }],
          [{ text: '↩️ 用我原本', callback_data: 'rf:orig' }],
          [{ text: '❌ 取消', callback_data: 'rf:x' }],
        ] },
      }
    );
  }

  // 初次完善：粗略需求 → brief preview。失敗回 false（caller fallback 用原文）。
  async function refineAndPreview(kind, raw, topic) {
    await say('⏳ Opus 完善緊（約 15-40s）…');
    const rr = await api('POST', '/api/refine', { text: raw, kind }, 100000);
    if (rr.json && rr.json.ok && rr.json.refined) {
      pendingRefine = { kind, original: raw, refined: rr.json.refined, topic };
      await sendRefinePreview();
      return true;
    }
    log(`refine failed: ${(rr.json && rr.json.error) || rr.status}`);
    return false;
  }

  // 迭代修訂：用 base（上一版）+ note（用戶意見）再完善，更新 pendingRefine 後再 preview。
  async function reviseAndPreview(note) {
    if (!pendingRefine) { await say('冇待改善嘅內容（重新打指令）。'); return; }
    await say('⏳ Opus 按你意見再完善緊（約 15-40s）…');
    const rr = await api('POST', '/api/refine', { kind: pendingRefine.kind, base: pendingRefine.refined, note }, 100000);
    if (rr.json && rr.json.ok && rr.json.refined) pendingRefine.refined = rr.json.refined;
    else await say(`⚠️ 再完善失敗（${(rr.json && rr.json.error) || rr.status}），保留上一版。`);
    await sendRefinePreview();
  }

  // 揀 AI 聯合國深度模式 → 確認後開會。
  async function promptCouncilStrength(taskBrief) {
    pendingCouncil = { taskBrief };
    const proj = await projectForNewRun();
    const pack = await intentPackLine(proj);
    const modules = await domainModuleLine(proj);
    await say(`揀 AI 聯合國模式：\nProject：${tgline(proj || 'default')}\nProduct Scope：${tgline(pack.label)}（${pack.mode}）\nDomain Modules：${modules.labels.length ? modules.labels.map(tgline).join(', ') : (modules.mode === 'auto' ? 'Auto' : 'None')}`, { replyMarkup: councilModeKeyboard() });
  }

  async function startCouncil(taskBrief, councilMode = 'balanced') {
    const projectPath = await projectForNewRun();
    const intentPackKey = await intentPackForNewRun(projectPath);
    const pack = await intentPackLine(projectPath, intentPackKey);
    const domainModuleKeys = Array.isArray(selectedDomainModuleKeys) ? selectedDomainModuleKeys : undefined;
    const cr = await api('POST', '/api/runs', { topic: taskBrief.slice(0, 70), taskBrief, tgChatId: replyChatId, projectPath, intentPackKey, domainModuleKeys, source: 'telegram', createdFrom: 'telegram' });
    const run = cr.json && cr.json.run;
    if (!run) { await say(`⚠️ 開 run 失敗：${(cr.json && cr.json.error) || cr.status}`); return; }
    const mode = (COUNCIL_MODES[councilMode] && COUNCIL_MODES[councilMode].mode) || councilMode || 'balanced';
    const label = Object.values(COUNCIL_MODES).find((m) => m.mode === mode || m === councilMode);
    const sr = await api('POST', `/api/runs/${run.id}/council/start`, { councilMode: mode });
    const modules = (run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(', ');
    if (sr.json && sr.json.ok) await say(`🗳 AI 聯合國開波：*${tgline(taskBrief)}*\n模式：${(label && label.label) || mode}｜Scope：${tgline(pack.label)}${modules ? `｜Modules：${tgline(modules)}` : ''}｜Project：${tgline(projectPath || run.projectPath || 'default')}\nRun：\`${run.id.slice(-8)}\`\n獨立 review 完先 ping 你開拗；收斂到御准閘會再 ping。`);
    else await say(`⚠️ 開聯合國失敗：${(sr.json && sr.json.error) || sr.status}`);
  }

  async function promptMissionModel(taskBrief, topic) {
    pendingMission = { taskBrief, topic };
    const projectPath = await projectForNewRun();
    const pack = await intentPackLine(projectPath);
    const modules = await domainModuleLine(projectPath);
    await say(`揀「寫 code」用邊個 model（研究／覆核固定 Opus）：\nProject：${tgline(projectPath || 'default')}\nProduct Scope：${tgline(pack.label)}（${pack.mode}）\nDomain Modules：${modules.labels.length ? modules.labels.map(tgline).join(', ') : (modules.mode === 'auto' ? 'Auto' : 'None')}`, { replyMarkup: modelKeyboard('mm') });
  }

  async function doApprove(tail) {
    const run = await resolveRunFromTailOrCurrent(tail);
    if (!run || !(run.pipeline && run.pipeline.councilPaused)) { await say('而家冇御准閘可批准。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/council/approve`, {});
    if (r.json && r.json.ok) await say('✅ 已批准，出緊人話講解…');
    else await say(`⚠️ 批准失敗：${r.json.error || r.status}`);
  }

  async function doDebate(tail) {
    const run = await resolveRunFromTailOrCurrent(tail);
    if (!run || !(run.pipeline && run.pipeline.councilReviewPaused)) { await say('而家冇 review 閘可開拗。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/council/debate`, {});
    if (r.json && r.json.ok) await say('🥊 已開始拗，moderator 收斂緊…');
    else await say(`⚠️ 開拗失敗：${(r.json && r.json.error) || r.status}`);
  }

  async function doStop() {
    const run = await currentRun();
    if (!run) { await say('冇 active run 可停。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/stop`, {});
    if (r.json && r.json.ok) await say(`⏹ 已停止「${tgline(run.topic)}」（殺咗 ${r.json.killed} 個 running agent）。`);
    else await say(`⚠️ 停止失敗：${(r.json && r.json.error) || r.status}`);
  }

  async function doResume() {
    const run = await currentRun();
    if (!run) { await say('冇 run 可 resume。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/resume`, {}, 60000);
    if ((r.json && r.json.ok) || r.status === 200) await say(`▶️ 已 resume「${tgline(run.topic)}」——由上次未完成 stage 用最新 code 重跑。`);
    else await say(`⚠️ resume 失敗：${(r.json && r.json.error) || r.status}`);
  }

  async function doExecute(cli, model, tail) {
    const run = await resolveRunFromTailOrCurrent(tail);
    if (!run) { await say('冇 run 可落實。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/council/execute`, { model, perAgentModels: execPerAgent(cli, model) });
    if (r.json && r.json.ok) await say(`▶ 落實開波（build=${model}）：plan v${r.json.executingVersion}\nbuild → review → fix 跑緊，完成會 ping 你。`);
    else await say(`⚠️ 落實失敗：${r.json.error || r.status}`);
  }

  async function doMission(cli, model) {
    if (!pendingMission) { await say('冇待落實嘅 mission（重新打 `/mission <plan>`）。'); return; }
    const { taskBrief, topic } = pendingMission;
    pendingMission = null;
    const projectPath = await projectForNewRun();
    const intentPackKey = await intentPackForNewRun(projectPath);
    const pack = await intentPackLine(projectPath, intentPackKey);
    const domainModuleKeys = Array.isArray(selectedDomainModuleKeys) ? selectedDomainModuleKeys : undefined;
    const r = await api('POST', '/api/plans/run', {
      taskBrief, topic, deliveryMode: 'code', staged: true,
      cli, model, perAgentModels: missionPerAgent(cli, model), tgChatId: replyChatId, projectPath, intentPackKey, domainModuleKeys, source: 'telegram', createdFrom: 'telegram',
    });
    const modules = r.json && r.json.run ? ((r.json.run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(', ')) : '';
    if (r.json && r.json.ok) await say(`⚙️ Mission 開波（寫 code=${model}）：*${tgline(topic)}*\nScope：${tgline(pack.label)}${modules ? `｜Modules：${tgline(modules)}` : ''}｜Project：${tgline(projectPath || 'default')}${r.json.queued ? `\n排隊中 #${r.json.position}` : '\nresearch → build → review → fix 跑緊'}`);
    else await say(`⚠️ Mission 失敗：${(r.json && r.json.error) || r.status}`);
  }

  // ── Overseer:plain text → 帶全局 digest 嘅總管 AI（Tier 1 唯讀 + Tier 2 confirm-gate 動作）──
  async function handleOverseer(message, forceMode) {
    const mode = forceMode || pickMode(message);
    const deep = mode === 'deep';
    await say(deep ? '🧠 總管深入諗緊（會 review，慢啲）…' : '💬 諗緊…');
    overseerHistory.push({ role: 'user', content: message });
    const model = deep ? overseerModel : 'sonnet';
    const r = await api('POST', '/api/overseer', { message, model, mode, history: overseerHistory.slice(-6) }, deep ? 620000 : 255000);
    if (!(r.json && r.json.ok)) { await say(`⚠️ 總管出錯：${(r.json && r.json.error) || r.status}`); return; }
    const reply = r.json.reply || '(冇內容)';
    overseerHistory.push({ role: 'assistant', content: reply });
    if (overseerHistory.length > 12) overseerHistory = overseerHistory.slice(-12);
    if (r.json.action) await sendOverseerAction(reply, r.json.action);
    else await say(reply, { plain: true });
  }

  // 總管提議動作 → 破壞性動作要 confirm；已有下游 pick 嘅(execute/council/mission)直接入 pick 流程(pick=confirm)。
  async function sendOverseerAction(reply, action) {
    await say(reply, { plain: true });
    if (!ownerOnly()) { await say('（總管建議咗個動作，但淨係 owner 先執行到。）'); return; }
    const t = action.type;
    if (t === 'council') { await promptCouncilStrength(action.arg || ''); return; }
    if (t === 'mission') {
      const topic = (action.arg || '').split('\n')[0].replace(/^#+\s*/, '').slice(0, 70);
      await promptMissionModel(action.arg || '', topic); return;
    }
    if (t === 'execute') {
      const run = await currentRun();
      const tail = run && run.id ? run.id.slice(-8) : 'current';
      await say('揀 build model 落實：', { replyMarkup: modelKeyboard(`exm:${tail}`) });
      return;
    }
    const labels = { approve: '✅ 批准御准閘', debate: '🥊 開拗收斂', revise: '✍️ 叫議會再改', stop: '⏹ 停止當前 run' };
    if (t === 'revise') pendingOverseerRevise = action.arg || '';
    await say(
      `總管建議：*${labels[t] || t}*${t === 'revise' && action.arg ? `\n指示：${tgline(action.arg)}` : ''}\n做唔做？`,
      { replyMarkup: { inline_keyboard: [[
        { text: '✅ 確認', callback_data: `ov:${t}` },
        { text: '✋ 算', callback_data: 'ov:cancel' },
      ]] } }
    );
  }

  // 收到圖（screenshot of error/bug/UI）→ 下載 → 餵總管 deep 模式（vision 睇圖）。caption 做問題。
  async function handlePhoto(fileId, caption) {
    await say('🖼 收到圖，下載 + 分析緊（deep）…');
    const fs = require('fs'); const path = require('path');
    const dir = path.join(__dirname, '..', 'data', 'tg-uploads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const dest = path.join(dir, `${Date.now()}_${String(fileId).slice(-8)}.jpg`);
    const ok = await tg.downloadFile(fileId, dest);
    if (!ok) { await say('⚠️ 下載圖片失敗。'); return; }
    const msg = `${caption || '睇下呢張截圖有咩 error / bug，或者想點改 UI？'}\n\n[用戶附咗一張截圖，絕對路徑：${dest} —— 請用 Read tool 打開嚟睇，再答；若要交去 swarm 議會就出 ACTION: council:<題>]`;
    await handleOverseer(msg, 'deep'); // 圖一定要 vision + 深入
  }

  async function handleCommand(text) {
    const trimmed = text.trim();

    // 迭代完善：等緊改善意見、又唔係新指令 → 當作 refine note 處理。
    if (awaitingRefineNote && pendingRefine && !trimmed.startsWith('/')) {
      awaitingRefineNote = false;
      await reviseAndPreview(trimmed);
      return;
    }
    if (awaitingRefineNote) awaitingRefineNote = false; // 打咗新指令 → 放棄等意見

    // 任務一:push gate 等緊 branch 名、又唔係新指令 → 當作 retarget branch。
    if (awaitingPushBranch && pendingPush && pendingPush.runTail && !trimmed.startsWith('/')) {
      awaitingPushBranch = false;
      const tail = pendingPush.runTail; pendingPush = null;
      const run = await findRunByTail(tail);
      if (!run) { await say('搵唔到對應嘅 run（gate 可能過咗期）。'); return; }
      const r = await api('POST', `/api/runs/${run.id}/push/retarget`, { branch: trimmed });
      if (r.json && r.json.ok) await say(`🌿 已轉 branch：*${tgline(trimmed)}*，gate 重發咗,確認 push。`);
      else await say(`⚠️ 改 branch 失敗：${(r.json && r.json.error) || r.status}`);
      return;
    }
    if (awaitingPushBranch) awaitingPushBranch = false; // 打咗新指令 → 放棄等 branch

    // 唔係指令（冇 /）→ 同總管 AI 傾偈。
    if (trimmed && !trimmed.startsWith('/')) { await handleOverseer(trimmed); return; }

    const cmd = trimmed.split(/\s+/)[0];
    const arg = trimmed.slice(cmd.length).trim();
    const c = cmd.toLowerCase().replace(/@.*$/, '');

    if (c === '/start' || c === '/help') { await say(HELP); return; }

    if (c === '/brain') {
      const a = arg.toLowerCase();
      if (a === 'opus' || !a) overseerModel = 'opus';
      else { await say('用法：`/brain opus`（深入腦用 Opus）'); return; }
      const modeLabel = overseerMode === 'deep' ? '深入(鎖)' : overseerMode === 'fast' ? '快答(鎖)' : '自動';
      await say(`🧠 深入腦：*Opus 4.8*｜模式：*${modeLabel}*\n切腦：\`/brain opus\`　模式：\`/auto\`（自己判斷）/ \`/fast\` / \`/deep\``);
      return;
    }

    if (c === '/auto') { overseerMode = 'auto'; await say('🤖 *自動模式*：我自己判斷——傾 idea 用快答(Sonnet)，叫我 review / audit / 查 bug 先深入(Opus+skill)。'); return; }
    if (c === '/fast') { overseerMode = 'fast'; await say('💬 *鎖快答*：之後一律 Sonnet 快答。返自動：`/auto`'); return; }
    if (c === '/deep') { overseerMode = 'deep'; await say('🧠 *鎖深入*：之後一律 Opus+skill。返自動：`/auto`'); return; }

    if (c === '/intentpack') {
      if (!ownerOnly()) { await denyGuest(); return; }
      const projectPath = await projectForNewRun();
      const payload = await intentPacksPayload(projectPath);
      if (arg) {
        const next = normalizeIntentPackChoice(arg);
        if (next === undefined) { await say('用法：`/intentpack auto|general|mvp|full`'); return; }
        selectedIntentPackKey = next;
      }
      const cur = selectedIntentPackKey || payload.defaultIntentPackKey || 'general';
      const mode = selectedIntentPackKey ? 'manual override' : 'auto 跟 project default';
      await say(
        `🎯 Intent Pack：*${tgline(intentPackLabel(payload.packs, cur))}*\n模式：${mode}\nProject default：${tgline(intentPackLabel(payload.packs, payload.defaultIntentPackKey || 'general'))}\nProject：${tgline(projectPath || 'default')}`,
        { replyMarkup: intentPackKeyboard(payload.packs, selectedIntentPackKey) }
      );
      return;
    }

    if (c === '/domainmodule') {
      if (!ownerOnly()) { await denyGuest(); return; }
      const projectPath = await projectForNewRun();
      const payload = await intentPacksPayload(projectPath);
      if (arg) {
        const next = normalizeDomainModuleChoice(arg);
        if (next === undefined) { await say('用法：`/domainmodule auto|none|assessment|ui|assessment,ui`'); return; }
        selectedDomainModuleKeys = next;
      }
      const line = await domainModuleLine(projectPath);
      await say(
        `🧩 Domain Modules：*${line.labels.length ? line.labels.map(tgline).join(', ') : (line.mode === 'auto' ? 'Auto' : 'None')}*\n模式：${line.mode}\nProject：${tgline(projectPath || 'default')}`,
        { replyMarkup: domainModuleKeyboard(payload.domainModules || []) }
      );
      return;
    }

    if (c === '/status') {
      const run = await currentRun();
      if (!run) { await say('🟦 而家冇 active run。'); return; }
      const p = run.pipeline || {};
      const gate = p.councilPaused ? '⏸ 等御准' : (p.councilReviewPaused ? '🔎 等開拗' : '');
      const mode = p.mode || (run.metrics && run.metrics.deliveryMode) || '-';
      const pack = (run.intentPackSnapshot && (run.intentPackSnapshot.shortLabel || run.intentPackSnapshot.label)) || run.intentPackLabel || run.intentPackKey || 'General';
      const modules = (run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(', ') || '-';
      await say(`📊 *${tgline(run.topic)}*\n狀態：${run.status}｜stage：${run.stage || '-'} ${gate}\nmode：${p.councilModeLabel || mode}${p.councilPlanVersion ? `｜plan v${p.councilPlanVersion}` : ''}\nScope：${tgline(pack)}\nModules：${tgline(modules)}\nProject：${tgline(run.projectPath || '-')}\nHandoffs：${(run.handoffs || []).length || 0}｜Memory：${run.memoryPackStatus ? `in ${(run.memoryPackStatus.included || []).length} / missing ${(run.memoryPackStatus.missing || []).length}` : '-'}`);
      return;
    }

    if (c === '/council') {
      if (!ownerOnly()) { await denyGuest(); return; }
      if (!arg) { await say('用法：`/council <題目>`'); return; }
      const ok = await refineAndPreview('council', arg, arg.slice(0, 70));
      if (!ok) { await say('（完善失敗，用你原本嘅題目開會）'); await promptCouncilStrength(arg); }
      return;
    }

    if (c === '/mission') {
      if (!ownerOnly()) { await denyGuest(); return; }
      if (!arg) { await say('用法：`/mission <markdown plan>`'); return; }
      const topic = arg.split('\n')[0].replace(/^#+\s*/, '').slice(0, 70);
      const ok = await refineAndPreview('mission', arg, topic);
      if (!ok) { await say('（完善失敗，用你原本嘅 prompt）'); await promptMissionModel(arg, topic); }
      return;
    }

    if (c === '/revise') {
      if (!ownerOnly()) { await denyGuest(); return; }
      if (!arg) { await say('用法：`/revise [id尾段] <你嘅指示>`'); return; }
      const m = arg.match(/^([A-Za-z0-9_-]{4,16})\s+([\s\S]+)$/);
      let run = null; let note = arg;
      if (m) {
        const hit = await findRunByTail(m[1]);
        if (hit) { run = hit; note = m[2].trim(); }
      }
      if (!run) run = await currentRun();
      if (!run || !(run.pipeline && run.pipeline.councilPaused)) { await say('而家冇御准閘可以再改。'); return; }
      const r = await api('POST', `/api/runs/${run.id}/council/revise`, { note });
      if (r.json && r.json.ok) await say(`✍️ 已要求再改，重跑第 ${r.json.round} round 共識…`);
      else await say(`⚠️ 再改失敗：${(r.json && r.json.error) || r.status}`);
      return;
    }

    if (c === '/approve') { if (!ownerOnly()) { await denyGuest(); return; } await doApprove(arg || null); return; }
    if (c === '/debate') { if (!ownerOnly()) { await denyGuest(); return; } await doDebate(arg || null); return; }

    if (c === '/execute') {
      if (!ownerOnly()) { await denyGuest(); return; }
      const run = await resolveRunFromTailOrCurrent(arg || null);
      if (!run) { await say('冇 run 可落實。'); return; }
      await say(`揀 build model 落實：\nRun：\`${run.id.slice(-8)}\``, { replyMarkup: modelKeyboard(`exm:${run.id.slice(-8)}`) });
      return;
    }

    if (c === '/stop') { if (!ownerOnly()) { await denyGuest(); return; } await doStop(); return; }
    if (c === '/resume') { if (!ownerOnly()) { await denyGuest(); return; } await doResume(); return; }

    if (c === '/runs') {
      const r = await api('GET', '/api/runs');
      const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.runs) || [];
      if (!arr.length) { await say('🟦 冇 run。'); return; }
      const lines = arr.slice(-10).reverse().map((x) => {
        const run = (x.runningAgents ? `▶${x.runningAgents}` : x.status);
        const pack = x.intentPackLabel || x.intentPackKey || 'General';
        const modules = (x.domainModuleLabels || []).join(', ');
        return `• \`${x.id}\`\n  ${tgline(x.topic)} — ${run}/${x.stage || '-'}｜${tgline(pack)}${modules ? '｜' + tgline(modules) : ''}`;
      });
      await say(`🗂 *最近 run*\n${lines.join('\n')}\n\n詳情：\`/show <id 或尾段>\``);
      return;
    }

    if (c === '/show') {
      let run = null;
      if (arg) {
        const lr = await api('GET', '/api/runs');
        const arr = Array.isArray(lr.json) ? lr.json : (lr.json && lr.json.runs) || [];
        const hit = arr.find((x) => x.id === arg || x.id.endsWith(arg));
        if (hit) { const dr = await api('GET', `/api/runs/${hit.id}`); run = dr.json && dr.json.id ? dr.json : null; }
      } else { run = await currentRun(); }
      if (!run) { await say('搵唔到嗰個 run（用 /runs 攞 id）。'); return; }
      const p = run.pipeline || {};
      const gate = p.councilPaused ? '⏸ 等御准' : (p.councilReviewPaused ? '🔎 等開拗' : '');
      const planV = p.councilPlanVersion ? `｜plan v${p.councilPlanVersion}` : '';
      const arts = (run.artifacts || []).slice(-4).map((a) => `· ${tgline(a.title || a.type)}`).join('\n') || '（暫無）';
      const mem = run.memoryPackStatus ? `included=${(run.memoryPackStatus.included || []).join(', ') || '-'}｜missing=${(run.memoryPackStatus.missing || []).join(', ') || '-'}` : '-';
      const pack = (run.intentPackSnapshot && (run.intentPackSnapshot.shortLabel || run.intentPackSnapshot.label)) || run.intentPackLabel || run.intentPackKey || 'General';
      const modules = (run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(', ') || '-';
      const h = (run.handoffs || [])[0];
      const handoff = h ? `${tgline(h.agentName)}：${tgline(h.summary || '')}${(h.warnings || []).length ? `\n警告：${tgline((h.warnings || []).slice(0, 2).join(' / '))}` : ''}` : '（暫無）';
      await say(`📄 *${tgline(run.topic)}*\n狀態：${run.status}｜stage：${run.stage || '-'} ${gate}\nmode：${p.councilModeLabel || p.mode || (run.metrics && run.metrics.deliveryMode) || '-'}${planV}\nScope：${tgline(pack)}\nModules：${tgline(modules)}\nProject：${tgline(run.projectPath || '-')}\nMemory：${mem}\n最近 handoff：${handoff}\n最近產出：\n${arts}`);
      return;
    }

    if (c === '/projects') {
      const payload = await projectsPayload();
      const ps = payload.projects || [];
      const lines = ps.slice(0, 12).map((pr, i) => `${i}. ${selectedProjectPath === pr.path ? '✅ ' : ''}${tgline(pr.label || projectName(pr))}\n   ${tgline(pr.path)}`);
      const kb = ps.slice(0, 12).map((pr, i) => [{ text: `${selectedProjectPath === pr.path ? '✅ ' : ''}${tgline(pr.label || projectName(pr))}`, callback_data: `sp:${i}` }]);
      await say(`📁 *Project*\n${lines.join('\n') || '（無）'}\n\n用 \`/project <編號>\` 設定 Telegram 新任務 target。`, { replyMarkup: kb.length ? { inline_keyboard: kb } : undefined });
      return;
    }

    if (c === '/project') {
      if (!ownerOnly()) { await denyGuest(); return; }
      const payload = await projectsPayload();
      const ps = payload.projects || [];
      const idx = Number(arg);
      let next = '';
      if (Number.isInteger(idx) && ps[idx]) next = ps[idx].path;
      else if (arg) {
        const hitRun = await findRunByTail(arg);
        if (hitRun && hitRun.projectPath) next = hitRun.projectPath;
        else {
          const hit = ps.find((p) => p.path === arg || (p.path || '').endsWith(arg) || String(p.label || '').toLowerCase() === arg.toLowerCase());
          if (hit) next = hit.path;
        }
      }
      if (!next) { await say('搵唔到 project。用 `/projects` 睇編號，或 `/project <run id尾段>` 跟返某個 run。'); return; }
      selectedProjectPath = next;
      const pack = await intentPackLine(next);
      await say(`📁 已設定 Telegram 新 mission / council project：\n${tgline(next)}\nIntent Pack：${tgline(pack.label)}（${pack.mode}）`);
      return;
    }

    await say('唔識呢個指令。打 /help 睇清單。');
  }

  async function handleCallback(cb) {
    const dataStr = cb.data || '';
    await tg.answerCallbackQuery(cb.id);

    // refine 過目 gate
    if (dataStr === 'rf:more') {
      if (!pendingRefine) { await say('冇待改善嘅內容（重新打指令）。'); return; }
      awaitingRefineNote = true;
      await say('✍️ 直接打你想改善／補充邊幾個位，我會用 Opus 按你意見再完善（可以一路重複）：');
      return;
    }
    if (dataStr === 'rf:use' || dataStr === 'rf:orig') {
      if (!pendingRefine) { await say('冇待確認嘅完善內容（重新打指令）。'); return; }
      const { kind, original, refined, topic } = pendingRefine;
      const chosen = dataStr === 'rf:use' ? refined : original;
      pendingRefine = null;
      awaitingRefineNote = false;
      if (kind === 'mission') await promptMissionModel(chosen, topic);
      else await promptCouncilStrength(chosen);
      return;
    }
    if (dataStr === 'rf:x') { pendingRefine = null; awaitingRefineNote = false; await say('已取消。'); return; }

    if (dataStr.startsWith('cg:')) {
      const parts = dataStr.split(':');
      const action = parts[1]; const tail = parts[2] || null;
      if (!ownerOnly()) { await denyGuest(); return; }
      if (action === 'approve') { await doApprove(tail); return; }
      if (action === 'debate') { await doDebate(tail); return; }
      if (action === 'revise') { await say(`打 \`/revise ${tail} <你嘅指示>\` 叫呢個 run 再收斂一 round。`); return; }
      if (action === 'execute') { await say(`揀 build model 落實：\nRun：\`${tail}\``, { replyMarkup: modelKeyboard(`exm:${tail || 'current'}`) }); return; }
    }
    if (dataStr === 'approve') { await doApprove(); return; } // old fallback
    if (dataStr === 'debate') { await doDebate(); return; }   // old fallback
    if (dataStr === 'revise_hint') { await say('打 `/revise [id尾段] <你嘅指示>` 叫議會就你嘅意見再收斂一 round。'); return; }
    if (dataStr === 'execute') {
      const run = await currentRun();
      const tail = run && run.id ? run.id.slice(-8) : 'current';
      await say('揀 build model 落實：', { replyMarkup: modelKeyboard(`exm:${tail}`) });
      return;
    }
    if (dataStr.startsWith('exm:')) {
      const p = dataStr.split(':');
      if (p.length >= 4) await doExecute(p[2], p[3], p[1]);
      else await doExecute(p[1], p[2]);
      return;
    }
    if (dataStr.startsWith('cm:')) {
      if (!pendingCouncil) { await say('冇待開嘅議會（重新打 /council）。'); return; }
      const which = dataStr.split(':')[1];
      const { taskBrief } = pendingCouncil;
      pendingCouncil = null;
      await startCouncil(taskBrief, which || 'balanced');
      return;
    }
    if (dataStr.startsWith('sp:')) {
      if (!ownerOnly()) { await denyGuest(); return; }
      const idx = Number(dataStr.split(':')[1]);
      const payload = await projectsPayload();
      const pr = (payload.projects || [])[idx];
      if (!pr || !pr.path) { await say('Project 選項已過期，打 /projects 再揀一次。'); return; }
      selectedProjectPath = pr.path;
      const pack = await intentPackLine(pr.path);
      await say(`📁 已設定 Telegram 新任務 project：\n${tgline(pr.path)}\nIntent Pack：${tgline(pack.label)}（${pack.mode}）`);
      return;
    }
    if (dataStr.startsWith('ip:')) {
      if (!ownerOnly()) { await denyGuest(); return; }
      const raw = dataStr.split(':')[1] || 'auto';
      const next = normalizeIntentPackChoice(raw);
      if (next === undefined) { await say('Intent Pack 選項已過期，打 `/intentpack` 再揀一次。'); return; }
      selectedIntentPackKey = next;
      const projectPath = await projectForNewRun();
      const payload = await intentPacksPayload(projectPath);
      const cur = selectedIntentPackKey || payload.defaultIntentPackKey || 'general';
      await say(`🎯 Intent Pack 已設定：*${tgline(intentPackLabel(payload.packs, cur))}*（${selectedIntentPackKey ? 'manual' : 'auto'}）`);
      return;
    }
    if (dataStr.startsWith('dm:')) {
      if (!ownerOnly()) { await denyGuest(); return; }
      const raw = dataStr.split(':')[1] || 'auto';
      const next = normalizeDomainModuleChoice(raw);
      if (next === undefined) { await say('Domain Module 選項已過期，打 `/domainmodule` 再揀一次。'); return; }
      selectedDomainModuleKeys = next;
      const projectPath = await projectForNewRun();
      const line = await domainModuleLine(projectPath);
      await say(`🧩 Domain Modules 已設定：*${line.labels.length ? line.labels.map(tgline).join(', ') : (line.mode === 'auto' ? 'Auto' : 'None')}*（${line.mode}）`);
      return;
    }
    // 總管動作 confirm-gate（Tier 2 破壞性動作守關）
    if (dataStr === 'ov:cancel') { pendingOverseerRevise = null; await say('已取消。'); return; }
    if (dataStr === 'ov:approve') { await doApprove(); return; }
    if (dataStr === 'ov:debate') { await doDebate(); return; }
    if (dataStr === 'ov:stop') { await doStop(); return; }
    if (dataStr === 'ov:revise') {
      const note = pendingOverseerRevise; pendingOverseerRevise = null;
      if (!note) { await say('冇 revise 指示。'); return; }
      const run = await currentRun();
      if (!run || !(run.pipeline && run.pipeline.councilPaused)) { await say('而家冇御准閘可以再改。'); return; }
      const r = await api('POST', `/api/runs/${run.id}/council/revise`, { note });
      if (r.json && r.json.ok) await say(`✍️ 已要求再改,重跑第 ${r.json.round} round 共識…`);
      else await say(`⚠️ 再改失敗：${(r.json && r.json.error) || r.status}`);
      return;
    }
    if (dataStr.startsWith('mm:')) { const p = dataStr.split(':'); await doMission(p[1], p[2]); return; }

    // 改咗乜（全清單）:cr:<runTail> → server 記錄嘅 change reports,plain 分段送
    if (dataStr.startsWith('cr:')) {
      const tail = dataStr.split(':')[1];
      const run = await findRunByTail(tail);
      if (!run) { await say('搵唔到對應嘅 run。'); return; }
      const r = await api('GET', `/api/runs/${run.id}/changes?patch=0`);
      const reports = (r.json && r.json.reports) || [];
      if (!reports.length) { await say('呢個 run 冇 change report（唔係 git repo 或者冇改到 file）。'); return; }
      const t = (r.json && r.json.totals) || {};
      const blocks = [`📝 改咗乜 · ${run.topic || run.id}\n合共 ${t.reports || reports.length} 個 stage,${t.files || '?'} 個 file（+${t.adds || 0}/−${t.dels || 0}）`];
      for (const rep of reports) {
        const files = (rep.filesChanged || [])
          .map((f) => `  ${f.status || 'M'} ${f.path}${(f.adds != null || f.dels != null) ? ` +${f.adds || 0}/−${f.dels || 0}` : ''}`);
        if (rep.filesOmitted) files.push(`  …仲有 ${rep.filesOmitted} 個未列`);
        blocks.push([
          `── ${rep.stageTitle || rep.stageKey || 'stage'}${rep.followupSeq ? ` · 跟進#${rep.followupSeq}` : ''} ──`,
          `${(rep.filesChanged || []).length} file · +${rep.totalAdds || 0}/−${rep.totalDels || 0}${rep.error ? ` · ⚠${rep.error}` : ''}`,
          ...files,
        ].join('\n'));
      }
      blocks.push('完整 diff 開 Swarm Dashboard 個 run 睇「改咗乜」panel。');
      // 分段 ≤3500 字 plain 送（Telegram 上限 4096）
      let chunk = '';
      for (const b of blocks) {
        if (chunk && (chunk.length + b.length + 2) > 3500) { await say(chunk, { plain: true }); chunk = ''; }
        chunk = chunk ? `${chunk}\n\n${b}` : b;
        while (chunk.length > 3500) { await say(chunk.slice(0, 3500), { plain: true }); chunk = chunk.slice(3500); }
      }
      if (chunk) await say(chunk, { plain: true });
      return;
    }

    // 任務一:Push gate 確認（pg:<action>:<runTail>[:idx]）
    if (dataStr.startsWith('pg:')) {
      const parts = dataStr.split(':'); // pg : action : tail [: idx]
      const action = parts[1], tail = parts[2];
      if (!ownerOnly()) { await denyGuest(); return; }
      if (action === 'branch') {
        pendingPush = { runTail: tail }; awaitingPushBranch = true;
        await say('✏️ 直接打你想 push 去邊個 branch（例 `feature/mvp-sprint` 或一個新 branch 名）：');
        return;
      }
      if (action === 'project') {
        const r = await api('GET', '/api/projects');
        const ps = (r.json && r.json.projects) || [];
        const kb = ps.slice(0, 12).map((pr, i) => {
          const lab = typeof pr === 'string' ? pr : (pr.label || pr.path || '');
          return [{ text: tgline(String(lab).split('/').pop() || lab), callback_data: `pg:proj:${tail}:${i}` }];
        });
        if (!kb.length) { await say('冇可揀 project。'); return; }
        await say('📁 揀 project push 去：', { replyMarkup: { inline_keyboard: kb } });
        return;
      }
      const run = await findRunByTail(tail);
      if (!run) { await say('搵唔到對應嘅 run（gate 可能過咗期）。'); return; }
      if (action === 'confirm') {
        const r = await api('POST', `/api/runs/${run.id}/push`, { confirm: true });
        if (r.json && r.json.ok) await say('⬆️ Push 緊…完成會 ping 你。');
        else await say(`⚠️ Push 觸發失敗：${(r.json && r.json.error) || r.status}`);
      } else if (action === 'cancel') {
        await api('POST', `/api/runs/${run.id}/push/decline`, {});
        await say('✋ 已取消 push。');
      } else if (action === 'proj') {
        const idx = Number(parts[3]);
        const r = await api('POST', `/api/runs/${run.id}/push/retarget`, { projectIdx: idx });
        if (r.json && r.json.ok) await say('📁 已轉 project，gate 重發咗,確認 push。');
        else await say(`⚠️ 改 project 失敗：${(r.json && r.json.error) || r.status}`);
      }
      return;
    }
  }

  // owner(chat.id 對得上) → 全權；username 喺 guest 白名單 → 唯讀；其餘忽略。
  function identify(from, chat) {
    const cid = chat && chat.id != null ? String(chat.id) : '';
    const uname = from && from.username ? String(from.username).toLowerCase() : '';
    const uid = from && from.id != null ? String(from.id) : cid;
    let role = null;
    if (cid === OWNER || uid === OWNER || (uname && OWNER_USERS.has(uname))) role = 'owner';
    else if (uname && GUESTS.has(uname)) role = 'guest';
    return { role, key: uname || uid || cid, chatId: cid };
  }

  async function dispatch(u) {
    if (u.message && Array.isArray(u.message.photo) && u.message.photo.length) {
      recordUser(u.message.from, u.message.chat);
      const id = identify(u.message.from, u.message.chat);
      if (!id.role) { log(`ignored photo from ${id.key || u.message.chat.id}`); return; }
      replyChatId = id.chatId; currentRole = id.role; loadState(id.key);
      try {
        const ph = u.message.photo; // 最後一張 = 最大尺寸
        await handlePhoto(ph[ph.length - 1].file_id, (u.message.caption || '').trim());
      } finally { saveState(id.key); }
    } else if (u.message && u.message.text) {
      recordUser(u.message.from, u.message.chat);
      const id = identify(u.message.from, u.message.chat);
      if (!id.role) { log(`ignored message from ${id.key || u.message.chat.id}`); return; }
      replyChatId = id.chatId; currentRole = id.role; loadState(id.key);
      try { await handleCommand(u.message.text); } finally { saveState(id.key); }
    } else if (u.callback_query) {
      const cb = u.callback_query;
      recordUser(cb.from, cb.message && cb.message.chat);
      const id = identify(cb.from, cb.message && cb.message.chat);
      if (!id.role) { await tg.answerCallbackQuery(cb.id, '未授權'); return; }
      replyChatId = id.chatId; currentRole = id.role; loadState(id.key);
      try { await handleCallback(cb); } finally { saveState(id.key); }
    }
  }

  // 處理同 polling 解耦：poll loop 淨係 fetch + enqueue（永不 await handling），
  // 背景 pump 逐個 sequential 處理（per-user state 安全）。一個慢/卡嘅 turn 唔會再 freeze polling
  // → bot 永遠 alive、收到晒 message（之前 await dispatch 令一個慢 overseer turn 凍死成個 bot）。
  const updateQueue = [];
  let pumping = false;
  async function pumpUpdates() {
    if (pumping) return;
    pumping = true;
    try {
      while (updateQueue.length) {
        const u = updateQueue.shift();
        try { await dispatch(u); } catch (e) { log('dispatch error: ' + e.message); }
      }
    } finally { pumping = false; }
  }

  async function loop() {
    while (running) {
      try {
        const res = await tg.getUpdates(offset, 25);
        if (res && res.ok && Array.isArray(res.result)) {
          for (const u of res.result) { offset = u.update_id + 1; updateQueue.push(u); }
          if (updateQueue.length) pumpUpdates(); // 唔 await：polling 繼續，handling 喺背景
        } else if (res && (res.error || res.ok === false)) {
          await sleep(3000);
        }
      } catch (e) { log('poll error: ' + e.message); await sleep(3000); }
    }
  }

  // Boot backlog：只跳過**真.stale**（>120s，e.g. 重啟前好耐嘅舊 /mission），
  // 但**保留近期訊息**（deploy/restart 嗰幾秒間 user 發嘅）→ 唔好再食咗 partner 嘅 message。
  (async () => {
    try {
      const res = await tg.getUpdates(0, 0);
      if (res && res.ok && Array.isArray(res.result) && res.result.length) {
        const nowSec = Math.floor(Date.now() / 1000);
        let recent = 0;
        for (const u of res.result) {
          offset = u.update_id + 1;
          const ts = (u.message && u.message.date)
            || (u.callback_query && u.callback_query.message && u.callback_query.message.date) || 0;
          if (ts && (nowSec - ts) <= 120) { updateQueue.push(u); recent += 1; }
        }
        if (recent) { log(`backlog: ${recent} 條近期訊息 re-queue（唔食咗佢）`); pumpUpdates(); }
      }
    } catch (_) { /* ignore */ }
    log('inbound bot started (long-poll, gentle drain)');
    loop();
  })();

  return { stop() { running = false; } };
}

module.exports = { startBot };
