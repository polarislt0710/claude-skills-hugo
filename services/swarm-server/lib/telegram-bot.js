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
//   確認後：mission 再揀 build model 落 code；council 開三模議會。

const http = require('http');
const tg = require('./telegram');

// Build-model choices offered when writing code. First = default (Codex).
// Fable 5 係可揀但唔係預設 — bulk 寫 code 唔鼓勵燒旗艦,需要先手揀。
const MODEL_CHOICES = [
  { cli: 'codex',  model: 'gpt-5.5', label: 'Codex gpt-5.5' },
  { cli: 'claude', model: 'opus',    label: 'Opus 4.8' },
  { cli: 'claude', model: 'sonnet',  label: 'Sonnet' },
  { cli: 'glm',    model: 'glm-5.1', label: 'GLM 5.1' },
  { cli: 'claude', model: 'claude-fable-5', label: 'Fable 5 (至尊·貴)' },
];

// 議會陣容：standard = server 預設(A=Opus,B=Codex,C=GLM);fable = seat A 升旗艦 Fable。
const COUNCIL_STRENGTH = {
  standard: null,
  fable: {
    council_a: { cli: 'claude', model: 'claude-fable-5' },
    council_b: { cli: 'codex',  model: 'gpt-5.5' },
    council_c: { cli: 'glm',    model: 'glm-5.1' },
    moderator: { cli: 'claude', model: 'opus' },
    explainer: { cli: 'claude', model: 'sonnet' },
  },
};

const HELP = [
  '🤖 *Swarm 控制 bot*',
  '',
  '*同總管傾偈*（唔使指令，直接打字）',
  '直接打一句 → 總管 AI 睇晒所有 run/project 答你。',
  '預設 *自動*：傾 idea 快答(Sonnet)，叫佢 review/查 bug 先深入(Opus+skill)。',
  '`/auto` `/fast` `/deep` 揀模式｜`/brain opus|fable` 切深入腦',
  '',
  '*睇嘢*',
  '`/status` — 當前 run 狀態',
  '`/runs` — 列出最近 run（狀態 / stage）',
  '`/show [id]` — 某 run 詳情（gate / plan / 最近產出）；唔帶 id = 當前',
  '`/projects` — 列出可用 project',
  '',
  '*開工*',
  '`/council <題目>` — Opus 完善 → 過目 → 揀陣容（含 👑Fable 領銜）→ 開三模議會',
  '`/mission <plan>` — Opus 完善 → 過目 → 揀 model（含 Fable）落 code',
  '`/debate` — 三模獨立 review 完後，開始拗入 moderator 收斂',
  '`/revise <指示>` — 御准閘度叫議會就你意見再收斂一 round',
  '`/approve` — 批准當前御准閘',
  '`/execute` — 將議會終稿落實（揀 build model）',
  '`/stop` — 中途停止當前 run（殺晒 running agent）',
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
      pendingOverseerRevise: null, overseerHistory: [], overseerModel: 'opus', overseerMode: 'auto' };
  }
  function stateFor(key) { if (!states.has(key)) states.set(key, blankState()); return states.get(key); }

  // 當前 dispatch 嘅 working set（updates 係 sequential 處理,逐個 await,唔會 race）
  let replyChatId = OWNER, currentRole = 'owner';
  let pendingMission, pendingCouncil, pendingRefine, awaitingRefineNote, pendingOverseerRevise, overseerHistory, overseerModel, overseerMode;
  function loadState(key) {
    const s = stateFor(key);
    pendingMission = s.pendingMission; pendingCouncil = s.pendingCouncil; pendingRefine = s.pendingRefine;
    awaitingRefineNote = s.awaitingRefineNote; pendingOverseerRevise = s.pendingOverseerRevise;
    overseerHistory = s.overseerHistory; overseerModel = s.overseerModel; overseerMode = s.overseerMode;
  }
  function saveState(key) {
    const s = stateFor(key);
    s.pendingMission = pendingMission; s.pendingCouncil = pendingCouncil; s.pendingRefine = pendingRefine;
    s.awaitingRefineNote = awaitingRefineNote; s.pendingOverseerRevise = pendingOverseerRevise;
    s.overseerHistory = overseerHistory; s.overseerModel = overseerModel; s.overseerMode = overseerMode;
    persistMem();
  }
  function persistMem() {
    try {
      const fs = require('fs');
      const out = {};
      for (const [k, s] of states) out[k] = { overseerHistory: s.overseerHistory, overseerModel: s.overseerModel, overseerMode: s.overseerMode };
      fs.writeFileSync(MEM_FILE, JSON.stringify(out));
    } catch (e) { log('persistMem: ' + e.message); }
  }
  function loadMem() {
    try {
      const raw = JSON.parse(require('fs').readFileSync(MEM_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        const s = stateFor(k);
        s.overseerHistory = Array.isArray(v.overseerHistory) ? v.overseerHistory : [];
        s.overseerModel = v.overseerModel || 'opus';
        s.overseerMode = v.overseerMode || 'auto';
      }
    } catch (_) { /* first run / no file */ }
  }
  loadMem();
  loadState(OWNER);

  // 所有 bot 回覆都回返「講嘢嗰個 chat」（多 user 各自 chat）。
  function say(text, opts = {}) { return tg.sendMessage(text, { ...opts, chatId: replyChatId }); }
  function ownerOnly() { return currentRole === 'owner'; }
  async function denyGuest() { await say('🔒 呢個動作淨係 owner 做到。你而家係 guest——可以同總管傾偈 + 睇嘢（/runs /show /status /projects）。'); }

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

  function modelKeyboard(prefix) {
    return { inline_keyboard: MODEL_CHOICES.map((m, i) => [{ text: (i === 0 ? '✅ ' : '') + m.label, callback_data: `${prefix}:${m.cli}:${m.model}` }]) };
  }

  // council 落實：build agents = 揀嘅 model；reviewer 維持 Opus。
  function execPerAgent(cli, model) {
    const build = { cli, model };
    return { frontend: build, backend: build, test: build, fixer: build, reviewer: { cli: 'claude', model: 'opus' } };
  }

  // mission：寫 code 嘅 agent = 揀嘅 model；研究／規劃／覆核固定 Opus。
  function missionPerAgent(cli, model) {
    const build = { cli, model };
    return {
      researcher: { cli: 'claude', model: 'opus' },
      planner: { cli: 'claude', model: 'opus' },
      reviewer: { cli: 'claude', model: 'opus' },
      frontend: build, backend: build, test: build, fixer: build,
    };
  }

  // ── Opus 完善 → 過目 gate（可反覆改善）──
  async function sendRefinePreview() {
    if (!pendingRefine) return;
    const { kind, refined } = pendingRefine;
    const verb = kind === 'council' ? '開三模議會' : '落 code';
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

  // 揀議會陣容（seat A 仲裁腦）→ 確認後開會。
  async function promptCouncilStrength(taskBrief) {
    pendingCouncil = { taskBrief };
    await say('揀議會陣容（seat A 仲裁腦）：', { replyMarkup: { inline_keyboard: [
      [{ text: '⚖️ 標準（Opus·Codex·GLM）', callback_data: 'cm:standard' }],
      [{ text: '👑 Fable 領銜（Fable·Codex·GLM）', callback_data: 'cm:fable' }],
    ] } });
  }

  async function startCouncil(taskBrief, councilModels) {
    const cr = await api('POST', '/api/runs', { topic: taskBrief.slice(0, 70), taskBrief });
    const run = cr.json && cr.json.run;
    if (!run) { await say(`⚠️ 開 run 失敗：${(cr.json && cr.json.error) || cr.status}`); return; }
    const sr = await api('POST', `/api/runs/${run.id}/council/start`, councilModels ? { perAgentModels: councilModels } : {});
    const seatA = (councilModels && councilModels.council_a && councilModels.council_a.model) || 'opus';
    if (sr.json && sr.json.ok) await say(`🗳 三模議會開波：*${tgline(taskBrief)}*\n（seat A=${seatA}｜B=Codex｜C=GLM）獨立 review 完先 ping 你開拗；收斂到御准閘會再 ping。`);
    else await say(`⚠️ 開議會失敗：${(sr.json && sr.json.error) || sr.status}`);
  }

  async function promptMissionModel(taskBrief, topic) {
    pendingMission = { taskBrief, topic };
    await say('揀「寫 code」用邊個 model（研究／覆核固定 Opus）：', { replyMarkup: modelKeyboard('mm') });
  }

  async function doApprove() {
    const run = await currentRun();
    if (!run || !(run.pipeline && run.pipeline.councilPaused)) { await say('而家冇御准閘可批准。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/council/approve`, {});
    if (r.json && r.json.ok) await say('✅ 已批准，出緊人話講解…');
    else await say(`⚠️ 批准失敗：${r.json.error || r.status}`);
  }

  async function doDebate() {
    const run = await currentRun();
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

  async function doExecute(cli, model) {
    const run = await currentRun();
    if (!run) { await say('冇 run 可落實。'); return; }
    const r = await api('POST', `/api/runs/${run.id}/council/execute`, { model, perAgentModels: execPerAgent(cli, model) });
    if (r.json && r.json.ok) await say(`▶ 落實開波（build=${model}）：plan v${r.json.executingVersion}\nbuild → review → fix 跑緊，完成會 ping 你。`);
    else await say(`⚠️ 落實失敗：${r.json.error || r.status}`);
  }

  async function doMission(cli, model) {
    if (!pendingMission) { await say('冇待落實嘅 mission（重新打 `/mission <plan>`）。'); return; }
    const { taskBrief, topic } = pendingMission;
    pendingMission = null;
    const r = await api('POST', '/api/plans/run', {
      taskBrief, topic, deliveryMode: 'code', staged: true,
      cli, model, perAgentModels: missionPerAgent(cli, model),
    });
    if (r.json && r.json.ok) await say(`⚙️ Mission 開波（寫 code=${model}）：*${tgline(topic)}*${r.json.queued ? `（排隊中 #${r.json.position}）` : '（research → build → review → fix 跑緊）'}`);
    else await say(`⚠️ Mission 失敗：${(r.json && r.json.error) || r.status}`);
  }

  // ── Overseer:plain text → 帶全局 digest 嘅總管 AI（Tier 1 唯讀 + Tier 2 confirm-gate 動作）──
  async function handleOverseer(message) {
    const mode = pickMode(message);
    const deep = mode === 'deep';
    await say(deep ? '🧠 總管深入諗緊（會 review，慢啲）…' : '💬 諗緊…');
    overseerHistory.push({ role: 'user', content: message });
    const model = deep ? overseerModel : 'sonnet';
    const r = await api('POST', '/api/overseer', { message, model, mode, history: overseerHistory.slice(-6) }, deep ? 160000 : 80000);
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
    if (t === 'execute') { await say('揀 build model 落實：', { replyMarkup: modelKeyboard('exm') }); return; }
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

  async function handleCommand(text) {
    const trimmed = text.trim();

    // 迭代完善：等緊改善意見、又唔係新指令 → 當作 refine note 處理。
    if (awaitingRefineNote && pendingRefine && !trimmed.startsWith('/')) {
      awaitingRefineNote = false;
      await reviseAndPreview(trimmed);
      return;
    }
    if (awaitingRefineNote) awaitingRefineNote = false; // 打咗新指令 → 放棄等意見

    // 唔係指令（冇 /）→ 同總管 AI 傾偈。
    if (trimmed && !trimmed.startsWith('/')) { await handleOverseer(trimmed); return; }

    const cmd = trimmed.split(/\s+/)[0];
    const arg = trimmed.slice(cmd.length).trim();
    const c = cmd.toLowerCase().replace(/@.*$/, '');

    if (c === '/start' || c === '/help') { await say(HELP); return; }

    if (c === '/brain') {
      const a = arg.toLowerCase();
      if (a === 'fable') overseerModel = 'claude-fable-5';
      else if (a === 'opus') overseerModel = 'opus';
      else if (a) { await say('用法：`/brain opus` 或 `/brain fable`（深入模式先用到呢個腦）'); return; }
      const modeLabel = overseerMode === 'deep' ? '深入(鎖)' : overseerMode === 'fast' ? '快答(鎖)' : '自動';
      await say(`🧠 深入腦：*${overseerModel === 'claude-fable-5' ? 'Fable 5（至尊·貴）' : 'Opus 4.8'}*｜模式：*${modeLabel}*\n切腦：\`/brain opus|fable\`　模式：\`/auto\`（自己判斷）/ \`/fast\` / \`/deep\``);
      return;
    }

    if (c === '/auto') { overseerMode = 'auto'; await say('🤖 *自動模式*：我自己判斷——傾 idea 用快答(Sonnet)，叫我 review / audit / 查 bug 先深入(Opus+skill)。'); return; }
    if (c === '/fast') { overseerMode = 'fast'; await say('💬 *鎖快答*：之後一律 Sonnet 快答。返自動：`/auto`'); return; }
    if (c === '/deep') { overseerMode = 'deep'; await say(`🧠 *鎖深入*：之後一律 ${overseerModel === 'claude-fable-5' ? 'Fable' : 'Opus'}+skill。返自動：\`/auto\``); return; }

    if (c === '/status') {
      const run = await currentRun();
      if (!run) { await say('🟦 而家冇 active run。'); return; }
      const p = run.pipeline || {};
      const gate = p.councilPaused ? '⏸ 等御准' : (p.councilReviewPaused ? '🔎 等開拗' : '');
      const mode = p.mode || (run.metrics && run.metrics.deliveryMode) || '-';
      await say(`📊 *${tgline(run.topic)}*\n狀態：${run.status}｜stage：${run.stage || '-'} ${gate}\nmode：${mode}${p.councilPlanVersion ? `｜plan v${p.councilPlanVersion}` : ''}`);
      return;
    }

    if (c === '/council') {
      if (!ownerOnly()) { await denyGuest(); return; }
      if (!arg) { await say('用法：`/council <題目>`'); return; }
      const ok = await refineAndPreview('council', arg, arg.slice(0, 70));
      if (!ok) { await say('（完善失敗，用你原本嘅題目開會）'); await startCouncil(arg); }
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
      if (!arg) { await say('用法：`/revise <你嘅指示>`'); return; }
      const run = await currentRun();
      if (!run || !(run.pipeline && run.pipeline.councilPaused)) { await say('而家冇御准閘可以再改。'); return; }
      const r = await api('POST', `/api/runs/${run.id}/council/revise`, { note: arg });
      if (r.json && r.json.ok) await say(`✍️ 已要求再改，重跑第 ${r.json.round} round 共識…`);
      else await say(`⚠️ 再改失敗：${(r.json && r.json.error) || r.status}`);
      return;
    }

    if (c === '/approve') { if (!ownerOnly()) { await denyGuest(); return; } await doApprove(); return; }
    if (c === '/debate') { if (!ownerOnly()) { await denyGuest(); return; } await doDebate(); return; }

    if (c === '/execute') {
      if (!ownerOnly()) { await denyGuest(); return; }
      const run = await currentRun();
      if (!run) { await say('冇 run 可落實。'); return; }
      await say('揀 build model 落實：', { replyMarkup: modelKeyboard('exm') });
      return;
    }

    if (c === '/stop') { if (!ownerOnly()) { await denyGuest(); return; } await doStop(); return; }

    if (c === '/runs') {
      const r = await api('GET', '/api/runs');
      const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.runs) || [];
      if (!arr.length) { await say('🟦 冇 run。'); return; }
      const lines = arr.slice(-10).reverse().map((x) => {
        const run = (x.runningAgents ? `▶${x.runningAgents}` : x.status);
        return `• \`${x.id}\`\n  ${tgline(x.topic)} — ${run}/${x.stage || '-'}`;
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
      await say(`📄 *${tgline(run.topic)}*\n狀態：${run.status}｜stage：${run.stage || '-'} ${gate}\nmode：${p.mode || (run.metrics && run.metrics.deliveryMode) || '-'}${planV}\n最近產出：\n${arts}`);
      return;
    }

    if (c === '/projects') {
      const r = await api('GET', '/api/projects');
      const ps = (r.json && r.json.projects) || [];
      const lines = ps.slice(0, 25).map((pr) => `• ${tgline(typeof pr === 'string' ? pr : (pr.path || pr.name || JSON.stringify(pr)))}`);
      await say(`📁 *Project*\n${lines.join('\n') || '（無）'}`);
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

    if (dataStr === 'approve') { await doApprove(); return; }
    if (dataStr === 'debate') { await doDebate(); return; }
    if (dataStr === 'revise_hint') { await say('打 `/revise <你嘅指示>` 叫議會就你嘅意見再收斂一 round。'); return; }
    if (dataStr === 'execute') { await say('揀 build model 落實：', { replyMarkup: modelKeyboard('exm') }); return; }
    if (dataStr.startsWith('exm:')) { const p = dataStr.split(':'); await doExecute(p[1], p[2]); return; }
    if (dataStr.startsWith('cm:')) {
      if (!pendingCouncil) { await say('冇待開嘅議會（重新打 /council）。'); return; }
      const which = dataStr.split(':')[1];
      const { taskBrief } = pendingCouncil;
      pendingCouncil = null;
      await startCouncil(taskBrief, COUNCIL_STRENGTH[which] || null);
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
    if (dataStr.startsWith('mm:')) { const p = dataStr.split(':'); await doMission(p[1], p[2]); }
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
    if (u.message && u.message.text) {
      const id = identify(u.message.from, u.message.chat);
      if (!id.role) { log(`ignored message from ${id.key || u.message.chat.id}`); return; }
      replyChatId = id.chatId; currentRole = id.role; loadState(id.key);
      try { await handleCommand(u.message.text); } finally { saveState(id.key); }
    } else if (u.callback_query) {
      const cb = u.callback_query;
      const id = identify(cb.from, cb.message && cb.message.chat);
      if (!id.role) { await tg.answerCallbackQuery(cb.id, '未授權'); return; }
      replyChatId = id.chatId; currentRole = id.role; loadState(id.key);
      try { await handleCallback(cb); } finally { saveState(id.key); }
    }
  }

  async function loop() {
    while (running) {
      try {
        const res = await tg.getUpdates(offset, 25);
        if (res && res.ok && Array.isArray(res.result)) {
          for (const u of res.result) {
            offset = u.update_id + 1;
            try { await dispatch(u); } catch (e) { log('dispatch error: ' + e.message); }
          }
        } else if (res && (res.error || res.ok === false)) {
          await sleep(3000);
        }
      } catch (e) { log('poll error: ' + e.message); await sleep(3000); }
    }
  }

  // Drain backlog first (skip stale pre-boot updates), then start the loop.
  (async () => {
    try {
      const res = await tg.getUpdates(0, 0);
      if (res && res.ok && Array.isArray(res.result) && res.result.length) {
        offset = res.result[res.result.length - 1].update_id + 1;
      }
    } catch (_) { /* ignore */ }
    log('inbound bot started (long-poll, backlog drained)');
    loop();
  })();

  return { stop() { running = false; } };
}

module.exports = { startBot };
