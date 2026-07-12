const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const { bashLoginArgs, stripNonTtyShellNoise } = require('./lib/shell-runner');

// Load .env (Cronicle API key, etc.) before any module reads process.env
require('./lib/env').loadEnv(path.join(__dirname, '.env'));
// 額外 load ~/.perplexity_secrets（`export KEY=` 格式，loadEnv 會 strip export）→ PERPLEXITY_API_KEY
require('./lib/env').loadEnv(path.join(require('os').homedir(), '.perplexity_secrets'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3010;
const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'swarm-v3-state.json');
const MISSION_CONTROL_FILE = path.join(DATA_DIR, 'mission-control.json');
const DEFAULT_PROJECT_ROOT = process.env.SWARM_PROJECT_ROOT || '/home/hugo-orca/orca-platform-mvp';
const EXEC_TIMEOUT_MS = Number(process.env.SWARM_EXEC_TIMEOUT_MS || 45 * 60 * 1000);
const MAX_LOG_CHARS = 120000;
const MAX_CONTEXT_CHARS = 24000;
const MISSION_CONTROL_MAX_CHARS = Number(process.env.SWARM_MISSION_CONTROL_MAX_CHARS || 5000);
const MISSION_TARGET_MAX_CHARS = Number(process.env.SWARM_MISSION_TARGET_MAX_CHARS || 7000);
const DEFAULT_GLOBAL_GOAL = [
  '建立一個完整、可靠、可持續改善嘅系統。',
  '每個 mission 都要服務同一個大目標：令產品更清晰、更穩、更接近真正可交付，而唔係只完成單一 task。',
].join('\n');
const DEFAULT_COORDINATION_WARNINGS = [
  '交棒俾下一個 agent 時，要用清楚 summary/reminder/warning 補返自己做過乜、下一步要留意乜。',
  '下一個 agent 未必有你嘅完整記憶；唔好假設佢睇過你全部 log。',
  '唔好為咗局部完成而破壞整體系統、資料流、測試策略或用戶原意。',
  '同一 project 可能有其他 agent / partner 正在工作；唔好 revert 或覆蓋自己冇做嘅改動。',
  '產品方向、安全、權限、刪資料、收費或 one-way-door 決策，必須停喺 Hugo / owner gate。',
];
const INTENT_PACKS = {
  general: {
    key: 'general',
    version: 1,
    label: 'General',
    shortLabel: 'General',
    summary: '普通 project / coding / infra 模式；跟 repo memory、任務 brief 同 acceptance criteria，唔注入學校平台假設。',
    priorities: [
      '跟 repo AGENTS / memory / 現有架構做保守改動。',
      '清楚交付 task 要求、測試結果、剩餘風險。',
      '唔自動加入學生、改卷、tenant、plugin 或教育平台背景。',
    ],
    acceptance: [
      '改動符合任務 brief，且有可重現驗證。',
      '無 silent scope expansion，無覆蓋其他人改動。',
    ],
    nonGoals: [
      '唔為一般任務引入 ORCA / 學校平台專屬設計。',
    ],
  },
  school_mvp: {
    key: 'school_mvp',
    version: 1,
    label: 'MVP School Learning Tracker',
    shortLabel: 'MVP Tracker',
    summary: 'ORCA MVP 模式；優先令改卷流程 work，並 demo 到學生改完卷後能力可按時間、試卷、能力點追蹤。',
    priorities: [
      '改卷流程要可用：輸入 / 上載答案、評分、產生結果。',
      '追蹤要可展示：同一學生跨時間、跨試卷、跨能力點嘅變化。',
      'Demo 優先：老師一眼睇到進步、退步、卡住、弱項。',
      '資料模型要保留擴展空間：學生、試卷、題目、分數、能力點、時間。',
    ],
    acceptance: [
      '至少可用一個學生跨多份卷展示能力趨勢同改卷結果。',
      'UI / artifact 要清楚指出老師可以點睇學生能力變化。',
      '不要為 MVP 過早做大型 plugin marketplace、billing、多校私有部署或複雜 RBAC。',
    ],
    nonGoals: [
      '暫不追求完整 School OS。',
      '暫不做全面 plugin marketplace / school-owned DB / enterprise compliance。',
    ],
  },
  school_os_full: {
    key: 'school_os_full',
    version: 1,
    label: 'Full School Learning OS',
    shortLabel: 'Full School OS',
    summary: '長遠正式版模式；把產品視為模組化 School Learning OS，必須考慮多校、獨立 database、plugin、權限、私隱同長期學生資料。',
    priorities: [
      '每間學校係獨立 tenant / database，學生資料屬高敏感長期資料。',
      '改卷、生成練習、興趣班追蹤、analytics 等都係 module / plugin。',
      'Plugin 唔可以破壞核心資料模型、權限模型或資料隔離。',
      '支援將來 data export、school-owned DB、private deployment、audit log。',
    ],
    acceptance: [
      '任何計劃都要講清 tenant / privacy / permission / plugin boundary impact。',
      '產品、安全、權限放寬、資料刪除、付費、one-way-door 決策必須停喺 Hugo / owner gate。',
    ],
    nonGoals: [
      '唔為短期 MVP 犧牲長期資料安全或 tenant isolation。',
    ],
  },
};
const DOMAIN_MODULES = {
  assessment_intelligence: {
    key: 'assessment_intelligence',
    version: 1,
    label: 'ORCA Assessment Intelligence Suite',
    shortLabel: 'Assessment Suite',
    summary: '改卷系統專用 domain module；把 data capture、AI marking reliability、ability/concept layer、teacher review sync、rubric knowledge admin 連成同一條資料流。',
    priorities: [
      '改卷結果必須可追溯：保留原答案、AI 判分、rubric reference、confidence、老師修改同 audit trail。',
      '批量改卷要有 batch/progress/failure/retry 記錄，唔可以只處理單份 happy path。',
      '老師人手改分、改錯因、改 concept tag 後，student profile、錯題紀錄、班級/級別 dashboard 必須同步或標記重算。',
      '能力分析要有層次：subject/topic/concept/skill/misconception，後續 dashboard 同 recommendation 要駁得返。',
      'PDF、notes、rubric 要有 admin 管理：upload、轉 Markdown、編輯、版本、disable、引用記錄。',
    ],
    acceptance: [
      '任何改卷 flow 改動都要講清 input → AI marking → teacher review → DB update → ability/dashboard sync。',
      '每個 phase / plan 要列出產生咩 data、讀咩 data、寫邊啲 table/store、影響邊個 dashboard、點 verify。',
      'AI 準確度、一致性、穩定性要有檢查：rubric reference、confidence、sample review、重跑一致性或人工覆核路徑。',
      'Knowledge source 被 AI 使用時，要能追返 source/version；老師唔需要 fine-tune 都可以透過 notes/PDF/Markdown 改善判分。',
    ],
    nonGoals: [
      '唔用 dashboard summary 代替 database persistence。',
      '唔用老師最終分覆蓋 AI 原始判斷；要保留 before/after。',
      '唔將 PDF/notes 當一次性 prompt，必須當可管理 knowledge source。',
    ],
    modules: [
      {
        key: 'assessment_data_capture',
        label: 'Assessment Data Capture',
        focus: 'Data 點收集、收集到咩、學生能力評估 data 點保存同追溯。',
        checks: [
          'Raw answer、AI marking、teacher override、concept tag、ability signal 是否都有保存。',
          '每個 marking result 是否可由 assessment/question/student/rubric/source 追返。',
        ],
      },
      {
        key: 'marking_flow_reliability',
        label: 'Marking Flow Reliability',
        focus: '上載、AI 改卷、prompt/action、批量改卷、一致性同 failure handling。',
        checks: [
          'Batch marking 是否有 batch id、progress、failed item、retry。',
          'AI output 是否包含 score、reason、rubric reference、confidence。',
        ],
      },
      {
        key: 'ability_concept_layer',
        label: 'Ability & Concept Layer',
        focus: '能力 layer、concept layer、misconception、後續分析可唔可以準確 connect。',
        checks: [
          'Question result 是否 map 到 subject/topic/concept/skill/misconception。',
          '學生能力變化是否可以跨時間、跨試卷、跨能力點追蹤。',
        ],
      },
      {
        key: 'teacher_review_sync',
        label: 'Teacher Review Sync',
        focus: '老師審批、人手改分、改錯因後，DB、student record、dashboard 重新同步。',
        checks: [
          'Teacher override 是否寫入 persistent store 並保留 audit trail。',
          'Dashboard summary、學生能力、錯題紀錄、班級/級別統計是否同步或標記重算。',
        ],
      },
      {
        key: 'rubric_knowledge_admin',
        label: 'Rubric Knowledge Admin',
        focus: 'PDF、notes、rubric、Markdown knowledge base 嘅 upload、edit、version、disable、引用。',
        checks: [
          'Knowledge source 是否有 owner、subject/topic、version、active/disabled 狀態。',
          'AI marking 是否記錄引用咗邊份 PDF/Markdown/rubric version。',
        ],
      },
    ],
  },
  ui_visual_qa: {
    key: 'ui_visual_qa',
    version: 1,
    label: 'ORCA UI Visual QA Pack',
    shortLabel: 'UI Visual QA',
    summary: 'UI / UX / responsive 專用 domain module；用固定 screenshot loop 做改前、改後、fix 後驗證，避免 agent 淨靠文字估畫面。',
    priorities: [
      '任何 UI 改動都要先 capture before，再改 code，再 capture after；如果仍有 overflow、overlap、blank、console/page error，要再 fix 再 capture。',
      'Desktop 同 mobile 都要驗證；至少覆蓋 teacher、panel head、principal、admin 等核心角色頁。',
      '以實際 screenshot artifact 做判斷：layout hierarchy、spacing、readability、responsive、empty/loading/error state、role navigation 都要睇。',
      'UI polish 不可以破壞 Supabase/API data flow、role permission、tenant isolation 或 marking flow。',
      'Final report 必須列出 screenshot paths、changed files、visual issues fixed、remaining visual risks。',
    ],
    acceptance: [
      '改前同改後 screenshot 路徑都要寫入 artifact；如果有 fix loop，要附最後一輪 screenshot。',
      '至少跑一輪 screenshot loop tool：node ~/services/swarm-server/scripts/orca-ui-screenshot-loop.mjs --project <frontend> --base-url <url> --phase before|after|fix。',
      '結果 JSON 入面唔可以有 horizontal overflow、blank page、page error；console error 要解釋或修正。',
      '手機 viewport 不可以有文字/按鈕互相遮蓋；desktop 不可以靠過大 hero/card 逃避 dashboard 可掃讀性。',
    ],
    nonGoals: [
      '唔為了變靚而大改產品 scope。',
      '唔用 screenshot 代替功能測試；UI pass 之外仍要跑相關 unit/API/e2e smoke。',
      '唔改 role permission 或資料模型，除非 mission 明確要求。',
    ],
    modules: [
      {
        key: 'screenshot_loop',
        label: 'Before / After Screenshot Loop',
        focus: '改前、改後、fix 後用同一批 route / role / viewport cap 圖，形成可追蹤 artifact。',
        checks: [
          'before、after、fix phase 是否存在 results.json 同 screenshot png。',
          '同一 route / role / viewport 是否用同一設定，避免前後不可比。',
        ],
      },
      {
        key: 'responsive_contract',
        label: 'Responsive Contract',
        focus: 'Desktop / mobile layout、scroll、overflow、nav drawer、safe-area、button hit target。',
        checks: [
          'document scrollWidth 是否超出 viewport。',
          'mobile menu / dashboard nav / primary action 是否可見且不遮內容。',
        ],
      },
      {
        key: 'visual_hierarchy',
        label: 'Visual Hierarchy & Density',
        focus: 'Dashboard 要可掃讀、資訊層次清楚、表格/卡片/filters 密度合適。',
        checks: [
          '重要 KPI、下一步 action、狀態、role context 是否第一眼清楚。',
          '文字大小、間距、顏色、卡片數量是否令畫面雜亂或過度空泛。',
        ],
      },
      {
        key: 'role_ui_coverage',
        label: 'Role UI Coverage',
        focus: '老師、科任主任、校長、admin 的入口、導航、權限提示同 dashboard 都要被截圖驗證。',
        checks: [
          '每個角色是否進到正確 home path。',
          '不應看見不屬於該角色的 primary actions 或敏感資訊。',
        ],
      },
    ],
  },
};
const DEFAULT_AGENT_CLI = process.env.SWARM_AGENT_CLI || 'claude';
const SWARM_WORKSPACE = process.env.SWARM_WORKSPACE || path.join(require("os").homedir(), "swarm-workspace");
const MIROFISH_BACKEND_URL = process.env.MIROFISH_BACKEND_URL || 'http://127.0.0.1:5001';
function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return !!defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
// Parallel build agents share one git working tree → race. SWARM_WORKTREE=1 gives
// each parallel code agent its own git worktree, merged back after the wave.
const SWARM_WORKTREE = envFlag('SWARM_WORKTREE', true);
const worktreeMgr = require('./lib/mission-worktree');
// SWARM_REVIEW_GATE=1 turns review→fix into a quality loop: reviewer emits
// PASS/WARN/FAIL; WARN/FAIL runs fix then re-reviews, up to N iterations.
const SWARM_REVIEW_GATE = envFlag('SWARM_REVIEW_GATE', true);
// Default 2 strict passes: WARN/FAIL both loop once more before needing attention.
const SWARM_REVIEW_GATE_MAX = Number(process.env.SWARM_REVIEW_GATE_MAX || 2);
const SWARM_REVIEW_GATE_STRICT = envFlag('SWARM_REVIEW_GATE_STRICT', true);
const SWARM_GATE_TIME_BUDGET_MS = Number(process.env.SWARM_GATE_TIME_BUDGET_MS || 0);
// Change reports: server-side git capture of what each code wave actually changed
// (baseline..HEAD + working tree + untracked) — agent self-reporting 唔靠得住。
// Caps keep the persisted store sane.
const SWARM_CHANGEREPORT_PATCH_MAX = Number(process.env.SWARM_CHANGEREPORT_PATCH_MAX || 65536);
const SWARM_CHANGEREPORT_KEEP = Number(process.env.SWARM_CHANGEREPORT_KEEP || 20);
const SWARM_CHANGEREPORT_PATCH_BUDGET = Number(process.env.SWARM_CHANGEREPORT_PATCH_BUDGET || 196608);
// Warm followup MAY resume the previous build agent's CLI session (claude only).
const SWARM_FOLLOWUP_RESUME = envFlag('SWARM_FOLLOWUP_RESUME', false);

// ─── Telegram 通知（銜接舊 bot;lib/telegram 喺 TG_BOT_TOKEN/TG_CHAT_ID 未設時 graceful no-op）───
// 只喺關鍵節點 ping：review 閘、御准閘（等你批）、完成（議會收斂 / plan 落實）、agent 失敗。
const telegram = require('./lib/telegram');
const SWARM_DASH_URL = process.env.SWARM_DASH_URL || 'http://187.127.115.235:3010';

// ─── Council research（Perplexity，reviewer 提角度 → 集中 call 一次 → 結果派返）───
const { runResearch } = require('./lib/perplexity-research');
const PPLX_BUDGET = Number(process.env.PPLX_BUDGET || 5);
const PPLX_MODEL = process.env.PPLX_MODEL || 'sonar';
const COUNCIL_RESEARCH_MAX_ANGLES = Number(process.env.COUNCIL_RESEARCH_MAX_ANGLES || 8);
const tgNotifiedKeys = new Set(); // dedup「完成」通知（per run + milestone），避免同一 run 報多次
function tgEsc(s) {
  return String(s == null ? '' : s).replace(/[_*`\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}
function tgNotify(text, replyMarkup, chatId) {
  try {
    const opts = {};
    if (replyMarkup) opts.replyMarkup = replyMarkup;
    if (chatId) opts.chatId = chatId; // 指定 → send 返開 run 嗰個 user;冇 → 預設 owner
    Promise.resolve(telegram.sendMessage(text, opts)).catch((e) => console.warn('[telegram] send failed:', e.message));
  } catch (e) { console.warn('[telegram] notify threw:', e.message); }
}
function runTail(run) {
  return String((run && run.id) || '').slice(-8) || 'current';
}
function notifyCouncilGate(run, p, reason) {
  const disputes = p.councilOpenDisputes == null ? 0 : p.councilOpenDisputes;
  const tail = runTail(run);
  tgNotify(
    `⏸ *御准閘 · 等你批准*\n\n🏛 ${tgEsc(run.topic)}\n${tgEsc(reason)}｜Plan v${p.councilPlanVersion}｜未解爭議 ${disputes}\n\n撳掣批准／再改,或開 [Swarm Dashboard](${SWARM_DASH_URL})`,
    { inline_keyboard: [[{ text: '✅ 批准', callback_data: `cg:approve:${tail}` }], [{ text: '✍️ 再改', callback_data: `cg:revise:${tail}` }]] },
    run && run.tgChatId
  );
}
function notifyCouncilReviewGate(run, reviews) {
  const disagreements = (reviews || []).filter((r) => !r.agree).length;
  const tail = runTail(run);
  tgNotify(
    `🔎 *Council review 完成*\n\n🏛 ${tgEsc(run.topic)}\n已收到 ${reviews.length} 份 review｜有異議 ${disagreements}\n\n撳「開始拗」進入 moderator 收斂,或開 [Swarm Dashboard](${SWARM_DASH_URL}) 睇全文。`,
    { inline_keyboard: [[{ text: '🥊 開始拗', callback_data: `cg:debate:${tail}` }]] },
    run && run.tgChatId
  );
}
function notifyRunComplete(run, tag) {
  if (!run || !run.id) return;
  // pipelineSeq 入 key：followup 喺同一 run 起第二條 pipeline,完成要再通知（唔係 dedup 食咗）。
  const key = `${run.id}:${tag}:${run.pipelineSeq || 0}`;
  if (tgNotifiedKeys.has(key)) return;
  tgNotifiedKeys.add(key);
  const title = tag === 'pipeline' ? '✅ *Plan 落實完成*' : '✅ *議會收斂完成*';
  const tail = runTail(run);
  let markup = tag === 'synthesis'
    ? { inline_keyboard: [[{ text: '▶ 落實 plan', callback_data: `cg:execute:${tail}` }]] }
    : null;
  const lines = [title, '', `🏛 ${tgEsc(run.topic)}`];
  if (tag === 'pipeline') {
    lines.push(`Run: \`${tail}\``);
    lines.push(`build → review → fix 跑完 · verify ${run.verifyVerdict || '—'}`);
    const latest = (run.changeReports || [])[(run.changeReports || []).length - 1];
    if (latest) {
      lines.push('', `📝 改咗 ${latest.filesChanged.length} 個 file（+${latest.totalAdds}/−${latest.totalDels}）:`);
      summarizeChangeLines(latest, 8).forEach((l) => lines.push(`\`${l.replace(/`/g, "'")}\``));
      markup = { inline_keyboard: [[
        { text: '🔍 改咗乜(全)', callback_data: `cr:${tail}` },
        { text: '🔁 跟進', callback_data: `fu:${tail}` },
      ]] };
    } else {
      lines.push('（今次冇 change report — 可能唔係 git repo 或者冇改到 file）');
      markup = { inline_keyboard: [[{ text: '🔁 跟進', callback_data: `fu:${tail}` }]] };
    }
  } else {
    lines.push('人話講解 + plan 終稿已出,可以開始落實');
  }
  lines.push('', `→ 開 [Swarm Dashboard](${SWARM_DASH_URL})`);
  let text = lines.join('\n');
  if (text.length > 3500) text = `${text.slice(0, 3480)}\n…(cut)`;
  tgNotify(text, markup, run && run.tgChatId);
  if (tag === 'pipeline') autoReviewOnComplete(run);
  // 預熱「下一步」收斂層（背景,best-effort）—— 用戶完成後一 tap 即出,唔使等 LLM。SWARM_NEXTSTEPS=0 可關。
  if (process.env.SWARM_NEXTSTEPS !== '0') { try { generateNextSteps(run); } catch (_) {} }
}
// 完成自動覆核:TG 開嘅 mission build→review→fix→verify 完,總管讀產出 → send 簡短 feedback 返開 run 嗰位
// （補返「等結果返嚟自己 review」嗰橛）。SWARM_AUTO_REVIEW=0 可關。
function autoReviewOnComplete(run) {
  if (process.env.SWARM_AUTO_REVIEW === '0') return;
  if (!run || !run.tgChatId) return; // 只自動覆核 Telegram 開嘅 run
  const arts = (run.artifacts || []).slice(-8)
    .map((a) => `### ${a.title || a.type}\n${truncate(String(a.content || ''), 1200)}`).join('\n\n');
  const changesTxt = summarizeChangeReportsText(run, 2500);
  const prompt = [
    `你係用戶嘅 Swarm 總管。一個喺 project ${run.projectPath || ''} 跑嘅 mission「${run.topic}」啱啱 build→review→fix→verify 完成。`,
    '下面係 server 記錄嘅實際 git 改動 + 佢嘅產出 / log。用繁體中文 / 廣東話俾**簡短** feedback（最多 6-8 句）：',
    '做咗咩、質素好唔好、有冇🔴紅旗（verify FAIL/BLOCKED、reviewer 未解 FIX_NEEDED、未跑真 e2e、改錯範圍 — 對住下面 git 改動判斷）、建議下一步。唔好覆述全部 log。',
    '', '=== 今次 git 改動（server 記錄,唔係 agent 自報）===', changesTxt || '(冇 change report — 唔係 git repo 或者冇改到 file)',
    '', '=== 產出 ===', arts || '(冇 artifact)',
  ].join('\n');
  spawnOneShot(prompt, { cli: 'claude', model: 'opus' }, 'swarm-autoreview', 420000)
    .then((txt) => tgNotify(`🔎 *自動覆核* · ${tgEsc(run.topic)}\n\n${(txt || '').trim()}`, null, run.tgChatId))
    .catch((e) => console.warn('[autoreview]', e.message));
}
function notifyAgentFailed(run, agent, preset) {
  const name = (preset && preset.name) || (agent && agent.name) || 'Agent';
  tgNotify(`⚠️ *Agent 失敗* · ${tgEsc(run && run.topic)}\n\n${tgEsc(name)}：${tgEsc(agent && agent.summary)}\n\n→ 開 [Swarm Dashboard](${SWARM_DASH_URL}) 睇 log`, null, run && run.tgChatId);
}
const SWARM_TG_HANDOFF = envFlag('SWARM_TG_HANDOFF', true);
function notifyAgentHandoff(run, agent, handoff) {
  if (!SWARM_TG_HANDOFF || !run || !run.tgChatId || !handoff) return;
  const reminders = (handoff.reminders || []).slice(0, 2).map((x) => `• ${tgEsc(x)}`).join('\n');
  const warnings = (handoff.warnings || []).slice(0, 2).map((x) => `• ${tgEsc(x)}`).join('\n');
  tgNotify(
    `📨 *Agent 交棒*\n\n🏛 ${tgEsc(run.topic)}\n👤 ${tgEsc(agent.name)}\n\n摘要：${tgEsc(handoff.summary)}${reminders ? `\n\n提醒：\n${reminders}` : ''}${warnings ? `\n\n警告：\n${warnings}` : ''}`,
    null,
    run.tgChatId
  );
}

// ─── 任務一:Push gate（code pipeline 完 → Telegram/UI 確認 → git push origin）───
// SWARM_PUSH_GATE=0 緊急回退（回復「只 merge 去 local、唔 push」舊行為）。
const SWARM_PUSH_GATE = process.env.SWARM_PUSH_GATE !== '0';
const PUSH_DEFAULT_BRANCH = process.env.SWARM_PUSH_DEFAULT_BRANCH || 'feature/mvp-sprint';
function shouldOfferPush(run) {
  if (!SWARM_PUSH_GATE) return false;
  const p = run && run.pipeline;
  if (!p || p.mode !== 'code') return false;                                   // 只對 code pipeline（council/execute + mission 都係 code mode）
  if (run.pendingPush && ['awaiting', 'pushing'].includes(run.pendingPush.status)) return false; // 已有 gate 行緊
  try {
    const repo = safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT);
    return fs.existsSync(path.join(repo, '.git'));                             // 要係 git repo
  } catch (_) { return false; }
}
function enterPushGate(run) {
  let repo;
  try { repo = safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT); } catch (_) { return; }
  const snapshot = worktreeMgr.commitDirty({
    repo,
    message: `swarm ${String(run.id).slice(-8)}: snapshot ${String(run.topic || '').replace(/\n/g, ' ').slice(0, 60)}`,
  });
  if (snapshot && snapshot.error) {
    addArtifact(run, { type: 'execution-error', title: '⚠ Push snapshot commit 失敗', content: snapshot.error });
  } else if (snapshot && snapshot.committed) {
    addArtifact(run, { type: 'note', title: '📌 Push snapshot 已鎖定', content: `Local commit ${(snapshot.head || '').slice(0, 7)} 已保存今次 mission 結果。` });
  }
  run.pendingPush = {
    status: 'awaiting',
    project: repo,
    branch: PUSH_DEFAULT_BRANCH,
    defaultBranch: PUSH_DEFAULT_BRANCH,
    sourceRef: (snapshot && snapshot.head) || 'HEAD',
    runIdTail: String(run.id).slice(-8),
    createdAt: new Date().toISOString(),
    decidedAt: null,
    result: null,
  };
  addArtifact(run, { type: 'push-gate', title: '⬆️ 待確認 Push', content: `Project: ${path.basename(repo)}\nBranch: ${PUSH_DEFAULT_BRANCH}\n\n喺 Telegram 或 dashboard 確認先 push 上 GitHub。` });
  io.emit('push-gate', { runId: run.id, pendingPush: run.pendingPush });
  io.emit('run-updated', publicRun(run));
  notifyPushGate(run);
  scheduleSave();
}
function doGitPush(run) {
  const pp = run.pendingPush;
  if (!pp || !['awaiting', 'failed'].includes(pp.status)) return;             // 容許失敗後「再試」
  pp.status = 'pushing';
  io.emit('push-gate', { runId: run.id, pendingPush: pp });
  io.emit('run-updated', publicRun(run));
  let repo;
  try { repo = safeProjectPath(pp.project || run.projectPath); }
  catch (e) {
    pp.status = 'failed'; pp.result = { ok: false, err: e.message };
    notifyPushResult(run, pp.result); io.emit('run-updated', publicRun(run)); scheduleSave(); return;
  }
  setImmediate(() => {                                                        // 背景跑,唔 block REST
    const r = worktreeMgr.pushBranch({ repo, targetBranch: pp.branch, sourceRef: pp.sourceRef || 'HEAD', autoCommit: false });
    pp.status = r.ok ? 'done' : 'failed';
    pp.decidedAt = new Date().toISOString();
    pp.result = r;
    addArtifact(run, {
      type: r.ok ? 'note' : 'execution-error',
      title: r.ok ? `✅ Push 完成 → ${r.remoteBranch}` : `⚠️ Push 失敗 → ${pp.branch}`,
      content: r.ok
        ? `${path.basename(repo)} @ ${(r.pushedSha || '').slice(0, 7)} → origin/${r.remoteBranch}`
        : (r.err || 'unknown error'),
    });
    notifyPushResult(run, r);
    io.emit('push-gate', { runId: run.id, pendingPush: pp });
    io.emit('run-updated', publicRun(run));
    scheduleSave();
  });
}
function notifyPushGate(run) {
  const pp = run.pendingPush; if (!pp) return;
  const tail = pp.runIdTail;
  tgNotify(
    `⬆️ *準備 Push 上 GitHub*\n\n🏛 ${tgEsc(run.topic)}\n📁 Project: ${tgEsc(path.basename(pp.project))}\n🌿 Branch: ${tgEsc(pp.branch)}\n\n確認 push?或改 project / branch。`,
    { inline_keyboard: [
      [{ text: '✅ Confirm Push', callback_data: `pg:confirm:${tail}` }],
      [{ text: '✏️ 改 Branch', callback_data: `pg:branch:${tail}` }, { text: '📁 改 Project', callback_data: `pg:project:${tail}` }],
      [{ text: '✋ 唔 push', callback_data: `pg:cancel:${tail}` }],
    ] },
    run && run.tgChatId
  );
}
function notifyPushResult(run, r) {
  const tail = run.pendingPush && run.pendingPush.runIdTail;
  if (r && r.ok) {
    tgNotify(`✅ *Push 完成*\n\n🏛 ${tgEsc(run.topic)}\n🌿 ${tgEsc(r.remoteBranch)} · ${tgEsc((r.pushedSha || '').slice(0, 7))}\nGitHub 已更新。`, null, run && run.tgChatId);
  } else {
    tgNotify(
      `⚠️ *Push 失敗*\n\n🏛 ${tgEsc(run.topic)}\n🌿 ${tgEsc(run.pendingPush && run.pendingPush.branch)}\n${tgEsc((r && r.err) || '')}${r && r.conflict ? '\n（遠端行先咗 non-fast-forward;改個新 branch push 或手動處理）' : ''}`,
      { inline_keyboard: [[{ text: '🔁 再試', callback_data: `pg:confirm:${tail}` }, { text: '✏️ 改 Branch', callback_data: `pg:branch:${tail}` }]] },
      run && run.tgChatId
    );
  }
}
// ─── Swarm Council (Council 議會 · Phase 2-4): 共識收斂 + 人手御准閘 + 人話講解 ───
// 三個你揀嘅 model 讀真 project + plan,互相博弈到零爭議,moderator 改寫 plan.vN;
// 收斂(或用盡 round)後停低交人手御准,批准後 explainer 用人話講解。全程沿用 CLI spawn
// (OAuth Max,零增量成本)。全部邏輯 gate by p.mode==='council',唔影響既有 code/thinking pipeline。
const SWARM_COUNCIL_MAX_ROUNDS = Number(process.env.SWARM_COUNCIL_MAX_ROUNDS || 5);      // 上限（實證+研究：value 集中頭 3-4 round,5+ 遞減/兜圈,故 8→5；MIN=3 保深度）
const SWARM_COUNCIL_MIN_ROUNDS = Math.max(1, Number(process.env.SWARM_COUNCIL_MIN_ROUNDS || 3)); // 收斂下限：未夠 N round 唔准收工,逼再鑽深
const SWARM_AUTO_COUNCIL_MIN_ROUNDS = Math.max(1, Number(process.env.SWARM_AUTO_COUNCIL_MIN_ROUNDS || SWARM_COUNCIL_MIN_ROUNDS)); // overnight 可自動過 gate，但預設唔降低深度
const SWARM_COUNCIL_DROP_AFTER = Math.max(1, Number(process.env.SWARM_COUNCIL_DROP_AFTER || 3)); // 一個 model 連續 N round fail → 踢走唔再 spawn(degrade 到在席者)
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
const SWARM_RUN_QUEUE = envFlag('SWARM_RUN_QUEUE', true);
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
  // migrated to hugo-personal plugins (2026-07 skills consolidation)
  'brainstormers':  { plugin: 'workflow-tools', skill: 'brainstormers' },
  'taste-skill':    { plugin: 'design', skill: 'taste' },
  'execution-discipline': { plugin: 'swarm-tools', skill: 'execution-discipline' },
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
    key: 'database',
    name: 'Database Agent',
    layer: 'delivery',
    role: 'DB / Migration',
    skill: 'schema / migrations / RLS / data integrity',
    scope: '只負責 DB 層:schema、migration 檔、RLS / index / 約束、資料完整性。改 schema 前先睇返現有 migration 嘅命名同序號(唔好撞號),migration 要可重跑 / 可回滾。唔好掂 UI 或無關 API。需要改 data shape 而會影響 backend contract 嘅,清楚 flag 出嚟畀 Backend Agent。',
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
  '你係「AI 聯合國 Council」嘅共識評審之一。其他 reviewer 可能係唔同 model、唔同角色，之後有一個 moderator 會 merge 大家意見、改寫 plan。你哋嘅職責唔係快速通過，而係**逼出一個「揀邊個 file、改邊段、點驗收」都講得清嘅 plan**。寧願拗多幾轉，都唔好留含糊。',
  '你嘅 cwd 就係真實 project 根目錄。你**必須真係用 Read / grep / Bash(ls/cat/git log)去查項目入面嘅實際文件**先發言 —— 引用要落到具體 file path + 函數 / 行號做證據,唔准淨係讀 plan 文字就估,亦唔准講空泛原則(例如淨係講「要注意安全」而唔指明邊個 endpoint / 邊個 query)。',
  '輸入:① 當前 plan(喺下面 task brief)② project 實際 code / 結構 / config。',
  '**深度紀律(必守)**:你嘅評審至少要逐一過呢 9 個維度,每個寫一句結論(冇問題都要講「已 check：…」,有問題就升做 OPEN_ISSUES):',
  '  1) 正確性 — plan 嘅邏輯 / 資料 / 公式啱唔啱。',
  '  2) Edge case — 空資料 / 0 份卷 / 缺欄位 / 超大量 / 並發 / 重複提交。',
  '  3) 失敗模式 — 邊步會炸、炸咗點 degrade、有冇 fail-loud（唔好靜靜吞 error）。',
  '  4) Data flow — 上下游 schema / API / state / DB migration 連扣有冇斷層或矛盾。',
  '  5) UI / UX — 流程順唔順、空狀態、loading、錯誤回報、手機 responsive。',
  '  6) 權限 / 安全 — 邊個 role 入到、有冇 IDOR / 越權 / 注入 / 洩漏。',
  '  7) 效能 — N+1、全表掃、阻塞、無謂重算。',
  '  8) 向後兼容 — 會唔會整爛現有功能 / 資料 / 既有 API。',
  '  9) 驗收 — plan 有冇講明「點先算做完」(可執行嘅驗證指令 + 期望 output)。',
  '根據 goal,逐點寫低你嘅評審:1. 要改善(plan 邊度弱、漏咗咩、邊度過度設計);2. 要做 / 要捉 fix(實際 code 入面有咩 bug / 缺口 / 風險要喺 plan 反映);3. 環節之間關係(步驟之間嘅依賴、UI、data flow 有冇斷層或矛盾)。',
  '博弈紀律:主動挑其他 reviewer(上一 round)嘅論點骨頭，標出歧義同矛盾。每一 round 都要帶**新嘢**(新 edge case / 新風險 / 更佳方案)，唔好淨係複製上一 round 嘅嘢。目標係**傾到 reviewer 全部同意、零爭議，而且 plan 已落到 file 級**。但**唔好為咗快而 AGREE** —— 只有當你逐個維度都 check 過、真係搵唔到可改善先 AGREE;同樣亦唔好為拗而拗。',
  '**唔好自己直接改 plan 文字檔** —— 你只負責提出結構化改動建議,由 moderator 落實(避免三人撞同一個 file)。',
  '最後**必須**用呢個固定格式收尾(俾機器 parse,前後唔好加多餘文字):',
  'CONSENSUS: AGREE        # 或 DISPUTE(你對當前 plan 仲有未解爭議)',
  'OPEN_ISSUES:',
  '- [id] 一句講清未解爭議 / 要 moderator 仲裁嘅點(AGREE 就寫「(none)」)',
  'PROPOSED_CHANGES:',
  '- 對 plan 嘅具體改動(patch 級描述:邊個 file、邊段、改成點、點驗收)',
].join('\n');

const COUNCIL_MODERATOR_SCOPE = [
  '你係「AI 聯合國 Council」嘅 moderator(仲裁收斂)。所有 reviewer 今 round 嘅完整輸出**會以 file path 形式喺 task brief 列出** —— 你**必須先用 Read tool 逐個讀晒嗰啲 file 全文**先 merge，唔好只靠摘要(摘要會缺料，尤其體積大嗰份)。讀埋當前 plan，有需要自己 Read / grep project 核實。',
  '1. Merge:將所有 reviewer 嘅 PROPOSED_CHANGES 合併、去重、解衝突，**改寫出新一版完整 plan**。有衝突嘅地方，揀技術上最穩陣嗰個，並一句講點解。**每一條評審提出嘅 proposal 都要有下場:要麼 incorporate 入 plan，要麼喺 DISPUTES 寫明點解 reject** —— 唔准靜靜雞當冇睇到。若某評審缺席(fail)，照 merge 在席者意見，唔好因為少咗一把聲就 block。',
  '2. 重新評估每條 OPEN_ISSUES:已解決就剔走;仍未解就保留,標明邊位提出、卡喺邊。',
  '3. **必須**將新 plan 全文用呢個 fenced block 輸出(系統會寫去 plan.vN.md):',
  '```plan-final',
  '<完整 markdown plan 全文 —— 要落到 file 級:每個改動講到改邊個 file / 介面 / 邊界條件 / 點驗收>',
  '```',
  '**⚠️ 區分兩種未決項(關鍵,防兜圈 / dead-loop)**:',
  '  • **技術爭議** = reviewer 之間真係拗緊、未有共識嘅技術點 → 計入 OPEN_DISPUTES,要繼續拗到解決。',
  '  • **需要人類(Hugo)拍板** = 產品 / 管治 / 安全取捨 / one-way-door 等**結構上要老闆揀**嘅決定(唔係技術拗唔掂,而係你哋冇權代佢決定)→ **唔好當 OPEN_DISPUTE**,放入獨立 ESCALATE 清單,並**照樣可以 CONVERGED**。再拗幾多 round 都解唔到一個本來唔屬於你哋決定嘅嘢 —— 一偵測到就收斂 + escalate,唔好為佢兜圈。',
  '**收斂門檻(嚴格,唔好為咗收工亂報,但亦唔好為咗一個 Hugo-decision 兜圈)**:以下全部成立就寫 CONVERGED —',
  '  (a) reviewer 零未解**技術**爭議(Hugo-decision 放 ESCALATE,唔阻收斂);',
  '  (b) plan 已落到**檔案 / 介面 / 邊界條件 / 驗收方式**級別,唔再停留喺概括或抽象層面;',
  '  (c) 冇未驗證嘅關鍵假設(有就喺 plan 講明點 verify)。',
  '若 ESCALATE 有項,喺 plan-final 入面開一段「## 需要 Hugo 決定(ESCALATE)」逐項列:係咩、點解要佢揀、你哋建議邊個 default + 理由(令就算佢未覆,落實都有個安全 default)。',
  '4. 之後**必須**用呢個固定格式收尾(俾機器 parse):',
  'COUNCIL: CONVERGED      # reviewer 零未解「技術」爭議 + plan 已落 file 級(Hugo-decision 放 ESCALATE 唔阻);仲有技術爭議先寫 OPEN',
  'OPEN_DISPUTES: <整數>     # 只計技術爭議,唔計 ESCALATE',
  'DISPUTES:',
  '- [id] 一句講未解技術爭議(CONVERGED 就寫「(none)」)',
  'ESCALATE:',
  '- [id] 需要 Hugo 拍板嘅項 + 你哋建議嘅 default(冇就寫「(none)」)',
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

// 最終仲裁者 (Opus 4.8)：只可仲裁技術爭議；產品/安全/one-way-door 仍然交 Hugo / owner。
const COUNCIL_ARBITER_SCOPE = [
  '你係「AI 聯合國 Council」嘅**最終技術仲裁者**,用緊 Opus 4.8 —— reviewer 拗咗好多 round 都未完全收斂，而家由你處理**技術爭議**。你唔可以代 Hugo / owner 拍產品、安全、付費、資料刪除、權限放寬、one-way-door 等決策。',
  '你嘅 cwd 係真實 project 根目錄,有需要可以用 Read / grep 親自核實先決定,唔好淨係靠人哋摘要。',
  '輸入:① goal ② 議會跑足 N round 後嘅最新 plan ③ 仲未解嘅技術爭議 / 要拍板嘅 ESCALATE ④ 最後一 round Council review。',
  '你嘅任務:逐條未解**技術爭議**做最終決定 —— 揀技術上最穩陣、最符合 goal、對現有系統最安全(唔整爛現有嘢)嗰個方案,每條一句講點解咁揀。',
  '若遇到產品 / 管治 / 安全 / 付費 / 資料刪除 / 權限放寬 / one-way-door / owner preference 類 ESCALATE,你**必須保留為「需要 Hugo 決定」**,寫明安全 default + tradeoff,但唔准假裝已拍板。',
  '輸出一份**完全收斂、file 級、可直接落 code** 嘅 final plan,用呢個 fenced block(系統會寫做新 plan 版本,俾 build agent 直接跟):',
  '```plan-final',
  '<完整 markdown plan 全文 —— 每個改動講到改邊個 file / 介面 / 邊界 / 點驗收;技術爭議改寫成「✅ 已技術仲裁:揀 X,因為 …」;人類決策保留喺「## 需要 Hugo 決定(ESCALATE)」>',
  '```',
  '之後**獨立一段**用人話(繁中)講晒:你仲裁咗幾多個技術點、保留咗幾多個 Hugo 決策、整體取態,等 Hugo 一眼睇得明。',
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
  // ── Swarm Council presets ── reviewer 用硬角色/自由觀點/9-grid 分工,再配唔同 model/skills
  {
    key: 'council_a',
    name: 'Council A · Architecture',
    layer: 'research',
    role: '架構 / 範圍評審',
    skill: 'architecture / scope / data-flow',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 你嘅硬角色（Seat A）\n你專注 architecture、scope control、data flow、file boundaries、dependency order。你要防止 plan 過度膨脹、漏改核心 file、或者上下游 contract 斷層。最後 PROPOSED_CHANGES 要特別講清楚 file 級落點同依賴順序。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_b',
    name: 'Council B · Implementation',
    layer: 'research',
    role: '落地 / 測試評審',
    skill: 'implementation feasibility / testing / build order',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 你嘅硬角色（Seat B）\n你專注 coding feasibility、testability、驗收指令、rollback、build order、developer ergonomics。你要指出 plan 入面邊啲步驟落 code 會卡、邊啲驗證唔夠實、邊啲需要拆細先唔會撞。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_c',
    name: 'Council C · Risk',
    layer: 'research',
    role: '反方 / 風險評審',
    skill: 'red-team / edge cases / security / regressions',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 你嘅硬角色（Seat C）\n你係反方同風險擔當。專注 security、edge cases、failure modes、regression、data loss、權限、one-way-door 決策。遇到產品/安全/不可逆取捨要明確 ESCALATE Hugo,唔好俾其他席位草率通過。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_opus_free',
    name: 'Council Opus · Free View',
    layer: 'research',
    role: 'Opus 自由觀點',
    skill: 'broad product / architecture / tradeoff review',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 自由觀點（Opus）\n你唔綁定 A/B/C 硬角色。請用你作為 Opus 嘅自然判斷，從產品目標、系統設計、scope、風險、可交付性整體評審。重點係提出其他 model 可能忽略嘅大局同取捨。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_codex_free',
    name: 'Council Codex · Free View',
    layer: 'research',
    role: 'Codex 自由觀點',
    skill: 'implementation / testing / codebase-practical review',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 自由觀點（Codex）\n你唔綁定 A/B/C 硬角色。請用你作為 Codex 嘅自然判斷，從實作可行性、code path、測試、回歸風險、developer workflow 整體評審。重點係指出落 code 時真會卡住嘅地方。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_glm_free',
    name: 'Council GLM · Free View',
    layer: 'research',
    role: 'GLM 自由觀點',
    skill: 'independent alternative / contradiction review',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 自由觀點（GLM）\n你唔綁定 A/B/C 硬角色。請用你作為 GLM 嘅自然判斷，主動提出替代路線、矛盾、漏位、中文語境/流程上可能被忽略嘅問題。重點係補足不同公司 model 嘅獨立視角。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_opus_arch',
    name: 'Grid Opus · Architecture',
    layer: 'research',
    role: 'Opus 架構評審',
    skill: 'architecture / scope / data-flow',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Opus × Architecture\n你只專注架構、scope、data flow、file boundaries、dependency order。用 Opus 視角指出 plan 在系統結構上最應該保留、刪減或重排嘅地方。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_codex_arch',
    name: 'Grid Codex · Architecture',
    layer: 'research',
    role: 'Codex 架構評審',
    skill: 'architecture / implementation boundaries',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Codex × Architecture\n你只專注架構同 code boundary。用 Codex 視角檢查現有檔案、模組邊界、依賴方向同落 code 順序會唔會斷。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_glm_arch',
    name: 'Grid GLM · Architecture',
    layer: 'research',
    role: 'GLM 架構評審',
    skill: 'architecture / alternative structure',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：GLM × Architecture\n你只專注架構同替代設計。用 GLM 視角提出是否有更簡單、更穩、更少耦合嘅結構安排。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_opus_impl',
    name: 'Grid Opus · Implementation',
    layer: 'research',
    role: 'Opus 實作評審',
    skill: 'implementation feasibility / acceptance',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Opus × Implementation\n你只專注落地方案、驗收準則同工程取捨。用 Opus 視角檢查 plan 是否太抽象、是否可交付、是否有更穩嘅拆法。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_codex_impl',
    name: 'Grid Codex · Implementation',
    layer: 'research',
    role: 'Codex 實作評審',
    skill: 'coding feasibility / tests / build order',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Codex × Implementation\n你只專注 coding feasibility、testability、驗收指令、rollback、build order。用 Codex 視角講清楚實作會改邊啲 file、點樣驗證。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_glm_impl',
    name: 'Grid GLM · Implementation',
    layer: 'research',
    role: 'GLM 實作評審',
    skill: 'implementation alternatives / workflow',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：GLM × Implementation\n你只專注實作路線同替代方案。用 GLM 視角指出有冇更短、更少副作用、更容易驗收嘅做法。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_opus_risk',
    name: 'Grid Opus · Risk',
    layer: 'research',
    role: 'Opus 風險評審',
    skill: 'risk / product safety / edge cases',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Opus × Risk\n你只專注風險、產品安全、不可逆決策、owner gate。用 Opus 視角指出最值得停低、降 scope 或 escalate 嘅地方。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_codex_risk',
    name: 'Grid Codex · Risk',
    layer: 'research',
    role: 'Codex 風險評審',
    skill: 'regression / failure modes / test gaps',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：Codex × Risk\n你只專注 regression、failure modes、測試缺口、部署風險。用 Codex 視角指出最容易喺 code 實作時整壞嘅位。`,
    deliveryMode: 'thinking',
    deliverable: 'consensus-review',
  },
  {
    key: 'council_glm_risk',
    name: 'Grid GLM · Risk',
    layer: 'research',
    role: 'GLM 風險評審',
    skill: 'red-team / edge cases / contradiction',
    scope: `${COUNCIL_REVIEWER_SCOPE}\n\n## 9-grid 角色：GLM × Risk\n你只專注反方、edge case、矛盾同漏位。用 GLM 視角挑戰其他方案，尤其係安全、資料、權限、流程死角。`,
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
  database:    ['architect', 'security-auditor', 'debugger'],
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
  council_opus_free: ['brainstormers', 'architect', 'reviewer-persona'],
  council_codex_free: ['architect', 'debugger', 'reviewer-persona'],
  council_glm_free: ['brainstormers', 'refactor-engineer', 'reviewer-persona'],
  council_opus_arch: ['architect', 'brainstormers', 'reviewer-persona'],
  council_codex_arch: ['architect', 'debugger', 'reviewer-persona'],
  council_glm_arch: ['architect', 'brainstormers', 'reviewer-persona'],
  council_opus_impl: ['architect', 'reviewer-persona'],
  council_codex_impl: ['debugger', 'reviewer-persona'],
  council_glm_impl: ['refactor-engineer', 'reviewer-persona'],
  council_opus_risk: ['security-auditor', 'reviewer-persona'],
  council_codex_risk: ['debugger', 'security-auditor', 'reviewer-persona'],
  council_glm_risk: ['brainstormers', 'security-auditor', 'reviewer-persona'],
  moderator:   ['architect', 'reviewer-persona'],
  explainer:   [],  // 只靠 execution-discipline + tone prompt,免污染人話 tone
  overseer:    ['brainstormers', 'architect', 'reviewer-persona'],  // 總管:點子 + 系統思維 + 批判 review
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

function skillKeysForPreset(presetKey) {
  const keys = [];
  if (SKILL_CACHE['execution-discipline']) keys.push('execution-discipline');
  for (const sk of (AGENT_SKILL_MAP[presetKey] || [])) {
    if (SKILL_CACHE[sk]) keys.push(sk);
  }
  return keys;
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
// 手機 UA 開 / → server-side 302 跳去 mobile-first 頁（唔受 client cache 影響;?desktop=1 可 bypass 睇桌面版）
app.get(['/', '/index.html'], (req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPod|Android.*Mobile/i.test(ua);
  if (isMobile && req.query.desktop === undefined) {
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, '/m.html');
  }
  next();
});
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
rebuildRunQueuePending();

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

function normalizeTextField(value, max = MISSION_CONTROL_MAX_CHARS) {
  return truncate(String(value == null ? '' : value), max);
}

function normalizeStringList(value, fallback = [], maxItems = 10, maxChars = 420) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/\r?\n/);
  else list = fallback;
  const out = [];
  list.forEach((item) => {
    const text = truncate(String(item || '').replace(/^\s*[-*]\s*/, ''), maxChars);
    if (text && !out.includes(text)) out.push(text);
  });
  return out.slice(0, maxItems);
}

function cloneIntentPack(pack) {
  const p = pack || INTENT_PACKS.general;
  return {
    key: p.key,
    version: p.version,
    label: p.label,
    shortLabel: p.shortLabel,
    summary: p.summary,
    priorities: [...(p.priorities || [])],
    acceptance: [...(p.acceptance || [])],
    nonGoals: [...(p.nonGoals || [])],
  };
}

function normalizeIntentPackKey(value, fallback = 'general') {
  const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (INTENT_PACKS[key]) return key;
  if (key === 'mvp' || key === 'school_tracker' || key === 'mvp_school_tracker') return 'school_mvp';
  if (key === 'full' || key === 'school_os' || key === 'learning_os') return 'school_os_full';
  return INTENT_PACKS[fallback] ? fallback : 'general';
}

function projectDefaultIntentPackKey(projectPath) {
  const value = String(projectPath || DEFAULT_PROJECT_ROOT).toLowerCase();
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => part === 'orca' || part === 'orca-platform-mvp' || /^orca-platform(?:-|$)/.test(part)) ? 'school_mvp' : 'general';
}

function resolveIntentPack({ key, projectPath, projectDefault, source } = {}) {
  const hasExplicit = key !== undefined && key !== null && String(key).trim() !== '';
  const base = hasExplicit ? String(key).trim() : (projectDefault || projectDefaultIntentPackKey(projectPath));
  const normalized = normalizeIntentPackKey(base, projectDefaultIntentPackKey(projectPath));
  const requestedUnknown = hasExplicit && !INTENT_PACKS[String(key || '').trim().toLowerCase().replace(/[-\s]+/g, '_')]
    && !['mvp', 'school_tracker', 'mvp_school_tracker', 'full', 'school_os', 'learning_os'].includes(String(key || '').trim().toLowerCase().replace(/[-\s]+/g, '_'));
  return {
    key: normalized,
    version: INTENT_PACKS[normalized].version,
    label: INTENT_PACKS[normalized].label,
    snapshot: cloneIntentPack(INTENT_PACKS[normalized]),
    source: source || (hasExplicit ? 'user' : 'project-default'),
    requestedKey: hasExplicit ? String(key).trim() : '',
    fallbackWarning: requestedUnknown ? `Unknown intent pack "${String(key).trim()}", fallback to ${normalized}.` : '',
  };
}

function intentPackPrompt(pack) {
  const p = pack && pack.key ? pack : cloneIntentPack(INTENT_PACKS.general);
  return [
    `### ${p.label} v${p.version}`,
    p.summary || '',
    '',
    'Priorities:',
    ...((p.priorities || []).length ? p.priorities.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Acceptance:',
    ...((p.acceptance || []).length ? p.acceptance.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Non-goals:',
    ...((p.nonGoals || []).length ? p.nonGoals.map((x) => `- ${x}`) : ['- (none)']),
  ].join('\n');
}

function cloneDomainModule(module) {
  const m = module || DOMAIN_MODULES.assessment_intelligence;
  return {
    key: m.key,
    version: m.version,
    label: m.label,
    shortLabel: m.shortLabel,
    summary: m.summary,
    priorities: [...(m.priorities || [])],
    acceptance: [...(m.acceptance || [])],
    nonGoals: [...(m.nonGoals || [])],
    modules: (m.modules || []).map((item) => ({
      key: item.key,
      label: item.label,
      focus: item.focus,
      checks: [...(item.checks || [])],
    })),
  };
}

function normalizeDomainModuleKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!key || key === 'none' || key === 'off') return '';
  if (DOMAIN_MODULES[key]) return key;
  if (['assessment', 'assessment_suite', 'assessment_intelligence_suite', 'grading', 'marking', 'rubric', '改卷'].includes(key)) return 'assessment_intelligence';
  if (['ui', 'ux', 'visual', 'visual_qa', 'ui_qa', 'ui_visual', 'screenshot', 'screenshot_loop', 'frontend_visual', '介面', '畫面', '截圖'].includes(key)) return 'ui_visual_qa';
  return '';
}

function normalizeDomainModuleKeys(value, fallback = []) {
  const raw = Array.isArray(value) ? value
    : (typeof value === 'string' ? value.split(/[\n,|]+/) : fallback);
  const out = [];
  (raw || []).forEach((item) => {
    const key = normalizeDomainModuleKey(item);
    if (key && !out.includes(key)) out.push(key);
  });
  return out;
}

function projectDefaultDomainModuleKeys(projectPath) {
  return [];
}

function taskAutoDomainModuleKeys({ topic, taskBrief, text } = {}) {
  const haystack = String([topic, taskBrief, text].filter(Boolean).join('\n')).toLowerCase();
  const keys = [];
  if (/(grading|marking|rubric|assessment|exam|paper|answer|score|student ability|misconception|改卷|批改|評分|試卷|答案|錯題|能力|老師審批|老師覆核|班級|全級)/i.test(haystack)) {
    keys.push('assessment_intelligence');
  }
  if (/(ui|ux|frontend|css|layout|responsive|visual|screenshot|playwright|browser|desktop|mobile|dashboard|card|button|modal|drawer|overflow|overlap|介面|畫面|前端|樣式|手機|桌面|截圖|好睇|排版|按鈕|卡片|儀表板|重疊)/i.test(haystack)) {
    keys.push('ui_visual_qa');
  }
  return keys;
}

function resolveDomainModules({ keys, projectDefaultKeys, topic, taskBrief, source } = {}) {
  const hasExplicit = keys !== undefined && keys !== null;
  const explicit = normalizeDomainModuleKeys(keys, []);
  const projectDefaults = normalizeDomainModuleKeys(projectDefaultKeys, []);
  const auto = hasExplicit ? [] : taskAutoDomainModuleKeys({ topic, taskBrief });
  const merged = hasExplicit ? explicit : normalizeDomainModuleKeys([...projectDefaults, ...auto], []);
  const snapshots = merged.map((key) => cloneDomainModule(DOMAIN_MODULES[key])).filter(Boolean);
  return {
    keys: merged,
    snapshots,
    source: source || (hasExplicit ? 'user' : (auto.length ? 'auto' : 'project-default')),
  };
}

function domainModulePrompt(module) {
  const m = module && module.key ? module : cloneDomainModule(DOMAIN_MODULES.assessment_intelligence);
  return [
    `### ${m.label} v${m.version}`,
    m.summary || '',
    '',
    'Priorities:',
    ...((m.priorities || []).length ? m.priorities.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Acceptance:',
    ...((m.acceptance || []).length ? m.acceptance.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Internal modules:',
    ...((m.modules || []).length ? m.modules.flatMap((item) => [
      `- ${item.label}: ${item.focus || ''}`,
      ...((item.checks || []).map((check) => `  - Check: ${check}`)),
    ]) : ['- (none)']),
    '',
    'Non-goals:',
    ...((m.nonGoals || []).length ? m.nonGoals.map((x) => `- ${x}`) : ['- (none)']),
  ].join('\n');
}

function defaultMissionControl() {
  return {
    version: 1,
    defaultGlobalGoal: normalizeTextField(process.env.SWARM_GLOBAL_GOAL || DEFAULT_GLOBAL_GOAL),
    defaultIntentPackKey: normalizeIntentPackKey(process.env.SWARM_INTENT_PACK || '', 'general'),
    defaultDomainModuleKeys: normalizeDomainModuleKeys(process.env.SWARM_DOMAIN_MODULES || '', []),
    projects: {},
    handoffGuidelines: normalizeStringList(process.env.SWARM_COORDINATION_WARNINGS || DEFAULT_COORDINATION_WARNINGS, DEFAULT_COORDINATION_WARNINGS),
    updatedAt: null,
    updatedBy: 'system',
  };
}

function normalizeMissionControl(raw = {}) {
  const base = defaultMissionControl();
  const projects = {};
  const rawProjects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
  Object.entries(rawProjects).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const projectPath = normalizeTextField(value.projectPath || key, 1000);
    projects[key] = {
      projectPath,
      label: normalizeTextField(value.label || path.basename(projectPath), 160),
      globalGoal: normalizeTextField(value.globalGoal || value.goal || base.defaultGlobalGoal),
      defaultIntentPackKey: normalizeIntentPackKey(value.defaultIntentPackKey || value.intentPackKey || '', projectDefaultIntentPackKey(projectPath)),
      defaultDomainModuleKeys: normalizeDomainModuleKeys(value.defaultDomainModuleKeys || value.domainModuleKeys || value.intentModuleKeys || '', projectDefaultDomainModuleKeys(projectPath)),
      updatedAt: value.updatedAt || null,
      updatedBy: normalizeUserLabel(value.updatedBy || 'system', 'system'),
    };
  });
  return {
    version: Number(raw.version || base.version) || 1,
    defaultGlobalGoal: normalizeTextField(raw.defaultGlobalGoal || raw.globalGoal || base.defaultGlobalGoal),
    defaultIntentPackKey: normalizeIntentPackKey(raw.defaultIntentPackKey || raw.intentPackKey || base.defaultIntentPackKey, 'general'),
    defaultDomainModuleKeys: normalizeDomainModuleKeys(raw.defaultDomainModuleKeys || raw.domainModuleKeys || raw.intentModuleKeys || base.defaultDomainModuleKeys, []),
    projects,
    handoffGuidelines: normalizeStringList(raw.handoffGuidelines || raw.defaultWarnings, base.handoffGuidelines),
    updatedAt: raw.updatedAt || base.updatedAt,
    updatedBy: normalizeUserLabel(raw.updatedBy || base.updatedBy, 'system'),
  };
}

function projectMissionKey(projectPath) {
  const raw = projectPath || DEFAULT_PROJECT_ROOT;
  try { return safeProjectPath(raw); } catch (_) { return path.resolve(String(raw || DEFAULT_PROJECT_ROOT)); }
}

function projectMissionControl(projectPath) {
  const control = readMissionControl();
  const key = projectMissionKey(projectPath || DEFAULT_PROJECT_ROOT);
  const entry = control.projects[key] || null;
  const globalGoal = (entry && entry.globalGoal) || control.defaultGlobalGoal || DEFAULT_GLOBAL_GOAL;
  const inferredIntentPackKey = projectDefaultIntentPackKey(key);
  const globalIntentPackKey = control.defaultIntentPackKey || 'general';
  const defaultIntentPackKey = (entry && entry.defaultIntentPackKey) || (globalIntentPackKey !== 'general' ? globalIntentPackKey : inferredIntentPackKey);
  const defaultDomainModuleKeys = normalizeDomainModuleKeys(
    (entry && entry.defaultDomainModuleKeys) || control.defaultDomainModuleKeys || projectDefaultDomainModuleKeys(key),
    projectDefaultDomainModuleKeys(key)
  );
  return {
    version: control.version || 1,
    projectPath: key,
    label: (entry && entry.label) || path.basename(key),
    globalGoal,
    defaultGlobalGoal: control.defaultGlobalGoal,
    defaultIntentPackKey: normalizeIntentPackKey(defaultIntentPackKey, projectDefaultIntentPackKey(key)),
    defaultDomainModuleKeys,
    handoffGuidelines: control.handoffGuidelines || [],
    // Back-compat for old clients; no longer user-editable warnings.
    defaultWarnings: control.handoffGuidelines || [],
    updatedAt: (entry && entry.updatedAt) || control.updatedAt,
    updatedBy: (entry && entry.updatedBy) || control.updatedBy,
    projectGoals: Object.values(control.projects || {}).map((p) => ({
      projectPath: p.projectPath,
      label: p.label,
      defaultIntentPackKey: p.defaultIntentPackKey,
      defaultDomainModuleKeys: p.defaultDomainModuleKeys || [],
      updatedAt: p.updatedAt,
      updatedBy: p.updatedBy,
    })),
  };
}

function readMissionControl() {
  try {
    if (!fs.existsSync(MISSION_CONTROL_FILE)) return defaultMissionControl();
    return normalizeMissionControl(JSON.parse(fs.readFileSync(MISSION_CONTROL_FILE, 'utf8')));
  } catch (error) {
    console.warn('[mission-control] failed to read, using defaults:', error.message);
    return defaultMissionControl();
  }
}

function writeMissionControl(patch = {}) {
  const current = readMissionControl();
  const updatedAt = new Date().toISOString();
  const updatedBy = normalizeUserLabel(patch.updatedBy || current.updatedBy || 'dashboard', 'dashboard');
  let nextRaw = { ...current, version: Math.max(1, Number(current.version || 1) + 1), updatedAt, updatedBy };
  if (patch.projectPath !== undefined || patch.globalGoal !== undefined) {
    const key = projectMissionKey(patch.projectPath || DEFAULT_PROJECT_ROOT);
    nextRaw.projects = { ...(current.projects || {}) };
    nextRaw.projects[key] = {
      ...(nextRaw.projects[key] || {}),
      projectPath: key,
      label: normalizeTextField(patch.label || (nextRaw.projects[key] && nextRaw.projects[key].label) || path.basename(key), 160),
      globalGoal: normalizeTextField(patch.globalGoal || (nextRaw.projects[key] && nextRaw.projects[key].globalGoal) || current.defaultGlobalGoal),
      defaultIntentPackKey: normalizeIntentPackKey(patch.defaultIntentPackKey || patch.intentPackKey || (nextRaw.projects[key] && nextRaw.projects[key].defaultIntentPackKey) || projectDefaultIntentPackKey(key), projectDefaultIntentPackKey(key)),
      defaultDomainModuleKeys: normalizeDomainModuleKeys(patch.defaultDomainModuleKeys !== undefined ? patch.defaultDomainModuleKeys : (patch.domainModuleKeys !== undefined ? patch.domainModuleKeys : ((nextRaw.projects[key] && nextRaw.projects[key].defaultDomainModuleKeys) || projectDefaultDomainModuleKeys(key))), projectDefaultDomainModuleKeys(key)),
      updatedAt,
      updatedBy,
    };
  }
  if (patch.defaultGlobalGoal !== undefined) nextRaw.defaultGlobalGoal = normalizeTextField(patch.defaultGlobalGoal);
  if (patch.defaultIntentPackKey !== undefined) nextRaw.defaultIntentPackKey = normalizeIntentPackKey(patch.defaultIntentPackKey, 'general');
  if (patch.defaultDomainModuleKeys !== undefined) nextRaw.defaultDomainModuleKeys = normalizeDomainModuleKeys(patch.defaultDomainModuleKeys, []);
  if (patch.handoffGuidelines !== undefined) nextRaw.handoffGuidelines = normalizeStringList(patch.handoffGuidelines, current.handoffGuidelines || []);
  const next = normalizeMissionControl(nextRaw);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MISSION_CONTROL_FILE, JSON.stringify(next, null, 2));
  return next;
}

function normalizeMissionTarget(value, fallback = '') {
  const base = {
    summary: '',
    acquire: '',
    optimize: '',
    acceptance: '',
    nonGoals: '',
    source: '',
    draftedAt: null,
    draftModel: '',
  };
  if (typeof value === 'string') {
    base.summary = value;
  } else if (value && typeof value === 'object') {
    base.summary = value.summary || value.goal || value.missionGoal || '';
    base.acquire = value.acquire || value.acquireTargets || value.acquisition || '';
    base.optimize = value.optimize || value.optimizeTargets || value.optimization || '';
    base.acceptance = value.acceptance || value.acceptanceCriteria || value.successCriteria || '';
    base.nonGoals = value.nonGoals || value.avoid || value.outOfScope || '';
    base.source = value.source || value.status || '';
    base.draftedAt = value.draftedAt || value.createdAt || null;
    base.draftModel = value.draftModel || value.model || '';
  }
  base.summary = normalizeTextField(base.summary || fallback, 1600);
  base.acquire = normalizeTextField(base.acquire, 1200);
  base.optimize = normalizeTextField(base.optimize, 1200);
  base.acceptance = normalizeTextField(base.acceptance, 1200);
  base.nonGoals = normalizeTextField(base.nonGoals, 1200);
  base.source = normalizeTextField(base.source || (value ? 'manual' : 'auto'), 80);
  base.draftModel = normalizeTextField(base.draftModel, 80);
  return base;
}

function buildRunMissionContext({ topic, taskBrief, projectPath, globalGoal, missionTarget, coordinationWarnings, intentPackKey, intentPackSource, domainModuleKeys, domainModuleSource } = {}) {
  const control = projectMissionControl(projectPath || DEFAULT_PROJECT_ROOT);
  const fallback = taskBrief || topic || '';
  const intent = resolveIntentPack({
    key: intentPackKey,
    projectPath: control.projectPath,
    projectDefault: control.defaultIntentPackKey,
    source: intentPackSource,
  });
  const modules = resolveDomainModules({
    keys: domainModuleKeys,
    projectDefaultKeys: control.defaultDomainModuleKeys,
    topic,
    taskBrief,
    source: domainModuleSource,
  });
  return {
    globalGoal: normalizeTextField(globalGoal || control.globalGoal),
    missionTarget: normalizeMissionTarget(missionTarget, fallback),
    coordinationWarnings: normalizeStringList(coordinationWarnings, control.handoffGuidelines),
    missionControlVersion: control.version || 1,
    missionControlProjectPath: control.projectPath,
    intentPackKey: intent.key,
    intentPackVersion: intent.version,
    intentPackSnapshot: intent.snapshot,
    intentPackSource: intent.source,
    intentPackFallbackWarning: intent.fallbackWarning,
    domainModuleKeys: modules.keys,
    domainModuleSnapshots: modules.snapshots,
    domainModuleSource: modules.source,
  };
}

function ensureRunMissionContext(run) {
  if (!run) return null;
  const hadValidIntentPack = !!(run.intentPackKey && INTENT_PACKS[run.intentPackKey]);
  const hadDomainModules = Array.isArray(run.domainModuleKeys);
  const ctx = buildRunMissionContext({
    topic: run.topic,
    taskBrief: run.taskBrief,
    projectPath: run.projectPath,
    globalGoal: run.globalGoal,
    missionTarget: run.missionTarget,
    coordinationWarnings: run.coordinationWarnings,
    intentPackKey: run.intentPackKey,
    intentPackSource: run.intentPackSource,
    domainModuleKeys: run.domainModuleKeys,
    domainModuleSource: run.domainModuleSource,
  });
  run.globalGoal = ctx.globalGoal;
  run.missionTarget = ctx.missionTarget;
  run.coordinationWarnings = ctx.coordinationWarnings;
  run.missionControlVersion = run.missionControlVersion || ctx.missionControlVersion;
  run.missionControlProjectPath = run.missionControlProjectPath || ctx.missionControlProjectPath;
  if (!hadValidIntentPack) run.intentPackKey = ctx.intentPackKey;
  if (!hadValidIntentPack || !run.intentPackVersion) run.intentPackVersion = ctx.intentPackVersion;
  if (!hadValidIntentPack || !run.intentPackSnapshot || run.intentPackSnapshot.key !== run.intentPackKey) run.intentPackSnapshot = ctx.intentPackSnapshot;
  run.intentPackSource = run.intentPackSource || ctx.intentPackSource;
  if (!hadDomainModules) run.domainModuleKeys = ctx.domainModuleKeys;
  if (!Array.isArray(run.domainModuleSnapshots) || run.domainModuleSnapshots.map((m) => m.key).join('|') !== (run.domainModuleKeys || []).join('|')) {
    run.domainModuleSnapshots = (run.domainModuleKeys || []).map((key) => cloneDomainModule(DOMAIN_MODULES[key])).filter(Boolean);
  }
  run.domainModuleSource = run.domainModuleSource || ctx.domainModuleSource;
  return ctx;
}

function missionTargetSummary(target) {
  if (!target) return '';
  if (typeof target === 'string') return truncate(target, 500);
  return truncate([target.summary, target.acquire, target.optimize, target.acceptance, target.nonGoals].filter(Boolean).join(' | '), 900);
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) text = obj[0];
  try { return JSON.parse(text); } catch (_) { return null; }
}

function fallbackMissionTarget({ topic, taskBrief, globalGoal } = {}) {
  const source = truncate(taskBrief || topic || '', 1200);
  return normalizeMissionTarget({
    summary: source || '將今次需求收斂成可交付 mission。',
    acquire: '取得足夠 context、現有實作位置、成功準則同風險。',
    optimize: '改善同共同大目標直接相關嘅工作流，避免只做局部 patch。',
    acceptance: '有清楚變更範圍、測試 / 驗證結果、剩餘風險同下一步。',
    nonGoals: '唔擴大 scope；唔改安全 / billing / irreversible 設定；唔覆蓋其他人改動。',
    source: 'fallback',
    draftedAt: new Date().toISOString(),
    draftModel: 'heuristic',
  }, source || globalGoal || '');
}

async function draftMissionTargetAI({ topic, taskBrief, projectPath, globalGoal, cli, model } = {}) {
  const fallback = fallbackMissionTarget({ topic, taskBrief, globalGoal });
  if (process.env.SWARM_MISSION_TARGET_AI === '0') return fallback;
  const picked = normalizeModelChoice({ cli, model }, { cli: 'claude', model: 'sonnet' });
  if (!picked.cli) picked.cli = 'claude';
  if (!picked.model) picked.model = 'sonnet';
  const prompt = [
    '你係 Swarm Mission 嘅 mission-target planner。請根據 repo 大目標同用戶任務，為今次 mission 起草一份 mission-specific target。',
    '要求：',
    '- 用繁體中文 / 廣東話，短而具體。',
    '- target 要講清楚今次要 acquire 到乜、要 optimize 邊個系統 / flow、acceptance criteria、non-goals。',
    '- 唔好將 handoff reminder/warning 寫成用戶要填嘅項目；handoff 係 agent 完成後交棒先產生。',
    '- 嚴格只輸出 JSON object，schema:',
    '{"summary":"一句 mission goal","acquire":"要取得 / 查明 / 補齊嘅資料或成果","optimize":"要優化嘅 repo flow / 系統位置","acceptance":"成功準則","nonGoals":"今次唔做乜 / 避免乜"}',
    '',
    `Repo / Project: ${projectPath || '-'}`,
    `Repo 大目標:\n${globalGoal || DEFAULT_GLOBAL_GOAL}`,
    '',
    `Mission request:\n${truncate(taskBrief || topic || '', 5000)}`,
    '',
    'JSON:',
  ].join('\n');
  try {
    const raw = await spawnOneShot(prompt, picked, 'swarm-target-draft', Number(process.env.SWARM_TARGET_DRAFT_TIMEOUT_MS || 90000));
    const obj = parseJsonObject(raw);
    if (!obj) return fallback;
    return normalizeMissionTarget({
      ...obj,
      source: 'ai',
      draftedAt: new Date().toISOString(),
      draftModel: `${picked.cli}:${picked.model}`,
    }, taskBrief || topic || '');
  } catch (error) {
    console.warn('[mission-target] AI draft failed:', error.message);
    return fallback;
  }
}

async function ensureMissionTargetDraft(run, options = {}) {
  if (!run) return null;
  const existing = normalizeMissionTarget(run.missionTarget, run.taskBrief || run.topic || '');
  const hasUserTarget = options.force !== true && existing.summary && !['auto', 'fallback'].includes(String(existing.source || '').toLowerCase());
  if (hasUserTarget) {
    run.missionTarget = existing;
    return existing;
  }
  const target = await draftMissionTargetAI({
    topic: run.topic,
    taskBrief: options.taskBrief || run.taskBrief,
    projectPath: run.projectPath,
    globalGoal: run.globalGoal,
    cli: options.cli,
    model: options.model,
  });
  run.missionTarget = target;
  run.updatedAt = new Date().toISOString();
  addArtifact(run, {
    type: 'mission-target',
    title: target.source === 'ai' ? '🎯 AI Mission Target Draft' : '🎯 Mission Target Draft (fallback)',
    content: missionTargetSummary(target),
  });
  scheduleSave();
  return target;
}

function buildMissionContextBlock(run) {
  const ctx = ensureRunMissionContext(run || {});
  const t = ctx.missionTarget || {};
  const pack = (run && run.intentPackSnapshot) || ctx.intentPackSnapshot || cloneIntentPack(INTENT_PACKS.general);
  const modules = (run && run.domainModuleSnapshots) || ctx.domainModuleSnapshots || [];
  const lines = [
    '## Mission North Star / Repo Goal',
    '以下大目標係對應呢個 repo / project，不係全 server 共用。所有 agent 要以佢做判斷基準，唔好只係完成自己手上嗰粒 task。',
    '',
    '### Repo Goal',
    ctx.globalGoal || '(not set)',
    '',
    '### This Mission Target（AI 起草，可由 owner 改）',
    `Mission goal: ${t.summary || '(not set)'}`,
    t.acquire ? `Acquire / obtain: ${t.acquire}` : '',
    t.optimize ? `Optimize / improve: ${t.optimize}` : '',
    t.acceptance ? `Acceptance criteria: ${t.acceptance}` : '',
    t.nonGoals ? `Non-goals / avoid: ${t.nonGoals}` : '',
    t.source ? `Target source: ${t.source}${t.draftModel ? ` · ${t.draftModel}` : ''}` : '',
    '',
    '### Product Scope Pack',
    `Scope: ${pack.label || pack.key} v${pack.version || 1} (${(run && run.intentPackSource) || ctx.intentPackSource || 'auto'})`,
    pack.summary || '',
    '',
    'Intent priorities:',
    ...((pack.priorities || []).length ? pack.priorities.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Intent acceptance:',
    ...((pack.acceptance || []).length ? pack.acceptance.map((x) => `- ${x}`) : ['- (none)']),
    '',
    'Intent non-goals:',
    ...((pack.nonGoals || []).length ? pack.nonGoals.map((x) => `- ${x}`) : ['- (none)']),
    '',
    '### Domain Modules',
    ...(modules.length ? modules.flatMap((m) => [
      `#### ${m.label || m.key} v${m.version || 1}`,
      m.summary || '',
      'Module priorities:',
      ...((m.priorities || []).length ? m.priorities.map((x) => `- ${x}`) : ['- (none)']),
      'Internal module checks:',
      ...((m.modules || []).length ? m.modules.flatMap((item) => [
        `- ${item.label}: ${item.focus || ''}`,
        ...((item.checks || []).map((check) => `  - ${check}`)),
      ]) : ['- (none)']),
      '',
    ]) : ['- none']),
    '',
    '### Handoff Discipline',
    ...(ctx.coordinationWarnings.length ? ctx.coordinationWarnings.map((w) => `- ${w}`) : ['- (none)']),
    '',
    'Agent handoff rule: 完成時要產生 summary/reminder/warning 俾下一個 agent，因為下一個 agent 未必有你嘅完整記憶。',
  ].filter((line) => line !== '');
  return truncate(lines.join('\n'), MISSION_TARGET_MAX_CHARS);
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
    if (agent.handoff === undefined) agent.handoff = null;
  });
  run.edges = Array.isArray(run.edges) ? run.edges : [];
  run.artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  run.contextHistory = Array.isArray(run.contextHistory) ? run.contextHistory : [];
  run.handoffs = Array.isArray(run.handoffs) ? run.handoffs : [];
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
  run.ownerUser = normalizeUserLabel(run.ownerUser || run.tgUser || (run.tgChatId ? `tg:${run.tgChatId}` : ''), 'owner');
  run.notifyUser = normalizeUserLabel(run.notifyUser || run.ownerUser, run.ownerUser || 'owner');
  run.createdFrom = normalizeUserLabel(run.createdFrom || run.source || 'dashboard', 'dashboard');
  ensureRunMissionContext(run);
  run.completionVerdict = run.completionVerdict || null;
  run.reviewVerdict = run.reviewVerdict || null;
  run.verifyVerdict = run.verifyVerdict || null;
  run.changeReports = Array.isArray(run.changeReports) ? run.changeReports : [];
  run.followups = Array.isArray(run.followups) ? run.followups : [];
  run.followupBaseBrief = run.followupBaseBrief || null;
  run.pipelineSeq = Number(run.pipelineSeq || 0);
  run.queueScope = run.queueScope || null;
  run.queueKey = run.queueKey || null;
  run.queuedReason = run.queuedReason || null;
  run.queuedBehindRunId = run.queuedBehindRunId || null;
  run.memoryPackStatus = run.memoryPackStatus || null;
  run.intentPackKey = run.intentPackKey || 'general';
  run.intentPackVersion = run.intentPackVersion || ((run.intentPackSnapshot && run.intentPackSnapshot.version) || 1);
  run.intentPackSnapshot = run.intentPackSnapshot || cloneIntentPack(INTENT_PACKS[run.intentPackKey] || INTENT_PACKS.general);
  run.intentPackSource = run.intentPackSource || 'auto';
  run.domainModuleKeys = normalizeDomainModuleKeys(run.domainModuleKeys || [], []);
  run.domainModuleSnapshots = Array.isArray(run.domainModuleSnapshots) ? run.domainModuleSnapshots : run.domainModuleKeys.map((key) => cloneDomainModule(DOMAIN_MODULES[key])).filter(Boolean);
  run.domainModuleSource = run.domainModuleSource || 'auto';
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
    handoff: extra.handoff || null,
  };
}

const DEFAULT_GLM_MODEL = process.env.SWARM_DEFAULT_GLM_MODEL || 'glm-4.5';
const SWARM_DISABLE_GLM = /^(1|true|yes|on)$/i.test(String(process.env.SWARM_DISABLE_GLM || ''));
const CODEX_55 = { cli: 'codex', model: 'gpt-5.5' };
const OPUS_48 = { cli: 'claude', model: 'opus' };

// ─── Model catalog (which CLI + model each sub-agent can run on) ───
const MODEL_CATALOG_ALL = [
  { cli: 'claude', model: 'opus',    label: 'Claude Opus 4.8', short: 'opus',   color: '#c8993f', tier: '旗艦 · 規劃腦' },
  { cli: 'claude', model: 'sonnet',  label: 'Claude Sonnet', short: 'sonnet', color: '#87b7ff', tier: '均衡 · 預設' },
  { cli: 'claude', model: 'haiku',   label: 'Claude Haiku',  short: 'haiku',  color: '#5fb89a', tier: '快 · 輕量' },
  { cli: 'codex',  model: 'gpt-5.5', label: 'Codex gpt-5.5', short: 'codex',  color: '#9aa7b2', tier: 'OpenAI' },
  { cli: 'glm',    model: 'glm-4.5', label: 'GLM 4.5',       short: 'glm',    color: '#b58cff', tier: '穩定 · 預設' },
  { cli: 'glm',    model: 'glm-4.5-air', label: 'GLM 4.5 Air', short: 'glm-air', color: '#8cc7ff', tier: '快 · 輕量' },
  { cli: 'glm',    model: 'glm-5.2', label: 'GLM 5.2',       short: 'glm-5.2', color: '#b58cff', tier: '實驗 · 高負載', experimental: true },
];
const MODEL_CATALOG = SWARM_DISABLE_GLM ? MODEL_CATALOG_ALL.filter((m) => m.cli !== 'glm') : MODEL_CATALOG_ALL;

function safeModelFlag(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  if (!/^[a-zA-Z0-9._:/-]{1,60}$/.test(m)) return '';
  return m;
}

function normalizeModelChoice(choice = {}, fallback = {}) {
  let cli = String(choice.cli || fallback.cli || '').trim().toLowerCase();
  let model = safeModelFlag(choice.model || fallback.model || '');
  if (model === 'claude-fable-5' || model === 'fable') {
    cli = 'claude';
    model = 'opus';
  }
  return { cli, model };
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

// Telegram user registry（bot 寫 data/tg-users.json：chatId → {username,name}）。
// console（dashboard）開議會時揀 username → resolve 返 chatId → run.tgChatId → 通知 route 返佢。
function readTgUsers() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tg-users.json'), 'utf8')) || {}; }
  catch (_) { return {}; }
}
function resolveTgChat(key) {
  if (!key) return null;
  const k = String(key).trim().toLowerCase().replace(/^@/, '');
  if (!k) return null;
  if (/^\d+$/.test(k)) return k; // 已經係 chatId
  const reg = readTgUsers();
  for (const id of Object.keys(reg)) {
    const u = reg[id] || {};
    if ((u.username && String(u.username).toLowerCase() === k) || (u.name && String(u.name).toLowerCase() === k)) return id;
  }
  return null;
}

function normalizeUserLabel(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/^@/, '').slice(0, 80);
}

function createRun({ topic, personas, chatContext, sessionId, projectPath, source, template, background, taskBrief, seed, tgChatId, tgUser, ownerUser, notifyUser, createdFrom, globalGoal, missionTarget, coordinationWarnings, intentPackKey, domainModuleKeys } = {}) {
  if (!tgChatId && tgUser) tgChatId = resolveTgChat(tgUser); // console 開:username → chatId
  const now = new Date().toISOString();
  const agents = Array.isArray(personas) && personas.length
    ? personas.map((persona, index) => makeAgent(String(persona), 'stakeholder', 'Persona', 'stakeholder reasoning', index + 1))
    : (seed === false ? [] : seedAgents(template || 'cloudcli', `${topic || ''}\n${chatContext || ''}`));
  const owner = normalizeUserLabel(ownerUser || tgUser || (tgChatId ? `tg:${tgChatId}` : ''), 'owner');
  const notify = normalizeUserLabel(notifyUser || tgUser || owner, owner);
  const resolvedProjectPath = projectPath ? safeProjectPath(projectPath) : DEFAULT_PROJECT_ROOT;
  const missionCtx = buildRunMissionContext({
    topic,
    taskBrief,
    projectPath: resolvedProjectPath,
    globalGoal,
    missionTarget,
    coordinationWarnings,
    intentPackKey,
    intentPackSource: intentPackKey ? 'user' : 'project-default',
    domainModuleKeys,
    domainModuleSource: domainModuleKeys !== undefined ? 'user' : undefined,
  });

  const run = {
    id: id('run'),
    version: 3,
    topic: topic || 'CloudCLI Session Swarm',
    source: source || 'manual',
    status: 'active',
    stage: agents.some((agent) => agent.layer === 'research') ? 'research' : 'stakeholder',
    sessionId: sessionId || null,
    projectPath: resolvedProjectPath,
    background: background || '',
    backgroundSource: background ? 'manual' : '',
    taskBrief: taskBrief || '',
    tgChatId: tgChatId || null, // 邊個 Telegram chat 開呢個 run → 通知 send 返佢度（唔係硬 send owner）
    ownerUser: owner,
    notifyUser: notify,
    createdFrom: normalizeUserLabel(createdFrom || source || 'dashboard', 'dashboard'),
    chatThread: [],
    chatModel: null,
    chatProjectPath: null,
    chatBusy: false,
    missionBrief: null,
    globalGoal: missionCtx.globalGoal,
    missionTarget: missionCtx.missionTarget,
    coordinationWarnings: missionCtx.coordinationWarnings,
    missionControlVersion: missionCtx.missionControlVersion,
    missionControlProjectPath: missionCtx.missionControlProjectPath,
    intentPackKey: missionCtx.intentPackKey,
    intentPackVersion: missionCtx.intentPackVersion,
    intentPackSnapshot: missionCtx.intentPackSnapshot,
    intentPackSource: missionCtx.intentPackSource,
    domainModuleKeys: missionCtx.domainModuleKeys,
    domainModuleSnapshots: missionCtx.domainModuleSnapshots,
    domainModuleSource: missionCtx.domainModuleSource,
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
    handoffs: [],
    sessionLinks: [],
    proposals: {},
    debates: [],
    synthesis: null,
    rebuttals: {},
    metrics: { layerCounts: layerCounts(agents), executionStarted: 0, executionCompleted: 0 },
    completionVerdict: null,
    reviewVerdict: null,
    verifyVerdict: null,
    changeReports: [],
    followups: [],
    followupBaseBrief: null,
    pipelineSeq: 0,
    queueScope: null,
    queueKey: null,
    queuedReason: null,
    queuedBehindRunId: null,
    memoryPackStatus: null,
  };

  if (missionCtx.intentPackFallbackWarning) {
    run.artifacts.unshift({
      id: id('artifact'),
      type: 'warning',
      title: 'Intent Pack fallback',
      content: missionCtx.intentPackFallbackWarning,
      agentId: null,
      createdAt: now,
    });
  }

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
    globalGoal: projectMissionControl(DEFAULT_PROJECT_ROOT).globalGoal,
    missionTarget: normalizeMissionTarget('', ''),
    coordinationWarnings: projectMissionControl(DEFAULT_PROJECT_ROOT).handoffGuidelines,
    missionControlVersion: projectMissionControl(DEFAULT_PROJECT_ROOT).version,
    missionControlProjectPath: projectMissionControl(DEFAULT_PROJECT_ROOT).projectPath,
    intentPackKey: projectMissionControl(DEFAULT_PROJECT_ROOT).defaultIntentPackKey,
    intentPackVersion: INTENT_PACKS[projectMissionControl(DEFAULT_PROJECT_ROOT).defaultIntentPackKey].version,
    intentPackSnapshot: cloneIntentPack(INTENT_PACKS[projectMissionControl(DEFAULT_PROJECT_ROOT).defaultIntentPackKey]),
    intentPackSource: 'project-default',
    domainModuleKeys: projectMissionControl(DEFAULT_PROJECT_ROOT).defaultDomainModuleKeys,
    domainModuleSnapshots: projectMissionControl(DEFAULT_PROJECT_ROOT).defaultDomainModuleKeys.map((key) => cloneDomainModule(DOMAIN_MODULES[key])).filter(Boolean),
    domainModuleSource: 'project-default',
    proposals: {},
    debates: [],
    synthesis: null,
    rebuttals: {},
    metrics: { layerCounts: layerCounts([]), executionStarted: 0, executionCompleted: 0 },
    ownerUser: 'owner',
    notifyUser: 'owner',
    createdFrom: 'dashboard',
    completionVerdict: null,
    reviewVerdict: null,
    verifyVerdict: null,
    changeReports: [],
    followups: [],
    followupBaseBrief: null,
    pipelineSeq: 0,
    queueScope: null,
    queueKey: null,
    queuedReason: null,
    queuedBehindRunId: null,
    memoryPackStatus: null,
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

const MEMORY_PACK_FILES = [
  'AGENTS.md',
  'PROJECT-MEMORY.md',
  'SESSION-LOG.md',
  'DECISIONS.md',
  'BUILD-PLAN.md',
  'README.md',
];
const MEMORY_FILE_MAX_CHARS = Number(process.env.SWARM_MEMORY_FILE_MAX_CHARS || 5000);
const MEMORY_PACK_MAX_CHARS = Number(process.env.SWARM_MEMORY_PACK_MAX_CHARS || 18000);

function buildMemoryPack(run) {
  let projectPath = DEFAULT_PROJECT_ROOT;
  try { projectPath = safeProjectPath((run && run.projectPath) || DEFAULT_PROJECT_ROOT); } catch (_) {}
  const included = [];
  const missing = [];
  const sections = [];
  for (const file of MEMORY_PACK_FILES) {
    const full = path.join(projectPath, file);
    if (!fs.existsSync(full)) { missing.push(file); continue; }
    try {
      const raw = fs.readFileSync(full, 'utf8');
      included.push(file);
      sections.push(`### ${file}\n${truncate(raw, MEMORY_FILE_MAX_CHARS)}`);
    } catch (_) {
      missing.push(file);
    }
  }
  const latestContext = run && Array.isArray(run.contextHistory) ? run.contextHistory[run.contextHistory.length - 1] : null;
  const ownerLine = `Owner: ${(run && run.ownerUser) || 'owner'} · Notify: ${(run && run.notifyUser) || (run && run.ownerUser) || 'owner'}`;
  const taskLine = `Task: ${truncate((run && (run.taskBrief || run.topic)) || '', 1200)}`;
  const contextLine = latestContext ? `Latest chat context (${latestContext.context.length} chars):\n${truncate(latestContext.context, 1800)}` : 'Latest chat context: none';
  const missionBlock = buildMissionContextBlock(run);
  const pack = (run && run.intentPackSnapshot) || cloneIntentPack(INTENT_PACKS.general);
  const modules = (run && run.domainModuleSnapshots) || [];
  const body = truncate([
    '## Hugo Intent Pack / Project Memory',
    ownerLine,
    taskLine,
    '',
    '## Active Product Scope Pack',
    intentPackPrompt(pack),
    '',
    '## Active Domain Modules',
    ...(modules.length ? modules.map(domainModulePrompt) : ['(none)']),
    '',
    missionBlock,
    '',
    '### Non-negotiable Operating Rules',
    '- Follow project AGENTS.md / memory files when present.',
    '- Preserve Hugo / owner intent; do not expand scope silently.',
    '- Product, safety, billing, data deletion, permission loosening, and one-way-door decisions must be escalated to Hugo / owner.',
    '- For code work, report exact files changed, tests run, and remaining risks.',
    '',
    contextLine,
    '',
    sections.length ? sections.join('\n\n') : '(No project memory files found.)',
  ].join('\n'), MEMORY_PACK_MAX_CHARS);
  const status = {
    included,
    missing,
    chars: body.length,
    projectPath,
    intentPack: {
      key: pack.key,
      label: pack.label,
      version: pack.version,
      source: (run && run.intentPackSource) || 'auto',
    },
    domainModules: modules.map((m) => ({
      key: m.key,
      label: m.label,
      version: m.version,
      source: (run && run.domainModuleSource) || 'auto',
    })),
    generatedAt: new Date().toISOString(),
  };
  if (run) run.memoryPackStatus = status;
  return { text: body, status };
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
  const normalized = normalizeModelChoice({ cli: cliName, model }, { cli: cliName, model });
  let m = safeModelFlag(normalized.model);
  let cli = String(normalized.cli || '').trim().toLowerCase();
  if (!cli) {
    // 冇明確 cli → 由 model 名推斷 provider,避免 claude+gpt-5.5 之類 cli/model 唔夾而炸
    // （verifier 等 fallback agent 攞到 build model 但 cli 跌返 claude default 嘅 bug）。
    if (/^gpt[-.]|^o[34]\b|codex/i.test(m)) cli = 'codex';
    else if (/^glm/i.test(m)) cli = 'glm';
    else cli = String(DEFAULT_AGENT_CLI || 'claude').trim().toLowerCase();
  }
  if (SWARM_DISABLE_GLM && (cli === 'glm' || /^glm/i.test(m))) {
    cli = 'codex';
    m = 'gpt-5.5';
  }
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
      model: m || DEFAULT_GLM_MODEL,
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
    return normalizeModelChoice(override, { cli: 'claude', model: 'sonnet' });
  }
  if (typeof override === 'string' && override) {
    const hit = MODEL_CATALOG.find((m) => m.model === override || m.short === override);
    if (hit) return { cli: hit.cli, model: hit.model };
  }
  if (run.chatModel && run.chatModel.model) return normalizeModelChoice(run.chatModel, { cli: 'claude', model: 'sonnet' });
  return { cli: 'claude', model: 'sonnet' };
}

function stripChatNoise(s) {
  return stripNonTtyShellNoise(String(s || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')        // ANSI escape
    .replace(/^\[swarm-[^\]]*\][^\n]*$/gm, ''));    // 自家 log 行
}

function isClaudeAuthFailure(text) {
  return /(?:401|invalid authentication credentials|failed to authenticate)/i.test(String(text || ''));
}

function claudeAuthFallbackModel() {
  return {
    cli: 'codex',
    model: process.env.SWARM_CLAUDE_AUTH_FALLBACK_MODEL || 'gpt-5.5',
  };
}

const CHAT_PROMPT_MAX_CHARS = 90000; // 控 argv $2 長度(Linux MAX_ARG_STRLEN ~128KB)
function buildChatPrompt(run, chatCwd, finalize) {
  const head = [
    '你係 Swarm Dashboard 嘅「策劃幕僚」,同用戶一對一傾偈,用繁體中文 / 廣東話。',
    '目標:透過多回合對話,幫用戶由模糊念頭收斂成一份清晰、可執行嘅 mission brief(之後交俾 AI 聯合國 Council 落地)。',
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
function spawnChatTurn(run, picked, chatCwd, finalize, fallbackUsed = false) {
  return new Promise((resolve, reject) => {
    const cmd = buildAgentCommand(picked.cli, picked.model);
    const prompt = buildChatPrompt(run, chatCwd, finalize);
    let cwd;
    try { cwd = chatCwd ? safeProjectPath(chatCwd) : safeProjectPath(SWARM_WORKSPACE); }
    catch (e) { return reject(new Error('cwd 無效: ' + e.message)); }
    io.emit('chat-thinking', { runId: run.id, on: true, model: picked.model, finalize: !!finalize });
    const started = Date.now();
    let out = '', err = '', killed = false;
    const child = spawn('bash', bashLoginArgs(cmd.shell, 'swarm-chat', cwd, prompt), {
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
      if (code !== 0) {
        const clean = stripChatNoise(err || out);
        if (!fallbackUsed && cmd.cli === 'claude' && envFlag('SWARM_CLAUDE_AUTH_FALLBACK', true) && isClaudeAuthFailure(clean)) {
          return spawnChatTurn(run, claudeAuthFallbackModel(), chatCwd, finalize, true).then(resolve, reject);
        }
        return reject(new Error(`${cmd.label} exit ${code}: ${clean.slice(-300)}`));
      }
      resolve({ text: stripChatNoise(out) || '(冇輸出)', durationMs, cli: picked.cli, model: picked.model });
    });
  });
}

// ─── Opus 完善 prompt（俾 Telegram bot：粗略請求 → 結構化 brief，過目後先落）───
const MISSION_REFINE_PROMPT = [
  '你係資深 tech lead,幫手完善開發任務嘅 brief。',
  '將用戶粗略嘅需求,整理成一份清晰、可以直接落手做嘅 implementation brief,包含：',
  '【背景與目標】、【範圍（明確要做 ＋ 明確唔做乜）】、【建議步驟】、【驗收清單】。',
  '【驗收清單】必須係可執行清單,每項一行:「☐ <驗收點> → 執行:`<真實 command 或 URL>` → 期望:<具體 output / 現象>」。',
  '指令要喺 project 入面真行得(curl / npm test / node script / 開邊個 URL 睇乜),唔准寫「應該正常運作」呢類冇得驗證嘅句子。',
  '保留用戶原意,補返佢可能漏咗嘅技術細節同 edge case;唔好擅自加佢冇要求嘅 feature 或者過度膨脹。',
].join('\n');
const COUNCIL_REFINE_PROMPT = [
  '你係資深顧問,幫手完善一個要交俾「AI 聯合國 Council」（可選快速 / 平衡 / 深度 9-grid）評審／討論嘅議題 brief。',
  '將用戶粗略嘅請求,整理成清晰嘅 review brief,包含：',
  '【要評審／討論乜】、【關注點同風險】、【評審準則】、【期望輸出】。',
  '保留用戶原意,唔好擴大範圍。',
].join('\n');

// One-shot model call: prompt → text（唔耦合 run / chatThread）。
function spawnOneShot(prompt, picked, label = 'swarm-oneshot', timeoutMs = 90000, opts = {}, fallbackUsed = false) {
  return new Promise((resolve, reject) => {
    const cmd = buildAgentCommand(picked.cli, picked.model);
    let cwd;
    try { cwd = opts.cwd ? safeProjectPath(opts.cwd) : safeProjectPath(SWARM_WORKSPACE); } catch (e) { return reject(e); }
    let out = '', err = '', killed = false;
    const child = spawn('bash', bashLoginArgs(cmd.shell, label, cwd, prompt), {
      cwd, env: { ...process.env, ...(opts.env || {}), TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGTERM'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('完善超時'));
      if (code !== 0) {
        const clean = stripChatNoise(err || out);
        if (!fallbackUsed && cmd.cli === 'claude' && envFlag('SWARM_CLAUDE_AUTH_FALLBACK', true) && isClaudeAuthFailure(clean)) {
          return spawnOneShot(prompt, claudeAuthFallbackModel(), `${label}-codex-fallback`, timeoutMs, opts, true).then(resolve, reject);
        }
        return reject(new Error(`${cmd.label} exit ${code}: ${clean.slice(-200)}`));
      }
      resolve(stripChatNoise(out) || '');
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
  let hadMergeFailure = false;
  for (const wt of session.worktrees) {
    try {
      worktreeMgr.commitWorktree({ dir: wt.dir, message: `swarm ${run.id} ${wt.key}` });
      const merge = worktreeMgr.mergeWorktree({ repo, branch: wt.branch, message: `swarm ${run.id}: merge ${wt.key}` });
      worktreeMgr.removeWorktree({ repo, dir: wt.dir, branch: merge.conflict ? null : wt.branch });
      if (!merge.ok && merge.conflict) {
        hadMergeFailure = true;
        addArtifact(run, {
          type: 'execution-error',
          title: `Worktree merge 撞 file: ${wt.key}`,
          content: `衝突檔案: ${(merge.conflictFiles || []).join(', ') || '(未知)'}\n已 abort merge（主 repo 保持乾淨）。${wt.key} 嘅改動留喺 branch \`${wt.branch}\`,可手動 merge。`,
        });
      }
    } catch (e) {
      hadMergeFailure = true;
      addArtifact(run, { type: 'execution-error', title: `Worktree 處理失敗: ${wt.key}`, content: e.message });
    }
  }
  session.worktreesMerged = true;
  if (hadMergeFailure) {
    session.status = 'failed';
    session.mergeConflict = true;
  }
}

// ─── Change reports:「改咗乜」由 server 自己 capture（唔靠 agent 自報）───
// After a code wave finishes (worktrees already merged back), diff the repo
// against the wave's baseline and persist a structured record on the run.
// Best-effort — never throws, never blocks the pipeline.
function captureSessionChanges(run, session) {
  try {
    if (!session || !session.gitRepo || !session.gitBaseline) return;
    const report = worktreeMgr.captureChanges({
      repo: session.gitRepo,
      baselineSha: session.gitBaseline,
      maxPatchBytes: SWARM_CHANGEREPORT_PATCH_MAX,
    });
    if (!report) return;
    if (!report.filesChanged.length) {
      if (report.error) console.warn('[change-report]', session.pipelineStageKey || session.id, report.error);
      return; // 冇改到嘢 → 唔嘈
    }
    run.changeReports = Array.isArray(run.changeReports) ? run.changeReports : [];
    const entry = {
      id: id('chg'),
      stageKey: session.pipelineStageKey || null,
      stageTitle: session.title || '',
      sessionId: session.id,
      followupSeq: (run.followups || []).length,
      ts: new Date().toISOString(),
      ...report,
    };
    run.changeReports.push(entry);
    // Caps: at most N reports; strip patches (keep stats) once the per-run patch budget blows.
    while (run.changeReports.length > SWARM_CHANGEREPORT_KEEP) run.changeReports.shift();
    let patchBudget = 0;
    for (let i = run.changeReports.length - 1; i >= 0; i -= 1) {
      const r = run.changeReports[i];
      patchBudget += Buffer.byteLength(r.patch || '', 'utf8');
      if (patchBudget > SWARM_CHANGEREPORT_PATCH_BUDGET && r.patch) { r.patch = ''; r.patchTruncated = true; }
    }
    addArtifact(run, {
      type: 'change-report',
      title: `📝 改咗乜 · ${entry.stageTitle || entry.stageKey || 'code wave'}`,
      content: [
        `${entry.filesChanged.length} 個 file（+${entry.totalAdds}/−${entry.totalDels}）${entry.filesOmitted ? `，另有 ${entry.filesOmitted} 個未列` : ''}`,
        summarizeChangeLines(entry, 12).join('\n'),
        entry.error ? `⚠ capture 部分失敗: ${entry.error}` : '',
        '',
        entry.diffStat,
      ].filter(Boolean).join('\n'),
    });
    io.emit('change-report', { runId: run.id, report: { ...entry, patch: undefined } });
    scheduleSave();
  } catch (e) {
    console.warn('[change-report]', e && e.message);
  }
}

// Per-file lines「M path +adds/−dels」— TG / artifact / prompt 通用。
function summarizeChangeLines(report, maxFiles = 8) {
  const files = (report && report.filesChanged) || [];
  const lines = files.slice(0, maxFiles).map((f) => {
    const counts = (f.adds != null || f.dels != null) ? ` +${f.adds || 0}/−${f.dels || 0}` : '';
    return `${f.status || 'M'} ${f.path}${counts}`;
  });
  const more = (files.length - lines.length) + ((report && report.filesOmitted) || 0);
  if (more > 0) lines.push(`…仲有 ${more} 個 file`);
  return lines;
}

// Compact cross-report text for LLM prompts（autoReview / next-steps / fixer / verifier）。
function summarizeChangeReportsText(run, budget = 2000) {
  const reports = (run && run.changeReports) || [];
  if (!reports.length) return '';
  const parts = reports.map((r) => [
    `[${r.stageTitle || r.stageKey || 'stage'}${r.followupSeq ? ` · 跟進#${r.followupSeq}` : ''}] ${(r.filesChanged || []).length} 個 file（+${r.totalAdds}/−${r.totalDels}）${r.error ? ` ⚠${r.error}` : ''}`,
    ...summarizeChangeLines(r, 10),
  ].join('\n'));
  let text = parts.join('\n');
  if (text.length > budget) text = `${text.slice(0, budget)}\n...[改動摘要 truncated]`;
  return text;
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
    captureSessionChanges(run, session);
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

function parseVerifyVerdict(run, session) {
  const agents = run.agents.filter((a) => a.sessionId === session.id);
  const verifier = agents.find((a) => /verif|驗證/i.test(`${a.name || ''}${a.role || ''}${a.layer || ''}`)) || agents[0];
  const logs = (verifier && verifier.logs) || '';
  const m = logs.match(/VERIFY\s*[:：]?\s*[`'"]?\s*(PASS|FAIL|BLOCKED)/i)
    || logs.match(/\*\*\s*Verify\s*\*\*\s*[:：]?\s*[`'"]?\s*(PASS|FAIL|BLOCKED)/i);
  return m ? m[1].toUpperCase() : 'BLOCKED';
}

function hasHumanEscalation(text) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/(^|\s)(ESCALATE|需要\s*Hugo\s*決定|需要人類|需要\s*owner)/i.test(lines[i])) continue;
    const block = [];
    for (let j = i; j < Math.min(lines.length, i + 18); j += 1) {
      if (j > i && (/^#{1,6}\s+/.test(lines[j]) || /^[A-Z_ ]{3,}\s*[:：]/.test(lines[j]))) break;
      block.push(lines[j]);
    }
    const items = block
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+\S/.test(line) || /ESCALATE\s*[:：]\s*\S|需要\s*(Hugo|owner|人類)|one-way-door|不可逆|安全取捨|付費|權限放寬|資料刪除/i.test(line));
    if (items.some((line) => !/\(?(none|無|沒有|nil|n\/a)\)?$/i.test(line.replace(/^[-*]\s+/, '').trim()))) return true;
  }
  return false;
}

// ─── Swarm Council parsers + plan IO ───
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

// 任務三:抽最新一 round Council review 重點 + 未解爭議 → 注入 code agent prompt
// （斷層:落 code 嘅 agent 本來完全唔知 reviewer concern,fix iteration 冇目標）。
function collectReviewFindings(run) {
  const dir = COUNCIL_DIR(run.id);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return ''; }
  const reviewRe = /^round-(\d+)(?:-[a-z0-9_-]+)?-reviewer-(\d+)\.md$/i;
  const reviews = files.map((f) => { const m = f.match(reviewRe); return m ? { f, round: Number(m[1]), rev: Number(m[2]) } : null; }).filter(Boolean);
  if (!reviews.length) return '';
  const maxRound = Math.max(...reviews.map((r) => r.round));
  const latest = reviews.filter((r) => r.round === maxRound).sort((a, b) => a.rev - b.rev);
  const parts = latest.map((r) => {
    let txt = ''; try { txt = fs.readFileSync(path.join(dir, r.f), 'utf8'); } catch (_) {}
    return `### 評審 ${r.rev}\n${truncate(txt, 800)}`;
  });
  let out = `\n\n---\n## ⚠️ Council review 重點（落 code 時必須兼顧 reviewer 嘅 concern）\n\n${parts.join('\n\n')}`;
  const disputes = (run.pipeline && run.pipeline.councilDisputes) || '';
  if (disputes && disputes.trim() && !/^\(?(none|無)\)?$/i.test(disputes.trim())) out += `\n\n## 仍未完全解決嘅爭議\n${truncate(disputes, 600)}`;
  return out;
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
    const anglesRaw = (logs.match(/RESEARCH_ANGLES\s*[:：]\s*\n([\s\S]*?)(?:\n\s*\n|\n```|\nRESEARCH_QUERY|\nCONSENSUS|\nPROPOSED_CHANGES|$)/i) || [, ''])[1];
    const angles = (anglesRaw || '').split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 6);
    const queryHint = ((logs.match(/RESEARCH_QUERY\s*[:：]\s*(.+)/i) || [, ''])[1] || '').trim();
    return {
      name: a.name, model: a.model || '',
      agree: /AGREE/i.test(verdict),
      failed: a.status === 'failed' || a.status === 'interrupted',
      issuesRaw: (issues || '').trim(), angles, queryHint, logs,
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

// ─── Swarm Council 收斂引擎 ───
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
    // ── 連續失敗追蹤：一個 model 連續 N round fail/缺席 → 踢走唔再 spawn（degrade 到在席者）──
    p.councilSeatFails = p.councilSeatFails || {};
    p.councilDroppedSeats = p.councilDroppedSeats || [];
    reviews.forEach((r) => {
      const seat = councilSeatKeyFromName(r.name);
      if (!seat) return;
      if (r.failed || !r.logs.trim()) p.councilSeatFails[seat] = (p.councilSeatFails[seat] || 0) + 1;
      else p.councilSeatFails[seat] = 0;                       // 成功有輸出就 reset
      if (p.councilSeatFails[seat] >= SWARM_COUNCIL_DROP_AFTER && !p.councilDroppedSeats.includes(seat)) {
        p.councilDroppedSeats.push(seat);
        addArtifact(run, { type: 'note', title: `🚫 踢走議會席位 ${seat}${r.model ? `（${r.model}）` : ''}`, content: `連續 ${SWARM_COUNCIL_DROP_AFTER} round 失敗/缺席,之後唔再 spawn,剩低嘅 model 繼續開會（全自動,唔使人手）。` });
      }
    });
    const plan = readLatestPlan(run);
    // 把每位評審完整輸出寫去 file → moderator 用 Read 讀全文(避免 taskBrief argv 上限截斷而丟失 reviewer)。
    const cdir = COUNCIL_DIR(run.id);
    const reviewFiles = [];
    try {
      fs.mkdirSync(cdir, { recursive: true });
      present.forEach((r, i) => {
        const fn = `round-${p.councilRound}-${stage.key || 'consensus'}-reviewer-${i + 1}.md`;
        fs.writeFileSync(path.join(cdir, fn), `# ${r.name}${r.model ? ` (${r.model})` : ''}\n\n${r.logs}`);
        reviewFiles.push({ name: r.name, model: r.model, path: path.join(cdir, fn) });
      });
    } catch (e) { console.warn('[council] write review files failed:', e.message); }
    p.councilReviewFiles = p.councilReviewFiles || {};
    const roundKey = String(p.councilRound);
    const existingFiles = Array.isArray(p.councilReviewFiles[roundKey]) ? p.councilReviewFiles[roundKey] : [];
    p.councilReviewFiles[roundKey] = existingFiles
      .filter((f) => !reviewFiles.some((nf) => nf.path === f.path))
      .concat(reviewFiles);
    const allRoundFiles = p.councilReviewFiles[roundKey] || reviewFiles;
    run.taskBrief = truncate(
      `## Goal\n${run.background || run.topic || ''}\n\n## 當前 Plan (v${plan.v})\n${plan.md}\n\n` +
      `## ${councilModeLabel(p.councilMode)} · Round ${p.councilRound} 完整輸出（已各自寫去 file）\n你**必須逐個用 Read tool 讀晒以下每個 file 全文先 merge**，唔好淨係靠下面摘要（摘要只係索引，會缺料）：\n` +
      allRoundFiles.map((f) => `- ${f.name}${f.model ? ` (${f.model})` : ''}: \`${f.path}\``).join('\n') +
      (present.length < reviews.length ? `\n(註:${reviews.length - present.length} 位評審缺席/失敗,照 merge 在席者)` : '') +
      `\n\n## 今個 stage 評審摘要（索引用，完整內容請 Read 上面 file）\n` +
      present.map((r) => `### ${r.name}${r.model ? ` (${r.model})` : ''}\n${truncate(r.logs, 1800)}`).join('\n\n'),
      MAX_CONTEXT_CHARS);
    // 第一輪指定 review gate 完 → 收集 council 提出嘅 research 角度（撳「開始拗」後集中查一次）→ 停低俾用戶睇
    if (stage.reviewGate !== false && p.councilRound === 1 && !p.councilDebateStarted) {
      const allAngles = [];
      let queryHint = '';
      const gateReviews = allRoundFiles.map((f) => {
        let logs = '';
        try { logs = fs.readFileSync(f.path, 'utf8'); } catch (_) {}
        const verdict = (logs.match(/CONSENSUS\s*[:：]\s*(AGREE|DISPUTE)/i) || [])[1] || 'DISPUTE';
        const anglesRaw = (logs.match(/RESEARCH_ANGLES\s*[:：]\s*\n([\s\S]*?)(?:\n\s*\n|\n```|\nRESEARCH_QUERY|\nCONSENSUS|\nPROPOSED_CHANGES|$)/i) || [, ''])[1];
        const angles = (anglesRaw || '').split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 6);
        const query = ((logs.match(/RESEARCH_QUERY\s*[:：]\s*(.+)/i) || [, ''])[1] || '').trim();
        return { name: f.name, model: f.model || '', agree: /AGREE/i.test(verdict), failed: false, logs, angles, queryHint: query };
      });
      (gateReviews.length ? gateReviews : present).forEach((r) => {
        (r.angles || []).forEach((a) => { if (a && !allAngles.includes(a)) allAngles.push(a); });
        if (!queryHint && r.queryHint) queryHint = r.queryHint;
      });
      p.pendingResearchAngles = allAngles.slice(0, COUNCIL_RESEARCH_MAX_ANGLES);
      p.pendingResearchQuery = queryHint || run.topic || '';
      pauseForReviewGate(run, p, gateReviews.length ? gateReviews : reviews);
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

  const minRounds = shouldAutoCouncilGate(run, p) ? SWARM_AUTO_COUNCIL_MIN_ROUNDS : SWARM_COUNCIL_MIN_ROUNDS;
  const reachedMin = p.councilRound >= minRounds;
  const trulyConverged = mod.converged && mod.openDisputes === 0;
  const converged = trulyConverged && reachedMin;          // 未夠 MIN round 唔准收工,逼佢再鑽深
  const maxedOut = p.councilRound >= SWARM_COUNCIL_MAX_ROUNDS;
  const overBudget = SWARM_COUNCIL_TIME_BUDGET_MS > 0 &&
    (Date.now() - new Date(p.startedAt).getTime()) > SWARM_COUNCIL_TIME_BUDGET_MS;
  if (converged) {
    pauseForHumanGate(run, p, { converged });
    return;
  }
  if (maxedOut || overBudget) {
    // 跑足都未收斂 → Opus 4.8 最終仲裁主動強制收斂（全自動,唔交人手等批准）
    runFinalArbiter(run, p, { maxedOut, overBudget }).catch((e) => {
      console.warn('[council] final arbiter threw:', e.message);
      try {
        addArtifact(run, { type: 'note', title: '⚠ 最終仲裁例外 → fallback 御准閘', content: e.message });
        pauseForHumanGate(run, p, { maxedOut, overBudget });
      } catch (_) {}
    });
    return;
  }

  // 未收斂(或表面收斂但未夠 MIN round)→ rewind consensus+moderator,round+1,再跑一 round
  const deepening = trulyConverged && !reachedMin;          // 表面收斂但要逼深度
  p.councilRound += 1;
  const cIdx = p.stages.findIndex((s) => s.kind === 'consensus');
  // 踢走連續失敗嘅 model：下一 round 唔再 spawn 佢（至少保留 1 席,通常 opus+codex 仍在）
  if ((p.councilDroppedSeats || []).length) {
    (p.stages || []).forEach((s) => {
      if (s.kind !== 'consensus' || !Array.isArray(s.agentKeys)) return;
      const keep = s.agentKeys.filter((k) => !p.councilDroppedSeats.includes(k));
      if (keep.length >= 1) s.agentKeys = keep;
    });
  }
  for (let i = cIdx; i < p.stages.length && ['consensus', 'moderator'].includes(p.stages[i].kind); i += 1) {
    p.stages[i].status = 'pending';
    p.stages[i].sessionId = null;
  }
  const plan = readLatestPlan(run);
  run.taskBrief = truncate(
    `## Goal\n${run.background || run.topic || ''}\n\n## 要評審嘅當前 Plan (v${plan.v})\n${plan.md}\n\n` +
    (deepening
      ? `## 深度紀律（Round ${p.councilRound}/${SWARM_COUNCIL_MAX_ROUNDS}，議會規定最少 ${minRounds} round）\n` +
        `Plan 表面上已收斂,但未到深度下限唔准收工。呢一 round **唔好複述同意**,要主動鑽深:\n` +
        `- 逐個 phase / 改動,用 Read+grep 揾返 project 入面**未覆蓋嘅 edge case、失敗模式、隱性依賴、向後兼容風險**。\n` +
        `- 至少提出 1 個「如果照而家 plan 做,邊度會出事」嘅具體情境 + 點改。\n` +
        `- 諗有冇**更穩陣 / 更簡單**嘅替代方案;如有,寫低 tradeoff。\n` +
        `- 真係搵唔到任何可改善,先至再 AGREE(並一句講你 check 過邊啲維度)。`
      : `## 上一 round 未解爭議(請優先處理 / 表態)\n${mod.disputes || '(none)'}`),
    MAX_CONTEXT_CHARS);
  p.current = cIdx - 1;
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
}

// 撳「開始拗」後：Council 角度合併 → 集中 call Perplexity 一次 → 結果做 artifact + Telegram 通知 + 派返議會，然後先入仲裁。
async function runCouncilResearch(run, p, angles, query) {
  addArtifact(run, { type: 'note', title: '🔍 議會上網 research 緊…', content: `查詢：${query}\n角度：\n${angles.map((a) => `- ${a}`).join('\n')}` });
  io.emit('run-updated', publicRun(run));
  tgNotify(`🔍 *議會上網 research 緊*\n${tgEsc(run.topic)}\n查：${tgEsc(query)}\n角度：${tgEsc(angles.join(' / '))}`, null, run && run.tgChatId);
  let research;
  try {
    research = await runResearch(query, angles, { runId: String(run.id), budget: PPLX_BUDGET, model: PPLX_MODEL, logDir: COUNCIL_DIR(run.id) });
  } catch (e) { research = { ok: false, error: e.message }; }
  if (research.ok) {
    run.councilResearch = { query, angles, text: research.text, citations: research.citations || [], usedAt: new Date().toISOString() };
    try { fs.writeFileSync(path.join(COUNCIL_DIR(run.id), 'research-1.md'), `# 議會 Research\n查詢：${query}\n角度：${angles.join(' / ')}\n\n${research.text}`); } catch (_) {}
    const tldr = (research.text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    addArtifact(run, {
      type: 'council-research',
      title: `🔍 議會 research 完成（${research.used}/${research.budget} · ~$${(research.estCost || 0).toFixed(3)}）`,
      content: `**查詢**：${query}\n**角度**：${angles.join(' / ')}\n\n${research.text}\n\n${(research.citations || []).slice(0, 8).map((c, i) => `[${i + 1}] ${c}`).join('\n')}`,
    });
    tgNotify(`✅ *research 完成*（${research.used}/${research.budget} · ~$${(research.estCost || 0).toFixed(3)}）\n${tgEsc(run.topic)}\n🔍 查咗：${tgEsc(query)}\n📋 ${tgEsc(tldr.slice(0, 200))}`, null, run && run.tgChatId);
  } else {
    addArtifact(run, { type: 'note', title: '⚠ 議會 research 未成事', content: research.capped ? `已用滿 ${research.used}/${research.budget} 次` : `失敗：${research.error || ''}` });
    tgNotify(`⚠ research ${research.capped ? '已達上限' : '失敗'}：${tgEsc(research.error || '')}\n照樣開拗。`, null, run && run.tgChatId);
  }
  p.stopped = false;
  io.emit('run-updated', publicRun(run));
  scheduleSave();
  advancePipeline(run);
}

// 最終仲裁 (Opus 4.8)：議會跑足都未完全收斂 → 主動一鎚定音強制收斂,全自動唔交人手等批准。
async function runFinalArbiter(run, p, why) {
  const plan = readLatestPlan(run);
  const cdir = COUNCIL_DIR(run.id);
  let reviewerBlock = '';
  try {
    const re = new RegExp(`^round-${p.councilRound}(?:-[a-z0-9_-]+)?-reviewer-\\d+\\.md$`, 'i');
    reviewerBlock = fs.readdirSync(cdir).filter((f) => re.test(f))
      .map((f) => `### ${f}\n${truncate(fs.readFileSync(path.join(cdir, f), 'utf8'), 2500)}`).join('\n\n');
  } catch (_) {}
  const prompt = [
    COUNCIL_ARBITER_SCOPE,
    `## Goal\n${run.background || run.topic || ''}`,
    `## 議會跑足 ${p.councilRound} round 後最新 plan (v${plan.v})\n${plan.md}`,
    `## 仲未解嘅技術爭議 / 要拍板嘅 ESCALATE\n${p.councilDisputes || '(見 plan 內 ESCALATE / DISPUTES 段)'}`,
    reviewerBlock ? `## 最後一 round Council review\n${reviewerBlock}` : '',
  ].filter(Boolean).join('\n\n');
  addArtifact(run, { type: 'note', title: `⚖️ 最終仲裁 (Opus 4.8) — 議會 ${p.councilRound} round 未完全收斂`, content: 'Opus 4.8 主動逐條拍板 → 強制收斂 → 直接落 code,全自動唔交人手。' });
  io.emit('run-updated', publicRun(run));
  const raw = await spawnOneShot(
    prompt, { cli: 'claude', model: 'opus' }, 'swarm-arbiter', 420000,
    { cwd: run.projectPath, env: { MAX_THINKING_TOKENS: process.env.SWARM_COUNCIL_THINKING || '31999' } },
  );
  const finalMd = (raw.match(/```plan-final\s*\n([\s\S]*?)\n```/) || [, ''])[1].trim();
  const nextV = (readLatestPlan(run).v || 0) + 1;
  if (finalMd) { writeCouncilPlan(run, nextV, finalMd); p.councilPlanVersion = nextV; }
  const humanEscalation = hasHumanEscalation(finalMd || raw || p.councilDisputes || '');
  p.councilOpenDisputes = 0;
  p.councilArbitrated = true;
  p.councilRequiresHumanDecision = humanEscalation;
  p.councilDisputes = humanEscalation
    ? `(Opus 4.8 已仲裁技術爭議；仍有 ESCALATE 需要 Hugo / owner 拍板 → plan v${p.councilPlanVersion})`
    : `(Opus 4.8 已仲裁技術爭議 → plan v${p.councilPlanVersion})`;
  addArtifact(run, {
    type: humanEscalation ? 'council-gate' : 'note',
    title: humanEscalation ? `⏸ 技術仲裁完成，但仍需 Hugo 決定 → plan v${p.councilPlanVersion}` : `✅ 技術仲裁完成 → plan v${p.councilPlanVersion} 收斂`,
    content: truncate(raw, 1800),
  });
  pauseForHumanGate(run, p, { converged: true, arbitrated: true });
}

// Phase 3 御准閘:收斂(或用盡 round)後停低,唔自動 advance,等用戶撳批准 / 再改。
function pauseForHumanGate(run, p, why) {
  p.stopped = true;
  p.councilPaused = true;
  const plan = readLatestPlan(run);
  const reason = why.arbitrated ? 'Opus 4.8 最終仲裁收斂'
    : why.converged ? 'Council 零爭議收斂'
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
  if (shouldAutoCouncilGate(run, p)) {
    addArtifact(run, { type: 'note', title: '🤖 Overnight review 自動通過報告閘', content: '此 run 由 codex-overnight-setup 建立，只自動生成最終報告，不會自動落 code / execute。' });
    setImmediate(() => continueCouncilApproval(run, p, { auto: true }));
  } else {
    notifyCouncilGate(run, p, reason);
  }
}

function shouldAutoCouncilGate(run, p) {
  if (!run || !p) return false;
  if (/^(1|true|yes|on)$/i.test(String(process.env.SWARM_AUTO_COUNCIL_GATES || ''))) return true;
  return run.createdFrom === 'codex-overnight-setup' || run.autoCouncilGates === true;
}

function continueCouncilApproval(run, p, options = {}) {
  if (!p || !p.councilPaused) return { ok: false, error: '冇 council 御准閘可批准' };
  const idx = p.stages.findIndex((s) => s.kind === 'explainer');
  if (idx < 0) return { ok: false, error: '冇 explainer stage' };
  const plan = readLatestPlan(run);
  run.taskBrief = truncate(`## 已批准嘅終稿 Plan (v${plan.v})\n\n${plan.md}`, MAX_CONTEXT_CHARS);
  p.councilPaused = false;
  p.stopped = false;
  p.stages[idx].status = 'pending';
  p.stages[idx].sessionId = null;
  p.current = idx - 1;
  run.status = 'executing';
  addArtifact(run, { type: 'note', title: options.auto ? `🤖 自動批准 plan v${plan.v} → 生成人話講解` : `✅ 已批准 plan v${plan.v} → 生成人話講解`, content: '' });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  advancePipeline(run);
  return { ok: true, approvedVersion: plan.v };
}

// Review 閘:第一輪 Council review(每個自己掃 project + plan)完,停低俾用戶睇齊,
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
    title: `🔎 ${councilModeLabel(p.councilMode)} review（${reviews.length} 份）— 撳「開始拗」入辯論`,
    content: `# ${councilModeLabel(p.councilMode)} review\nCouncil agent 已各自掃過 project + plan,以下係獨立評審。睇完撳「🥊 開始拗」,佢哋就會互相挑戰、收斂改 plan；如多 round 未收斂,final arbiter 會保留技術仲裁。\n\n${body}`,
  });
  run.status = 'active';
  io.emit('run-updated', publicRun(run));
  io.emit('council-review-paused', { runId: run.id, reviewCount: reviews.length });
  scheduleSave();
  if (shouldAutoCouncilGate(run, p)) {
    addArtifact(run, { type: 'note', title: '🤖 Overnight review 自動開始拗', content: '6-review 已完成，系統會自動進入 moderator 收斂，避免排隊 mission 停住。' });
    setImmediate(() => continueCouncilDebate(run, p, { auto: true }));
  } else {
    notifyCouncilReviewGate(run, reviews);
  }
}

function continueCouncilDebate(run, p, options = {}) {
  if (!p || !p.councilReviewPaused) return { ok: false, error: '冇 review 閘可開拗' };
  p.councilReviewPaused = false;
  p.councilDebateStarted = true;
  p.stopped = false;
  run.status = 'executing';
  const angles = (p.pendingResearchAngles || []).filter(Boolean);
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  if (angles.length) {
    runCouncilResearch(run, p, angles, p.pendingResearchQuery || run.topic || '').catch((e) => {
      console.warn('[council] research threw:', e.message);
      try { addArtifact(run, { type: 'note', title: '⚠ research 例外', content: e.message }); advancePipeline(run); } catch (_) {}
    });
  } else {
    addArtifact(run, {
      type: 'note',
      title: options.auto ? '🤖 自動開始辯論 → moderator 收斂' : '🥊 開始辯論 → moderator 收斂',
      content: 'Council review 完，冇提出要 research，直接開拗。',
    });
    advancePipeline(run);
  }
  return { ok: true, research: angles.length > 0 };
}

function maybeAdvancePipeline(run, session) {
  const p = run.pipeline;
  if (!p || p.stopped || !Array.isArray(p.stages) || !p.stages[p.current]) return;
  const stage = p.stages[p.current];
  if (stage.sessionId !== session.id) return;
  stage.status = session.status;
  if (stage.key === 'verify') {
    const verify = session.status === 'failed' ? 'FAIL' : parseVerifyVerdict(run, session);
    p.verifyVerdict = verify;
    p.verifyGateDone = verify === 'PASS';
    stage.verdict = verify;
    run.verifyVerdict = verify;
    if (verify !== 'PASS') {
      stage.status = 'failed';
      p.stopped = true;
      run.status = 'needs_attention';
      run.completionVerdict = `VERIFY_${verify}`;
      run.completedAt = new Date().toISOString();
      addArtifact(run, {
        type: 'execution-error',
        title: `🧪 Verify Gate: ${verify}`,
        content: 'Verifier 未能證明全部驗收通過。Pipeline 暫停，請睇「下一步」或重跑 / 修正。',
      });
      if (process.env.SWARM_NEXTSTEPS !== '0') { try { generateNextSteps(run); } catch (_) {} }
      io.emit('run-updated', publicRun(run));
      scheduleSave();
      pumpRunQueue(run.projectPath);
      return;
    }
  }
  if (session.status === 'failed' && !p.continueOnFail) {
    p.stopped = true;
    addArtifact(run, { type: 'execution-error', title: `Pipeline 喺「${stage.title}」中止`, content: '呢個 stage 有 agent 失敗,pipeline 已停。可重跑該 agent 或手動續行。' });
    run.status = 'needs_attention';
    run.completionVerdict = `STAGE_FAILED:${stage.key || stage.title}`;
    run.completedAt = new Date().toISOString();
    io.emit('run-updated', publicRun(run));
    scheduleSave();
    pumpRunQueue(run.projectPath);
    return;
  }

  // ── Swarm Council consensus loop:consensus → moderator → 收斂/rewind/pause ──
  if (p.mode === 'council' && (stage.kind === 'consensus' || stage.kind === 'moderator')) {
    advanceCouncil(run, p, stage, session);
    return;
  }

  // ── Plan decompose: planner output → dynamic build waves spliced after plan ──
  if (SWARM_PLAN_DECOMPOSE && stage.decompose && !stage.decomposed) {
    stage.decomposed = true;
    const fixedBuild = { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: buildAgentKeys(run.taskBrief || ''), status: 'pending', sessionId: null };
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
      p.reviewVerdict = verdict;
      stage.verdict = verdict;
      run.reviewVerdict = verdict;
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

// ─── Council research prompts（reviewer 提角度 → 集中 call → 結果派返）───
const COUNCIL_RESEARCH_ANGLES_PROMPT = [
  '',
  '## 上網 research（淨係有需要先用）',
  '如果你認為議會要查證某啲**最新／外部事實**先評得準（例如新科目或考卷嘅結構、課程大綱、評核準則、政策，或你 training 之後先有嘅嘢），',
  '請喺你輸出**最後**加呢個 block：',
  'RESEARCH_QUERY: <一句核心要查嘅問題>',
  'RESEARCH_ANGLES:',
  '- <想覆蓋嘅角度 1>',
  '- <想覆蓋嘅角度 2>',
  'Council reviewer 嘅角度會合併，撳「開始拗」後集中上網查一次，結果喺辯論時派返大家。',
  '**唔需要查證就唔好加呢個 block**（慳資源）。',
].join('\n');

function councilResearchBlock(research) {
  if (!research || !research.text) return '';
  return [
    '',
    '## 議會上網 research 結果（供評審 / 辯論參考）',
    `查詢：${research.query || ''}`,
    (research.angles && research.angles.length) ? `角度：${research.angles.join(' / ')}` : '',
    '',
    truncate(research.text, 6000),
    (research.citations && research.citations.length) ? `\n來源：\n${research.citations.slice(0, 10).join('\n')}` : '',
    '↑ 呢啲係議會夾出角度後上網查返嘅資料，參考之餘要自己判斷可信度。',
  ].filter(Boolean).join('\n');
}

function isCouncilReviewerKey(key) {
  return String(key || '').startsWith('council_');
}

function isCouncilPresetKey(key) {
  const k = String(key || '');
  return isCouncilReviewerKey(k) || k === 'moderator' || k === 'explainer';
}

function councilSeatKeyFromName(name) {
  const value = String(name || '').toLowerCase();
  if (/council\s*a\b/.test(value)) return 'council_a';
  if (/council\s*b\b/.test(value)) return 'council_b';
  if (/council\s*c\b/.test(value)) return 'council_c';
  const model = /opus/.test(value) ? 'opus' : /codex/.test(value) ? 'codex' : /glm/.test(value) ? 'glm' : '';
  const role = /free/.test(value) ? 'free' : /architecture|arch\b/.test(value) ? 'arch' : /implementation|impl\b/.test(value) ? 'impl' : /risk/.test(value) ? 'risk' : '';
  return model && role ? `council_${model}_${role}` : null;
}

function parseListBlock(text, label) {
  const re = new RegExp(`${label}:?\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_ ]{6,}:|\\n##|$)`, 'i');
  const m = String(text || '').match(re);
  if (!m) return [];
  return m[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => truncate(line, 320));
}

function extractHandoffFromLogs(logs, fallbackSummary = '') {
  const text = String(logs || '');
  const summaryMatch = text.match(/HANDOFF_SUMMARY:\s*([\s\S]*?)(?=\nHANDOFF_REMINDERS?:|\nHANDOFF_WARNINGS?:|\n##|$)/i);
  const summary = truncate((summaryMatch && summaryMatch[1].trim()) || fallbackSummary || text.split(/\r?\n/).filter(Boolean).slice(-8).join(' '), 520);
  return {
    summary: summary || 'Agent 已完成；未提供詳細 summary。',
    reminders: parseListBlock(text, 'HANDOFF_REMINDERS?'),
    warnings: parseListBlock(text, 'HANDOFF_WARNINGS?'),
  };
}

function recordAgentHandoff(run, agent, preset, code) {
  const parsed = extractHandoffFromLogs(agent.logs, agent.summary);
  const warnings = [...parsed.warnings];
  if (code !== 0 && agent.summary) warnings.unshift(agent.summary);
  const handoff = {
    id: id('handoff'),
    runId: run.id,
    agentId: agent.id,
    agentName: agent.name,
    stage: preset && (preset.key || preset.layer || preset.name),
    summary: parsed.summary,
    reminders: parsed.reminders.slice(0, 5),
    warnings: warnings.map((w) => truncate(w, 320)).filter(Boolean).slice(0, 5),
    status: agent.status,
    createdAt: new Date().toISOString(),
  };
  agent.handoff = handoff;
  run.handoffs = Array.isArray(run.handoffs) ? run.handoffs : [];
  run.handoffs.unshift(handoff);
  run.handoffs = run.handoffs.slice(0, 80);
  return handoff;
}

function buildHandoffContext(run, agent) {
  const handoffs = (run.handoffs || [])
    .filter((h) => h && h.agentId !== (agent && agent.id))
    .slice(0, 8);
  if (!handoffs.length) return '## Previous Agent Handoffs\nNone yet.';
  return [
    '## Previous Agent Handoffs',
    '下一個 agent 未必有上一個 agent 嘅完整記憶；以下係最近交棒 summary/reminder/warning，請優先讀。',
    ...handoffs.map((h, idx) => [
      `### Handoff ${idx + 1}: ${h.agentName || h.agentId} · ${h.status || ''}`,
      `Summary: ${h.summary || '-'}`,
      (h.reminders && h.reminders.length) ? `Reminders:\n${h.reminders.map((x) => `- ${x}`).join('\n')}` : '',
      (h.warnings && h.warnings.length) ? `Warnings:\n${h.warnings.map((x) => `- ${x}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n\n');
}

// Verifier 專用 context：server 記錄嘅實際改動 + 驗收清單鐵則。改動先有得驗,
// 冇驗收 cover 嘅改動 = 未驗 — 呢個 block 令 verifier 對住真 diff 做嘢。
function buildVerifierContext(run) {
  const changesTxt = summarizeChangeReportsText(run, 3000);
  if (!changesTxt) return '';
  return [
    '',
    '## Verifier 專用:今次實際改動 + 驗收清單',
    '以下係 server 記錄嘅今次 mission git 改動(唔係 agent 自報)。你嘅驗收必須覆蓋呢啲檔案嘅行為:',
    changesTxt,
    '',
    '驗收清單喺 task brief 嘅【驗收清單】/【驗收標準】section。鐵則:',
    '- 逐條搵返對應指令**真係執行**,貼原始 output 做證據;唔准靠讀 code 推斷「應該得」。',
    '- 有改動嘅 file 冇任何驗收 cover 到 → 報告寫明「未覆蓋:<file>」,並將裁決降做 VERIFY: FAIL 或 BLOCKED。',
  ].join('\n');
}

// Fixer / followup agent context：之前 stage 實際改咗乜,對準範圍、避免重做或 revert。
function buildChangeReportBlock(run) {
  const changesTxt = summarizeChangeReportsText(run, 2000);
  if (!changesTxt) return '';
  return [
    '',
    '## 之前改咗乜(Change Reports,server git 記錄)',
    '以下係之前 stage / 輪次嘅實際改動摘要,幫你對準範圍;唔好重做已完成嘅部分,唔好 revert 其他 agent 嘅改動:',
    changesTxt,
  ].join('\n');
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
  const isCouncilReviewer = isCouncilReviewerKey(preset.key);
  const isCouncilWorker = isCouncilPresetKey(preset.key);
  const background = run.background || buildAutoBackground(run);
  const taskBrief = run.taskBrief || options.taskBrief || '';
  const memoryPack = buildMemoryPack(run);
  const handoffBlock = buildHandoffContext(run, agent);
  const skillKeys = skillKeysForPreset(preset.key);
  const plan = run.pipeline && ['council', 'code'].includes(run.pipeline.mode) ? readLatestPlan(run) : { v: 0, md: '' };
  agent.skillKeys = skillKeys;
  agent.contextSources = {
    memoryPack: memoryPack.status,
    mission: {
      globalGoalChars: (run.globalGoal || '').length,
      missionTarget: missionTargetSummary(run.missionTarget),
      warningsCount: (run.coordinationWarnings || []).length,
      missionControlVersion: run.missionControlVersion || 0,
    },
    intentPack: {
      key: run.intentPackKey || 'general',
      label: (run.intentPackSnapshot && run.intentPackSnapshot.label) || 'General',
      version: run.intentPackVersion || 1,
      source: run.intentPackSource || 'auto',
    },
    domainModules: ((run.domainModuleSnapshots || []).map((m) => ({
      key: m.key,
      label: m.label,
      version: m.version,
      source: run.domainModuleSource || 'auto',
    }))),
    handoffsPassed: (run.handoffs || []).slice(0, 8).map((h) => ({ agentName: h.agentName, status: h.status, createdAt: h.createdAt })),
    chatContextCount: run.contextHistory.length,
    artifactsPassed: run.artifacts.slice(0, 5).map((artifact) => ({ title: artifact.title, type: artifact.type })),
    planVersion: plan.v || 0,
  };
  agent.inputPlanVersion = plan.v || 0;

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
    '- 回報最後必須加 Agent Handoff block，交棒俾下一個 agent：',
    '  HANDOFF_SUMMARY: <你啱啱做咗乜 / 改咗乜 / 查到乜，3-5 句內>',
    '  HANDOFF_REMINDERS:',
    '  - <下一個 agent 要記住嘅背景 / 假設 / 依賴>',
    '  HANDOFF_WARNINGS:',
    '  - <下一個 agent 要避免或特別小心嘅風險；冇就寫 none>',
    '',
    `Swarm Run: ${run.id}`,
    `Topic: ${run.topic}`,
    `Project Path: ${run.projectPath}`,
    '',
    '## Background',
    background,
    '',
    memoryPack.text,
    '',
    handoffBlock,
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
    ...(preset.key === 'verifier' ? [buildVerifierContext(run)] : []),
    ...(preset.key === 'fixer' || String(preset.key || '').startsWith('followup') ? [buildChangeReportBlock(run)] : []),
    ...(preset.key === 'planner' ? [PLANNER_DECOMPOSE_PROMPT] : []),
    ...(isCouncilReviewer && run.pipeline && !run.pipeline.councilDebateStarted
      ? [COUNCIL_RESEARCH_ANGLES_PROMPT] : []),
    ...(isCouncilWorker && run.councilResearch
      ? [councilResearchBlock(run.councilResearch)] : []),
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
  const isCouncilAgent = isCouncilPresetKey(preset.key);
  const useProjectCwd = !isThinkingAgent || isCouncilAgent;
  // Create this agent's isolated worktree (parallel code waves only). On failure,
  // fail fast rather than falling back to the shared repo; shared repo fallback is
  // exactly the race this queue/worktree mode is designed to prevent.
  if (options.worktree && !fake) {
    try {
      worktreeMgr.createWorktree({
        repo: safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT),
        baseCommit: options.worktree.base,
        branch: options.worktree.branch,
        dir: options.worktree.dir,
      });
    } catch (e) {
      appendAgentLog(run, agent, `[swarm-server] worktree 建立失敗,為避免共享 repo 撞 code,本 agent fail-fast: ${e.message}\n`);
      addArtifact(run, { type: 'execution-error', title: `Worktree 建立失敗: ${preset.name}`, content: e.message, agentId: agent.id });
      throw e;
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
  // Codex: default medium → high effort;Claude/Opus + GLM: 開 extended thinking。
  // GLM(council_c) 經 BigModel anthropic-compat、行 claude 二進制,一樣食 MAX_THINKING_TOKENS
  // (Hugo 2026-06-06 授權埋 GLM 都調大;smoke 證 BigModel 收個 env 唔會炸,會多燒少少 credit)。
  // 全部可由 env 覆寫:SWARM_COUNCIL_CODEX_EFFORT / SWARM_COUNCIL_THINKING。
  const councilEnv = {};
  if (isCouncilAgent && !fake) {
    if (agentCommand.cli === 'codex') {
      const effort = process.env.SWARM_COUNCIL_CODEX_EFFORT || 'high';
      shell = shell.replace('codex exec', `codex exec -c model_reasoning_effort="${effort}"`);
      appendAgentLog(run, agent, `[swarm-server] Council Codex reasoning_effort=${effort}\n`);
    } else {
      // claude / opus / sonnet / glm 都行 claude 二進制 → 食 MAX_THINKING_TOKENS
      councilEnv.MAX_THINKING_TOKENS = process.env.SWARM_COUNCIL_THINKING || '31999';
      appendAgentLog(run, agent, `[swarm-server] Council ${agentCommand.cli} MAX_THINKING_TOKENS=${councilEnv.MAX_THINKING_TOKENS}\n`);
    }
  }
  // ─── GLM thinking（非議會角色都開）───（Hugo 2026-06-17）
  // economy/budget preset 用穩定 GLM 做 researcher 等角色 → 一樣行 claude 二進制,開 extended thinking。
  // glm-4.5-air / glm-mini 係特登平快嘅 tier,唔開（開咗就違背慳 cost 原意）。可由 SWARM_GLM_THINKING 調。
  if (!fake && agentCommand.cli === 'glm' && !isCouncilAgent && !/air|mini/i.test(String(agentCommand.model || ''))) {
    councilEnv.MAX_THINKING_TOKENS = process.env.SWARM_GLM_THINKING || process.env.SWARM_COUNCIL_THINKING || '31999';
    appendAgentLog(run, agent, `[swarm-server] GLM(${agentCommand.model}) non-council MAX_THINKING_TOKENS=${councilEnv.MAX_THINKING_TOKENS}\n`);
  }
  const child = spawn(
    'bash',
    bashLoginArgs(shell, 'swarm-agent', projectPath, prompt),
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
    notifyAgentFailed(run, agent, preset);
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
    const handoff = recordAgentHandoff(run, agent, preset, code);
    addArtifact(run, {
      type: 'agent-handoff',
      title: `📨 ${preset.name} 交棒`,
      content: [
        `Summary: ${handoff.summary}`,
        handoff.reminders.length ? `\nReminders:\n${handoff.reminders.map((x) => `- ${x}`).join('\n')}` : '',
        handoff.warnings.length ? `\nWarnings:\n${handoff.warnings.map((x) => `- ${x}`).join('\n')}` : '',
      ].filter(Boolean).join('\n'),
      agentId: agent.id,
    });
    if (agent.status === 'completed') notifyAgentHandoff(run, agent, handoff);
    if (agent.status === 'failed') notifyAgentFailed(run, agent, preset);
    updateSessionStatus(run, agent.sessionId);
    if (!run.pipeline && !run.agents.some((item) => ['delivery', 'review'].includes(item.layer) && item.status === 'running')) {
      run.status = run.synthesis ? 'complete' : 'active';
      if (run.status === 'complete') notifyRunComplete(run, 'synthesis');
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
  const useWorktree = SWARM_WORKTREE && process.env.SWARM_FAKE_AGENT !== '1' && isCodeWave && presets.length > 1;
  // Change-report baseline: remember where HEAD was when this code wave started,
  // so captureSessionChanges can diff exactly what the wave changed (commits +
  // working tree). Non-repo / bad path → no baseline → capture no-ops.
  if (isCodeWave && process.env.SWARM_FAKE_AGENT !== '1') {
    try {
      const repo = safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT);
      const sha = worktreeMgr.headSha(repo);
      if (sha) { session.gitRepo = repo; session.gitBaseline = sha; }
    } catch (_) { /* not capturable */ }
  }
  let waveBase = null;
  if (useWorktree) {
    waveBase = session.gitBaseline || worktreeMgr.headSha(safeProjectPath(run.projectPath || DEFAULT_PROJECT_ROOT));
    session.worktrees = [];
  }
  const agents = presets.map((p) => {
    const picked = normalizeModelChoice(per[p.key] || {}, { cli: opts.cli, model: opts.model });
    const agentOpts = {
      deliveryMode: mode,
      session,
      model: picked.model,
      cli: picked.cli,
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

// Build roster is task-aware: core FE/BE/Test always; the DB/Migration agent is
// added only when the task touches schema/migrations. Verify always runs last as a
// final evidence stage (run acceptance commands, paste real output — no gate loop).
const DB_TASK_SIGNAL = /(migration|schema|supabase|\bRLS\b|\bDDL\b|create table|alter table|seed|storage|bucket|auth|policy|policies|index|constraint|foreign key|遷移|資料表|資料庫|權限政策|儲存桶|種子資料)/i;
function buildAgentKeys(taskBrief = '') {
  const keys = ['frontend', 'backend', 'test'];
  if (DB_TASK_SIGNAL.test(String(taskBrief || ''))) keys.push('database');
  return keys;
}
function verifyStage() {
  return { key: 'verify', title: '實測驗證 Verify', kind: 'code', deliveryMode: 'code', agentKeys: ['verifier'] };
}

function normalizeCouncilMode(value) {
  const raw = String(value || 'balanced').trim().toLowerCase();
  if (['balanced', 'balance', 'standard-plus', 'medium'].includes(raw)) return 'balanced';
  if (['deep-6', 'six-review', '6-review', '6review', 'opus-codex-6', 'gpt-opus-6'].includes(raw)) return 'deep-6';
  if (['deep', 'deep-grid', 'grid', '9-grid', 'nine-grid', '9grid'].includes(raw)) return 'deep-grid';
  return 'quick';
}

function councilModeLabel(mode) {
  const m = normalizeCouncilMode(mode);
  if (m === 'balanced') return '平衡 Council（3自由觀點 + 3硬角色）';
  if (m === 'deep-6') return '深度 6-review Council（Opus + GPT × 3角色）';
  if (m === 'deep-grid') return '深度 9-grid Council（3 model × 3角色）';
  return '快速 Council（3硬角色）';
}

function councilStagesForMode(mode) {
  const m = normalizeCouncilMode(mode);
  const moderate = { key: 'moderate', title: '仲裁收斂 Moderate', kind: 'moderator', deliveryMode: 'thinking', agentKeys: ['moderator'] };
  const explain = { key: 'explain', title: '人話講解 Explain', kind: 'explainer', deliveryMode: 'thinking', agentKeys: ['explainer'] };
  if (m === 'balanced') {
    return [
      { key: 'perspectives', title: '3 model 自由觀點 Free Views', kind: 'consensus', deliveryMode: 'thinking', agentKeys: ['council_opus_free', 'council_codex_free', 'council_glm_free'], reviewGate: false },
      { key: 'consensus', title: '硬角色評審 Role Reviews', kind: 'consensus', deliveryMode: 'thinking', agentKeys: ['council_a', 'council_b', 'council_c'], reviewGate: true },
      moderate,
      explain,
    ];
  }
  if (m === 'deep-grid') {
    return [
      {
        key: 'grid',
        title: '9-grid 深度評審',
        kind: 'consensus',
        deliveryMode: 'thinking',
        agentKeys: [
          'council_opus_arch', 'council_codex_arch', 'council_glm_arch',
          'council_opus_impl', 'council_codex_impl', 'council_glm_impl',
          'council_opus_risk', 'council_codex_risk', 'council_glm_risk',
        ],
        reviewGate: true,
      },
      moderate,
      explain,
    ];
  }
  if (m === 'deep-6') {
    return [
      {
        key: 'six_review',
        title: '6-review 深度評審',
        kind: 'consensus',
        deliveryMode: 'thinking',
        agentKeys: [
          'council_opus_arch', 'council_codex_arch',
          'council_opus_impl', 'council_codex_impl',
          'council_opus_risk', 'council_codex_risk',
        ],
        reviewGate: true,
      },
      moderate,
      explain,
    ];
  }
  return [
    { key: 'consensus', title: '共識評審 Consensus', kind: 'consensus', deliveryMode: 'thinking', agentKeys: ['council_a', 'council_b', 'council_c'], reviewGate: true },
    moderate,
    explain,
  ];
}

function defaultCouncilModelMap(mode, overrides = {}) {
  const glmFree = SWARM_DISABLE_GLM ? CODEX_55 : { cli: 'glm', model: DEFAULT_GLM_MODEL };
  const glmArch = SWARM_DISABLE_GLM ? OPUS_48 : { cli: 'glm', model: DEFAULT_GLM_MODEL };
  const glmImpl = SWARM_DISABLE_GLM ? CODEX_55 : { cli: 'glm', model: DEFAULT_GLM_MODEL };
  const glmRisk = SWARM_DISABLE_GLM ? OPUS_48 : { cli: 'glm', model: DEFAULT_GLM_MODEL };
  const base = {
    council_a: { cli: 'claude', model: 'opus' },
    council_b: { cli: 'codex', model: 'gpt-5.5' },
    council_c: glmRisk,
    council_opus_free: { cli: 'claude', model: 'opus' },
    council_codex_free: { cli: 'codex', model: 'gpt-5.5' },
    council_glm_free: glmFree,
    council_opus_arch: { cli: 'claude', model: 'opus' },
    council_codex_arch: { cli: 'codex', model: 'gpt-5.5' },
    council_glm_arch: glmArch,
    council_opus_impl: { cli: 'claude', model: 'opus' },
    council_codex_impl: { cli: 'codex', model: 'gpt-5.5' },
    council_glm_impl: glmImpl,
    council_opus_risk: { cli: 'claude', model: 'opus' },
    council_codex_risk: { cli: 'codex', model: 'gpt-5.5' },
    council_glm_risk: glmRisk,
    moderator: { cli: 'claude', model: 'opus' },
    explainer: { cli: 'claude', model: 'sonnet' },
  };
  const out = {};
  councilStagesForMode(mode).flatMap((s) => s.agentKeys || []).forEach((key) => {
    out[key] = normalizeModelChoice(overrides[key] || {}, base[key] || {});
  });
  return out;
}

// ─── Staged fan-out pipeline: research → build → review, each wave parallel, waves in order ───
function defaultStages(mode, options = {}) {
  if (mode === 'council') {
    // Swarm Council:review waves → moderate(仲裁改寫 plan)→ explain(人話講解)。
    // consensus+moderate 會被 advanceCouncil rewind 重入,循環到收斂 / maxRounds;
    // Phase 3 御准閘喺 moderate 收斂後、explain 之前發生(pauseForHumanGate 用 p.stopped)。
    return councilStagesForMode(options.councilMode);
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
      verifyStage(),
    ];
  }
  return [
    { key: 'research', title: '研究 Research', kind: 'research', deliveryMode: 'thinking', agentKeys: ['researcher'] },
    { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: buildAgentKeys(options.taskBrief) },
    { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'], gate: true },
    { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'], isFix: true },
    verifyStage(),
  ];
}

function startPipeline(run, options = {}) {
  const mode = options.deliveryMode || 'code';
  const councilMode = mode === 'council' ? normalizeCouncilMode(options.councilMode) : null;
  const stages = (Array.isArray(options.stages) && options.stages.length ? options.stages : defaultStages(mode, options))
    .map((s) => ({ ...s, status: 'pending', sessionId: null }));
  run.pipeline = {
    mode,
    councilMode,
    councilModeLabel: councilMode ? councilModeLabel(councilMode) : null,
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
	    verifyGateDone: false,
	    reviewVerdict: null,
	    verifyVerdict: null,
	    projectQueueKey: projectQueueKey(run.projectPath || DEFAULT_PROJECT_ROOT),
	    startedAt: new Date().toISOString(),
    // Swarm Council 收斂狀態
    councilRound: 0,
    councilPlanVersion: 0,
    councilOpenDisputes: null,
    councilDisputes: '',
    councilReviewFiles: {},
    councilPaused: false,
    councilReviewPaused: false,  // 第一輪 Council review 後嘅「開始拗」閘
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
    const verifyVerdict = p.mode === 'code' ? (p.verifyVerdict || run.verifyVerdict || 'PASS') : null;
    const verifyOk = p.mode !== 'code' || verifyVerdict === 'PASS';
    run.status = verifyOk ? (p.mode === 'code' ? 'done' : (run.synthesis ? 'complete' : 'done')) : 'needs_attention';
    run.completionVerdict = verifyOk ? 'PASS' : `VERIFY_${verifyVerdict}`;
    run.completedAt = new Date().toISOString();
    addArtifact(run, {
      type: verifyOk ? 'note' : 'execution-error',
      title: verifyOk ? 'Pipeline 完成 ✓' : `Pipeline 需要處理 · Verify ${verifyVerdict}`,
      content: verifyOk ? '所有 stage 已順序完成，最後驗證通過。' : '最後驗證未通過，請睇「下一步」決定修正 / 重跑。',
    });
    if (verifyOk) notifyRunComplete(run, 'pipeline');
    else if (process.env.SWARM_NEXTSTEPS !== '0') { try { generateNextSteps(run); } catch (_) {} }
    if (verifyOk && shouldOfferPush(run)) enterPushGate(run);   // 任務一:code pipeline 完 → 待確認 push（已 merge 去 local,等人確認先 push 上 GitHub）
    io.emit('run-updated', publicRun(run));
    scheduleSave();
    pumpRunQueue(run.projectPath);
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
// 防同一個 run 喺極短時間內被重複觸發破壞性動作（兩個 user 同一秒撳同一掣 → double-trigger 開兩條 pipeline）。
// Set + 2.5s TTL:第一個 request 攞到 lock,第二個即時 409;TTL 後自動釋放,之後靠各 endpoint 嘅 status 閘接力。
const runActionLock = new Set();
function lockRun(runId) {
  if (runActionLock.has(runId)) return false;
  runActionLock.add(runId);
  setTimeout(() => runActionLock.delete(runId), 2500);
  return true;
}
function isCodeDeliveryMode(mode) {
  return !['thinking', 'research', 'text'].includes(String(mode || 'code'));
}

function projectQueueKey(projectPath) {
  try { return safeProjectPath(projectPath || DEFAULT_PROJECT_ROOT); }
  catch (_) { return path.resolve(projectPath || DEFAULT_PROJECT_ROOT); }
}

function isCodePipelineActive(run) {
  if (!run || run.status === 'queued' || run.status === 'stopped') return false;
  const p = run.pipeline;
  if (!p || !['code', 'council'].includes(String(p.mode || '')) || p.stopped) return false;
  if (['done', 'complete', 'needs_attention', 'failed'].includes(run.status)) return false;
  return (p.stages || []).some((s) => ['running', 'pending'].includes(s.status)) || run.status === 'executing';
}

function activeCodeRunForProject(projectPath, excludeRunId) {
  const key = projectQueueKey(projectPath);
  return store.runs.find((r) => r.id !== excludeRunId && isCodePipelineActive(r) && projectQueueKey(r.projectPath) === key) || null;
}

function startRunFromOptions(run, opt) {
  run.queueScope = null;
  run.queueKey = null;
  run.queuedReason = null;
  run.queuedBehindRunId = null;
  io.emit('swarm-start', publicRun(run));
  if (opt.staged) {
    return startPipeline(run, opt);
  }
  return startExecutionAgents(run, opt.agents, opt);
}

function maybeQueueRunStart(run, opt) {
  if (!SWARM_RUN_QUEUE || !isCodeDeliveryMode(opt.deliveryMode)) return null;
  const blocker = activeCodeRunForProject(run.projectPath, run.id);
  if (!blocker) return null;
  const key = projectQueueKey(run.projectPath);
  run.status = 'queued';
  run.queueScope = 'project';
  run.queueKey = key;
  run.queuedReason = `同 project 已有 mission/council 執行中:${blocker.topic || blocker.id}`;
  run.queuedBehindRunId = blocker.id;
  run.queuedStart = opt;
  if (!runQueuePending.includes(run.id)) runQueuePending.push(run.id);
  const position = runQueuePending.filter((id) => {
    const r = store.runs.find((item) => item.id === id);
    return r && r.status === 'queued' && r.queueKey === key;
  }).indexOf(run.id) + 1;
  addArtifact(run, {
    type: 'note',
    title: `⏳ 已排隊（同 project queue #${position || runQueuePending.length}）`,
    content: `${run.queuedReason}\nProject: ${key}`,
  });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  return { queued: true, position: position || runQueuePending.length, queuedBehindRunId: blocker.id };
}

function rebuildRunQueuePending() {
  runQueuePending.splice(0, runQueuePending.length);
  const queued = store.runs
    .filter((run) => run && run.status === 'queued' && run.queuedStart)
    .slice()
    .reverse(); // store is newest-first; queue should resume oldest-first.
  queued.forEach((run) => { if (!runQueuePending.includes(run.id)) runQueuePending.push(run.id); });
}

function pumpRunQueue(projectPath) {
  if (!SWARM_RUN_QUEUE || !runQueuePending.length) return;
  const hintKey = projectPath ? projectQueueKey(projectPath) : null;
  for (let i = 0; i < runQueuePending.length; i += 1) {
    const run = store.runs.find((r) => r.id === runQueuePending[i]);
    if (!run || run.status !== 'queued') { runQueuePending.splice(i, 1); i -= 1; continue; }
    const key = run.queueKey || projectQueueKey(run.projectPath);
    if (hintKey && key !== hintKey) continue;
    if (activeCodeRunForProject(run.projectPath, run.id)) continue;
    runQueuePending.splice(i, 1);
    const opt = run.queuedStart || {};
    addArtifact(run, { type: 'note', title: '▶ 排隊完成 → 開始執行', content: `Project queue slot 已釋放:${key}` });
    startRunFromOptions(run, opt);
    emitSnapshot();
    return;
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
	    ownerUser: run.ownerUser,
	    notifyUser: run.notifyUser,
	    createdFrom: run.createdFrom,
	    queueScope: run.queueScope,
	    queueKey: run.queueKey,
	    queuedReason: run.queuedReason,
	    queuedBehindRunId: run.queuedBehindRunId,
	    completionVerdict: run.completionVerdict,
	    reviewVerdict: run.reviewVerdict,
	    verifyVerdict: run.verifyVerdict,
	    globalGoal: run.globalGoal,
	    missionTarget: run.missionTarget,
	    coordinationWarnings: run.coordinationWarnings,
	    missionControlVersion: run.missionControlVersion,
	    missionControlProjectPath: run.missionControlProjectPath,
	    intentPackKey: run.intentPackKey,
	    intentPackLabel: run.intentPackSnapshot && run.intentPackSnapshot.label,
	    intentPackVersion: run.intentPackVersion,
	    intentPackSource: run.intentPackSource,
	    domainModuleKeys: run.domainModuleKeys || [],
	    domainModuleLabels: (run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key),
	    domainModuleSource: run.domainModuleSource,
	    councilMode: run.pipeline && run.pipeline.councilMode,
	    councilModeLabel: run.pipeline && run.pipeline.councilModeLabel,
	    handoffCount: (run.handoffs || []).length,
	    latestHandoff: (run.handoffs || [])[0] || null,
	    memoryPackStatus: run.memoryPackStatus,
	    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    agentCount: run.agents.length,
    runningAgents: run.agents.filter((agent) => agent.status === 'running').length,
    artifactCount: run.artifacts.length,
    changeReportCount: (run.changeReports || []).length,
    followupCount: (run.followups || []).length,
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
  res.json({ defaultCli: DEFAULT_AGENT_CLI, glmDisabled: SWARM_DISABLE_GLM, models: MODEL_CATALOG });
});

app.get('/api/intent-packs', (req, res) => {
  const projectPath = req.query.projectPath || DEFAULT_PROJECT_ROOT;
  const control = projectMissionControl(projectPath);
  const resolved = resolveIntentPack({
    projectPath: control.projectPath,
    projectDefault: control.defaultIntentPackKey,
  });
  res.json({
    ok: true,
    defaultIntentPackKey: resolved.key,
    defaultDomainModuleKeys: control.defaultDomainModuleKeys || [],
    projectPath: control.projectPath,
    packs: Object.values(INTENT_PACKS).map(cloneIntentPack),
    productScopes: Object.values(INTENT_PACKS).map(cloneIntentPack),
    domainModules: Object.values(DOMAIN_MODULES).map(cloneDomainModule),
  });
});

app.get('/api/mission-control', (req, res) => {
  res.json({ ok: true, missionControl: projectMissionControl(req.query.projectPath || DEFAULT_PROJECT_ROOT) });
});

app.patch('/api/mission-control', (req, res) => {
  try {
    const body = req.body || {};
    const patch = { updatedBy: body.updatedBy || body.ownerUser || body.user || 'dashboard' };
    patch.projectPath = body.projectPath || req.query.projectPath || DEFAULT_PROJECT_ROOT;
    if (body.globalGoal !== undefined) patch.globalGoal = body.globalGoal;
    if (body.defaultGlobalGoal !== undefined) patch.defaultGlobalGoal = body.defaultGlobalGoal;
    if (body.defaultIntentPackKey !== undefined || body.intentPackKey !== undefined) patch.defaultIntentPackKey = body.defaultIntentPackKey || body.intentPackKey;
    if (body.defaultDomainModuleKeys !== undefined || body.domainModuleKeys !== undefined || body.intentModuleKeys !== undefined) patch.defaultDomainModuleKeys = body.defaultDomainModuleKeys || body.domainModuleKeys || body.intentModuleKeys;
    if (body.handoffGuidelines !== undefined) patch.handoffGuidelines = body.handoffGuidelines;
    writeMissionControl(patch);
    res.json({ ok: true, missionControl: projectMissionControl(patch.projectPath) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/mission-target/draft', async (req, res) => {
  try {
    const body = req.body || {};
    const taskBrief = String(body.taskBrief || body.task || '').trim();
    const topic = String(body.topic || '').trim() || taskBrief.split('\n')[0] || 'Swarm Mission';
    const projectPath = body.projectPath ? safeProjectPath(body.projectPath) : DEFAULT_PROJECT_ROOT;
    const control = projectMissionControl(projectPath);
    const target = await draftMissionTargetAI({
      topic,
      taskBrief,
      projectPath,
      globalGoal: body.globalGoal || control.globalGoal,
      cli: body.cli,
      model: body.model,
    });
    res.json({ ok: true, target, missionControl: control });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Opus 完善 prompt → 結構化 brief（Telegram bot 過目 gate 用；同步 spawn，等完返 refined）。
// 初次：傳 text（粗略需求）；迭代修訂：傳 base（上一版）+ note（用戶改善意見），可重複。
app.post('/api/refine', async (req, res) => {
  const body = req.body || {};
  const text = String(body.text || '').trim();
  const base = String(body.base || '').trim();
  const note = String(body.note || '').trim();
  if (!text && !(base && note)) return res.status(400).json({ error: 'text (或 base+note) required' });
  const kind = body.kind === 'council' ? 'council' : 'mission';
  const sys = kind === 'council' ? COUNCIL_REFINE_PROMPT : MISSION_REFINE_PROMPT;
  const picked = normalizeModelChoice({ cli: body.cli, model: body.model }, { cli: 'claude', model: 'opus' });
  const prompt = (base && note)
    ? `${sys}\n\n以下係現有 brief：\n${base}\n\n---\n用戶想改善／補充嘅位：\n${note}\n\n---\n出修訂後嘅完整 brief（繁體中文 markdown）：保留冇提及要改嘅部分,只就用戶意見調整／補充。唔好加任何前言、解釋或「以下是」之類引導句：`
    : `${sys}\n\n---\n用戶原文：\n${text}\n\n---\n直接輸出完善版本身（繁體中文 markdown）,唔好加任何前言、解釋或「以下是」之類引導句：`;
  try {
    const refined = await spawnOneShot(prompt, picked, 'swarm-refine', 90000);
    res.json({ ok: true, refined: (refined || '').trim(), kind });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Overseer:總管對話 AI（plain text → 帶全局 digest 嘅 Claude turn）───
// Tier 1 唯讀問答 + review；Tier 2 動作經 ACTION: 行(由 bot confirm-gate 守破壞性動作)。
const OVERSEER_SYSTEM = [
  '你係用戶嘅 Swarm 總管 AI(overseer)。下面會俾你而家所有 run / project 嘅實況。',
  '用繁體中文 / 廣東話、簡短、結果導向答用戶:總結、review、比較、指風險、建議下一步。',
  '唔好作數據;淨係根據俾你嘅實況答,唔夠料就照講「要 /show X 睇全文」。',
  '',
  '淨係當用戶明確想你代佢做動作,先喺答覆**最後獨立一行**輸出一個機器指令(冇就唔好輸出,一次最多一個):',
  'ACTION: approve            # 批准當前御准閘',
  'ACTION: debate             # 開拗收斂',
  'ACTION: execute            # 落實當前議會終稿',
  'ACTION: stop               # 中途停止當前 run',
  'ACTION: revise: <一句指示>  # 叫議會就意見再收斂一 round',
  'ACTION: council: <題目>     # 開一個新 AI 聯合國 Council',
  'ACTION: mission: <plan>     # 開一個新 mission 落 code',
  '',
  '「AI 聯合國」alias（重要）:用戶講「聯合國」「聯合國議會」「AI 聯合國」「ORCA 聯合國」「擺去聯合國」「交俾聯合國」「叫聯合國開會」,都係叫你開 Council 議會;唔係指真正 United Nations。呢類請求要輸出 `ACTION: council: <題目 / plan>`。',
  '',
  '判斷執行意圖（重要）:用戶講「根據呢份 report / plan 去執行」「落實佢」「照呢個 plan 改 code / 開工做」等明確叫你落手實作 →',
  '  · 當前 run 已有議會終稿(planv≥1) → 出 `ACTION: execute`(落實終稿,會問你揀 build model)。',
  '  · 用戶俾一段新 plan 文字叫你做 → 出 `ACTION: mission: <plan>`。',
  '用戶仲喺度討論 / 未拍板 / 只係問意見 → 唔好出 ACTION。',
  '純粹問狀態 / 總結 / 意見,唔好輸出 ACTION。',
].join('\n');

function buildOverseerDigest(light = false) {
  const cur = getCurrentRun();
  const runs = store.runs.slice(light ? -6 : -12).reverse().map((r) => {
    const p = r.pipeline || {};
    const gate = p.councilPaused ? 'GATE=等御准' : (p.councilReviewPaused ? 'GATE=等開拗' : '');
    const arts = light ? '' : (r.artifacts || []).slice(-2).map((a) => a.title || a.type).filter(Boolean).join('; ');
    const mode = p.mode || (r.metrics && r.metrics.deliveryMode) || '-';
    const target = missionTargetSummary(r.missionTarget);
    const pack = r.intentPackSnapshot && (r.intentPackSnapshot.shortLabel || r.intentPackSnapshot.label);
    const modules = (r.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(',');
    return `- [${r.id}] "${truncate(r.topic || '', 80)}" status=${r.status} stage=${r.stage || '-'} mode=${mode}${pack ? ' pack=' + pack : ''}${modules ? ' modules=' + modules : ''} ${gate}${p.councilPlanVersion ? ' planv' + p.councilPlanVersion : ''}${target ? ' | target: ' + truncate(target, 120) : ''}${arts ? ' | 近產出: ' + arts : ''}`;
  }).join('\n');
  const projects = (knownProjects() || []).map((p) => (typeof p === 'string' ? p : (p.path || p.name || ''))).filter(Boolean).join(', ');
  return { runs, projects, currentRunId: cur && cur.id ? cur.id : null };
}

function parseOverseerReply(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^ACTION:\s*(approve|debate|execute|revise|council|mission|stop)\b\s*(?::\s*([\s\S]+?))?\s*$/im);
  if (!m) return { reply: text || '(冇內容)', action: null };
  const reply = text.replace(m[0], '').trim();
  return { reply: reply || '(已建議動作)', action: { type: m[1].toLowerCase(), arg: (m[2] || '').trim() } };
}

function detectCouncilAliasAction(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  const councilName = '(?:AI\\s*)?(?:ORCA\\s*)?聯合國(?:議會)?|三模議會|三司會審|三位師傅開枱';
  const before = new RegExp('(?:開|召喚|交(?:俾|去)?|擺(?:去|入)?|放(?:去|入)?|送(?:去|俾)?|叫|請|審|評審|review).{0,30}(?:' + councilName + ')', 'i');
  const after = new RegExp('(?:' + councilName + ').{0,30}(?:開會|開波|審|評審|review|討論)', 'i');
  if (!before.test(text) && !after.test(text)) return null;
  return { type: 'council', arg: text };
}

app.post('/api/overseer', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const deep = body.mode === 'deep';
  const picked = { cli: 'claude', model: safeModelFlag(body.model) || (deep ? 'opus' : 'sonnet') };
  const d = buildOverseerDigest(!deep); // 快答用輕量 digest（少 run、無 artifacts）
  const hist = Array.isArray(body.history)
    ? body.history.slice(-6).map((h) => `【${h.role === 'user' ? '用戶' : '總管'}】${truncate(String(h.content || ''), 800)}`).join('\n')
    : '';
  const skills = deep ? getSkillContent('overseer') : ''; // 快答唔注入 skill（細 prompt = 快）
  const modeNote = deep
    ? '\n\n（深入模式:可以詳細 review、引用實況、用埋你嘅 skill 深入分析。）'
    : '\n\n（快答模式:簡短、直接俾 idea / 意見即可,唔好為咗周全而長篇大論,亦唔使去 review code,除非用戶明確叫你深入。）';
  const prompt = `${OVERSEER_SYSTEM}${modeNote}${skills}\n\n=== 而家 Swarm 實況 ===\n當前 run: ${d.currentRunId || '(冇)'}\nProjects: ${d.projects || '-'}\nRuns(新→舊):\n${d.runs || '(冇)'}\n\n${hist ? `=== 之前對話 ===\n${hist}\n\n` : ''}=== 用戶而家講 ===\n${message}\n\n答用戶:`;
  try {
    const raw = await spawnOneShot(prompt, picked, 'swarm-overseer', deep ? 600000 : 240000);
    const parsed = parseOverseerReply(raw);
    const aliasAction = detectCouncilAliasAction(message);
    if (aliasAction && (!parsed.action || parsed.action.type !== 'council')) {
      parsed.action = aliasAction;
      if (!parsed.reply || parsed.reply === '(冇內容)') parsed.reply = '收到,交俾 AI 聯合國 Council 開會。';
    }
    res.json({ ok: true, reply: parsed.reply, action: parsed.action, model: picked.model });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Next-steps:run 完成後嘅「收斂層」———————————————————————————
// 一個 run（議會 / mission / code pipeline）跑完之後,將散落嘅人話講解、未解爭議、
// reviewer findings、失敗階段 收斂成「⚠️ Gap / 💡 下一步」結構化清單,每項 map 一個
// 可一鍵執行嘅動作（execute / revise / mission / council / none）。lazy 生成 + cache,
// 唔會每次 poll 都燒 LLM。前端（手機 m.html + 桌面 index.html）共用呢個 contract。
const _nextStepsInflight = new Map(); // runId -> { sig, promise }（去重,避免並發重複 spawn）
const NEXT_STEPS_SYSTEM = [
  '你係 Swarm 嘅「收斂層」AI。一個 run 啱啱完成,下面係佢嘅實況。',
  '你要做兩樣嘢,幫用戶睇清「跟住做咩」:',
  '1) GAP —— 抽出未做好 / fail / 風險 / 漏咗嘅位（如有,冇就空陣列）;',
  '2) SUGGESTION —— 具體、可即刻落手嘅下一步建議。',
  '每項 map 一個動作俾用戶一鍵做。action_type 只可以係:',
  '  execute  — 落實當前議會終稿（淨係 council 已收斂、未落 code 時啱用）',
  '  revise   — 叫議會就某意見再收斂一 round（action_arg = 一句指示）',
  '  mission  — 開一個新 mission 落 code 去修 / 做呢件事（action_arg = 清楚、可直接落手嘅 plan brief,寫明範圍）',
  '  council  — 開一個新 AI 聯合國 Council 傾呢個議題（action_arg = 議題）',
  '  none     — 淨係值得傾 / 唔需要自動動作',
  '嚴格淨係輸出一個 JSON object（唔好加 markdown fence、唔好任何前言或結語）,schema:',
  '{"gaps":[{"severity":"fail|warn","title":"短","detail":"一兩句","action_type":"mission|revise|none","action_arg":"..."}],"suggestions":[{"title":"短","rationale":"點解值得做","action_type":"mission|council|execute|revise|none","action_arg":"...","discuss_seed":"用戶想傾呢項時 pre-seed 落總管對話嘅問句"}]}',
  '最多 4 個 gaps + 4 個 suggestions。用繁體中文 / 廣東話。action_arg 要夠具體(寫明 project / 檔案 / 範圍),令 mission 可以直接照住做。',
].join('\n');

function nextStepsSignature(run) {
  const p = run.pipeline || {};
  const doneStages = (p.stages || []).filter((s) => s.status === 'complete').length;
  return [run.status || '', p.councilPlanVersion || 0, p.councilRound || 0, doneStages, run.completionVerdict || '', run.reviewVerdict || p.reviewVerdict || '', run.verifyVerdict || p.verifyVerdict || '', run.completedAt || run.finishedAt || ''].join('|');
}

function structuredVerdict(run) {
  const p = run.pipeline || {};
  const stages = p.stages || [];
  let pass = 0; let fail = 0;
  stages.forEach((s) => {
    if (s.status === 'complete') pass++;
    else if (s.status === 'failed' || s.status === 'interrupted') fail++;
  });
  const failAgents = (run.agents || []).filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  return { pass, warn: 0, fail: fail + failAgents, openDisputes: p.councilOpenDisputes != null ? p.councilOpenDisputes : 0 };
}

function buildNextStepsContext(run) {
  const p = run.pipeline || {};
  const mode = p.mode || (run.metrics && run.metrics.deliveryMode) || 'code';
  const parts = [];
  parts.push(buildMissionContextBlock(run));
  parts.push(`任務: ${truncate(run.taskBrief || run.background || run.topic || '', 700)}`);
  const moduleLabels = (run.domainModuleSnapshots || []).map((m) => m.shortLabel || m.label || m.key).join(', ') || '-';
  parts.push(`Project: ${run.projectPath || '-'} · 模式: ${mode} · Product Scope: ${run.intentPackSnapshot ? run.intentPackSnapshot.label : run.intentPackKey || '-'} · Domain Modules: ${moduleLabels} · 狀態: ${run.status || '-'} · Owner: ${run.ownerUser || '-'} · Notify: ${run.notifyUser || '-'}`);
  if (run.queueScope || run.queuedReason) parts.push(`Queue: ${run.queueScope || '-'} · ${run.queuedReason || ''} · behind=${run.queuedBehindRunId || '-'}`);
  if (run.completionVerdict || run.reviewVerdict || run.verifyVerdict || p.reviewVerdict || p.verifyVerdict) {
    parts.push(`Verdict: completion=${run.completionVerdict || '-'} · review=${run.reviewVerdict || p.reviewVerdict || '-'} · verify=${run.verifyVerdict || p.verifyVerdict || '-'}`);
  }
  if (run.memoryPackStatus) {
    parts.push(`Memory Pack: included=${(run.memoryPackStatus.included || []).join(', ') || '-'} · missing=${(run.memoryPackStatus.missing || []).join(', ') || '-'}`);
  }
  const changesTxt = summarizeChangeReportsText(run, 1200);
  if (changesTxt) parts.push(`今次實際改動（server git 記錄）:\n${changesTxt}`);
  const stages = p.stages || [];
  if (stages.length) parts.push(`階段:\n${stages.map((s) => `- ${s.title} = ${s.status}`).join('\n')}`);
  if (run.synthesis) parts.push(`人話講解（收斂決策）:\n${truncate(run.synthesis, 1600)}`);
  const disputes = (p.councilDisputes || '').trim();
  if (disputes && !/^\(?(none|無)\)?$/i.test(disputes)) parts.push(`未解爭議:\n${truncate(disputes, 700)}`);
  const reviewers = (run.agents || []).filter((a) => /review|覆核|reviewer|verif|驗證/i.test(`${a.role || ''}${a.name || ''}${a.layer || ''}`));
  const revTxt = reviewers.map((a) => `【${a.name} · ${a.status}】${truncate(a.logs || '', 600)}`).filter((s) => s.length > 12).join('\n');
  if (revTxt) parts.push(`覆核 / 驗證 agent 輸出:\n${revTxt}`);
  const failedAgents = (run.agents || []).filter((a) => a.status === 'failed' || a.status === 'interrupted');
  if (failedAgents.length) parts.push(`失敗 / 中斷 agent: ${failedAgents.map((a) => a.name).join(', ')}`);
  if ((run.handoffs || []).length) {
    parts.push(`最近 Agent Handoffs:\n${(run.handoffs || []).slice(0, 8).map((h) => `- ${h.agentName}: ${truncate(h.summary || '', 220)}${(h.warnings || []).length ? ` | warnings: ${h.warnings.slice(0, 2).join(' / ')}` : ''}`).join('\n')}`);
  }
  const arts = (run.artifacts || []).slice(0, 6).map((a) => `${a.title || a.type}: ${truncate(a.content || '', 220)}`).filter(Boolean).join('\n');
  if (arts) parts.push(`產出 artifact: ${arts}`);
  return parts.join('\n\n');
}

function parseNextSteps(raw) {
  let t = String(raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const brace = t.match(/\{[\s\S]*\}/);
  if (brace) t = brace[0];
  let obj = null;
  try { obj = JSON.parse(t); } catch (_) { obj = null; }
  const clampAction = (ty) => (['execute', 'revise', 'mission', 'council', 'none'].includes(String(ty || '').toLowerCase()) ? String(ty).toLowerCase() : 'none');
  const mkGap = (g, i) => ({
    id: `g${i + 1}`,
    severity: g && /fail/i.test(g.severity || '') ? 'fail' : 'warn',
    title: truncate(String((g && g.title) || ''), 120),
    detail: truncate(String((g && g.detail) || ''), 400),
    action: { type: clampAction(g && g.action_type), arg: truncate(String((g && g.action_arg) || ''), 1400) },
  });
  const mkSug = (s, i) => ({
    id: `s${i + 1}`,
    title: truncate(String((s && s.title) || ''), 120),
    rationale: truncate(String((s && s.rationale) || ''), 400),
    action: { type: clampAction(s && s.action_type), arg: truncate(String((s && s.action_arg) || ''), 1400) },
    discussSeed: truncate(String((s && s.discuss_seed) || (s && s.title) || ''), 600),
  });
  if (obj && (Array.isArray(obj.gaps) || Array.isArray(obj.suggestions))) {
    return {
      gaps: (obj.gaps || []).slice(0, 4).map(mkGap).filter((g) => g.title),
      suggestions: (obj.suggestions || []).slice(0, 4).map(mkSug).filter((s) => s.title),
    };
  }
  // Fallback:JSON parse 唔到 → 把全文當一個「值得傾」嘅 suggestion,起碼唔會空白。
  const txt = String(raw || '').trim();
  return {
    gaps: [],
    suggestions: txt ? [{ id: 's1', title: '睇收斂建議', rationale: truncate(txt, 400), action: { type: 'none', arg: '' }, discussSeed: '根據呢個 run 嘅結果,下一步應該做咩?' }] : [],
  };
}

function generateNextSteps(run, sig) {
  sig = sig || nextStepsSignature(run);
  const inflight = _nextStepsInflight.get(run.id);
  if (inflight && inflight.sig === sig) return inflight.promise;
  const promise = (async () => {
    const ctx = buildNextStepsContext(run);
    const prompt = `${NEXT_STEPS_SYSTEM}\n\n=== Run 實況 ===\n${ctx}\n\n直接出 JSON（唔好加 markdown fence、唔好前言）:`;
    const raw = await spawnOneShot(prompt, { cli: 'claude', model: 'sonnet' }, 'swarm-nextsteps', 180000);
    const parsed = parseNextSteps(raw);
    run.nextSteps = { signature: sig, generatedAt: Date.now(), source: 'overseer', gaps: parsed.gaps, suggestions: parsed.suggestions };
    scheduleSave();
    io.emit('run-updated', publicRun(run));
    return run.nextSteps;
  })();
  _nextStepsInflight.set(run.id, { sig, promise });
  promise.catch(() => {}).finally(() => { const cur = _nextStepsInflight.get(run.id); if (cur && cur.promise === promise) _nextStepsInflight.delete(run.id); });
  return promise;
}

app.get('/api/runs/:id/next-steps', async (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const sig = nextStepsSignature(run);
  const verdict = structuredVerdict(run);
  if (req.query.refresh !== '1' && run.nextSteps && run.nextSteps.signature === sig) {
    return res.json({ ok: true, cached: true, source: run.nextSteps.source, generatedAt: run.nextSteps.generatedAt, verdict, gaps: run.nextSteps.gaps || [], suggestions: run.nextSteps.suggestions || [] });
  }
  try {
    const ns = await generateNextSteps(run, sig);
    res.json({ ok: true, cached: false, source: ns.source, generatedAt: ns.generatedAt, verdict, gaps: ns.gaps || [], suggestions: ns.suggestions || [] });
  } catch (e) { res.status(500).json({ error: e.message, verdict }); }
});

app.get('/api/runs/:id', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (run) res.json(run);
});

app.get('/api/projects', (req, res) => {
  res.json({ defaultProjectRoot: DEFAULT_PROJECT_ROOT, projects: knownProjects() });
});

// 已知 Telegram users（bot registry）——dashboard「通知邊個」selector 用。
app.get('/api/tg-users', (req, res) => {
  const reg = readTgUsers();
  res.json({ users: Object.values(reg).map((u) => ({ chatId: u.chatId, username: u.username, name: u.name })) });
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

app.post('/api/runs', async (req, res) => {
  try {
    const run = createRun(req.body || {});
    if (!(req.body || {}).missionTarget) await ensureMissionTargetDraft(run, { cli: (req.body || {}).cli, model: (req.body || {}).model });
    io.emit('swarm-start', publicRun(run));
    emitSnapshot();
    res.json({ ok: true, run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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
    if (body.globalGoal !== undefined) run.globalGoal = normalizeTextField(body.globalGoal);
    if (body.missionTarget !== undefined) run.missionTarget = normalizeMissionTarget(body.missionTarget, run.taskBrief || run.topic || '');
    if (body.coordinationWarnings !== undefined) run.coordinationWarnings = normalizeStringList(body.coordinationWarnings, []);
    if (body.intentPackKey !== undefined) {
      const intent = resolveIntentPack({ key: body.intentPackKey, projectPath: run.projectPath, source: 'user' });
      run.intentPackKey = intent.key;
      run.intentPackVersion = intent.version;
      run.intentPackSnapshot = intent.snapshot;
      run.intentPackSource = intent.source;
      if (intent.fallbackWarning) addArtifact(run, { type: 'warning', title: 'Intent Pack fallback', content: intent.fallbackWarning });
    }
    if (body.domainModuleKeys !== undefined || body.intentModuleKeys !== undefined) {
      const modules = resolveDomainModules({
        keys: body.domainModuleKeys !== undefined ? body.domainModuleKeys : body.intentModuleKeys,
        projectDefaultKeys: [],
        topic: run.topic,
        taskBrief: run.taskBrief,
        source: 'user',
      });
      run.domainModuleKeys = modules.keys;
      run.domainModuleSnapshots = modules.snapshots;
      run.domainModuleSource = modules.source;
    }
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
  const removed = store.runs.find((run) => run.id === runId);
  const before = store.runs.length;
  store.runs = store.runs.filter((run) => run.id !== runId);
  if (before === store.runs.length) return res.status(404).json({ error: 'run not found' });
  const qIdx = runQueuePending.indexOf(runId);
  if (qIdx >= 0) runQueuePending.splice(qIdx, 1);
  if (store.currentRunId === runId) store.currentRunId = store.runs[0] ? store.runs[0].id : null;
  scheduleSave();
  emitSnapshot();
  io.emit('runs-deleted', { deletedRunId: runId, currentRunId: store.currentRunId });
  pumpRunQueue(removed && removed.projectPath);
  res.json({ ok: true, deletedRunId: runId, currentRunId: store.currentRunId });
});

app.post('/api/runs/:id/execution/start', async (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  if (!lockRun(run.id)) return res.status(409).json({ error: '呢個 run 啱啱有動作處理緊,等一兩秒先再試' });
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
    if (body.globalGoal !== undefined) run.globalGoal = normalizeTextField(body.globalGoal);
    if (body.missionTarget !== undefined) run.missionTarget = normalizeMissionTarget(body.missionTarget, run.taskBrief || run.topic || '');
    if (body.coordinationWarnings !== undefined) run.coordinationWarnings = normalizeStringList(body.coordinationWarnings, []);
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
    if (!body.missionTarget) await ensureMissionTargetDraft(run, { taskBrief: body.taskBrief, cli: body.cli, model: body.model });
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
app.post('/api/plans/run', async (req, res) => {
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
	      tgChatId: body.tgChatId,
	      tgUser: body.tgUser,
	      ownerUser: body.ownerUser,
	      notifyUser: body.notifyUser,
	      createdFrom: body.createdFrom || 'dashboard',
	      globalGoal: body.globalGoal,
	      missionTarget: body.missionTarget,
	      coordinationWarnings: body.coordinationWarnings,
	      intentPackKey: body.intentPackKey,
	      domainModuleKeys: body.domainModuleKeys,
	      seed: false, // drop-zone plans start clean; agents come from the wave/pipeline we spawn
	    });
	    if (!body.missionTarget) await ensureMissionTargetDraft(run, { taskBrief, cli: body.cli, model: body.model });
	    const deliveryMode = body.deliveryMode || body.mode || 'code';
	    const deliverable = body.deliverable || (deliveryMode === 'code' ? 'code' : 'text');
	    const startOptions = {
	      staged: !!body.staged,
	      deliveryMode,
	      deliverable,
	      model: body.model,
	      cli: body.cli,
	      perAgentModels: body.perAgentModels || {},
	      stages: Array.isArray(body.stages) ? body.stages : null,
	      agents: body.agents,
	      taskBrief,
	      sessionTitle: body.sessionTitle,
	    };
	    const queued = maybeQueueRunStart(run, startOptions);
	    if (queued) return res.json({ ok: true, ...queued, run });
	    const result = startRunFromOptions(run, startOptions);
	    if (body.staged) {
	      emitSnapshot();
	      return res.json({ ok: true, run, pipeline: result });
	    }
	    emitSnapshot();
	    res.json({ ok: true, run, agents: result.agents });
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
  if (!lockRun(run.id)) return res.status(409).json({ error: '呢個 run 啱啱有動作處理緊,等一兩秒先再試' });
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

// Change reports:成個 run 嘅「改咗乜」結構化記錄。?patch=0 慳流量（TG bot 用）。
app.get('/api/runs/:id/changes', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const includePatch = req.query.patch !== '0';
  const reports = (run.changeReports || []).map((r) => (includePatch ? r : { ...r, patch: undefined }));
  const totals = reports.reduce((acc, r) => ({
    reports: acc.reports + 1,
    files: acc.files + ((r.filesChanged || []).length + (r.filesOmitted || 0)),
    adds: acc.adds + (r.totalAdds || 0),
    dels: acc.dels + (r.totalDels || 0),
  }), { reports: 0, files: 0, adds: 0, dels: 0 });
  res.json({ ok: true, totals, reports });
});

// ─── Swarm Council 御准閘 endpoints ───
// 批准 → 解 pause、用終稿 plan 行 explainer stage(Phase 4)。
app.post('/api/runs/:id/council/approve', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  const result = continueCouncilApproval(run, p, { auto: false });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
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

// 開始拗:Council review 後,用戶撳掣 → 入 moderator + 辯論收斂(consensus 已 complete,advancePipeline 行 moderator)。
app.post('/api/runs/:id/council/debate', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const p = run.pipeline;
  const result = continueCouncilDebate(run, p, { auto: false });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 落實:批准後將議會終稿 plan 交 code pipeline(build→review→fix)真正喺 project 實作。
app.post('/api/runs/:id/council/execute', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  if (!lockRun(run.id)) return res.status(409).json({ error: '呢個 run 啱啱有動作處理緊,等一兩秒先再試' });
  if (run.pipeline && run.pipeline.mode === 'code' && (run.pipeline.stages || []).some((s) => s.status === 'running')) {
    return res.status(409).json({ error: 'code pipeline 已經跑緊,唔使再落實' });   // status 閘:防 pipeline running 期間重複 execute（補 TTL 之後嘅窗）
  }
  const plan = readLatestPlan(run);
  if (!plan.md || !plan.md.trim() || (plan.v || 0) < 1) {
    return res.status(400).json({ error: '未有議會終稿 plan 可落實(請先跑完議會 + 批准)' });
  }
  if (hasHumanEscalation(`${plan.md}\n${run.pipeline && run.pipeline.councilDisputes || ''}`)) {
    addArtifact(run, {
      type: 'council-gate',
      title: `⛔ plan v${plan.v} 仍有 Hugo / owner 決策，未准落 code`,
      content: 'Plan 內仍有 ESCALATE / 需要 Hugo 決定項。請先「再改」或由 owner 明確拍板後，再落實。',
    });
    io.emit('run-updated', publicRun(run));
    return res.status(409).json({ error: 'plan 仲有需要 Hugo / owner 拍板嘅 ESCALATE，未准 execute' });
  }
  const body = req.body || {};
  const model = body.model || 'sonnet';
  const perAgentModels = body.perAgentModels || {
    frontend: { cli: 'codex', model: 'gpt-5.5' },
    backend: { cli: 'codex', model: 'gpt-5.5' },
    database: { cli: 'codex', model: 'gpt-5.5' },
    test: { cli: 'codex', model: 'gpt-5.5' },
    fixer: { cli: 'codex', model: 'gpt-5.5' },
    reviewer: { cli: 'claude', model: 'opus' },
    verifier: { cli: 'claude', model: 'sonnet' },
  };
  const taskBrief = `# 落實以下已通過 AI 聯合國 Council 審議嘅 plan（v${plan.v}）\n\n按呢個 plan 直接喺 project 落手實作,完成後跑驗證 / 測試。唔好重新爭論 plan 本身,佢已經 Council 收斂 + 人手批准。\n\n${plan.md}${collectReviewFindings(run)}`;
  try {
    const stages = [
      { key: 'build', title: '建造 Build', kind: 'code', deliveryMode: 'code', agentKeys: buildAgentKeys(plan.md) },
      { key: 'review', title: '覆核 Review', kind: 'review', deliveryMode: 'code', agentKeys: ['reviewer'], gate: true },
      { key: 'fix', title: '修正 Fix', kind: 'code', deliveryMode: 'code', agentKeys: ['fixer'], isFix: true },
      verifyStage(),
    ];
    const startOptions = {
      staged: true,
      deliveryMode: 'code',
      model,
      perAgentModels,
      stages,
      taskBrief,
    };
    const queued = maybeQueueRunStart(run, startOptions);
    if (queued) {
      addArtifact(run, { type: 'note', title: `⏳ plan v${plan.v} 已排隊落實`, content: `同 project code queue 忙緊，稍後自動 build → review → fix → verify。` });
      io.emit('run-updated', publicRun(run));
      return res.json({ ok: true, queued: true, executingVersion: plan.v, ...queued, run });
    }
    const pipeline = startRunFromOptions(run, startOptions);
    addArtifact(run, { type: 'note', title: `▶ 落實 plan v${plan.v} → code pipeline 開波`, content: `已交 build → review → fix → verify 喺 ${run.projectPath} 實作。` });
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, executingVersion: plan.v, pipeline });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── 任務三:暴露 council review 報告（前端睇 + code agent 讀）───
app.get('/api/runs/:id/council/reviews', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const dir = COUNCIL_DIR(run.id);
  const excerpt = (fn) => { try { return truncate(fs.readFileSync(path.join(dir, fn), 'utf8'), 2000); } catch (_) { return ''; } };
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return res.json({ ok: true, rounds: [], research: [], plan: null }); }
  const reviewRe = /^round-(\d+)(?:-([a-z0-9_-]+))?-reviewer-(\d+)\.md$/i;
  const rounds = {};
  files.filter((f) => reviewRe.test(f)).forEach((f) => {
    const m = f.match(reviewRe); const rd = Number(m[1]);
    (rounds[rd] = rounds[rd] || []).push({ stage: m[2] || 'consensus', reviewer: Number(m[3]), file: f, excerpt: excerpt(f) });
  });
  const research = files.filter((f) => /^research-\d+\.md$/.test(f)).map((f) => ({ file: f, excerpt: excerpt(f) }));
  const plan = readLatestPlan(run);
  res.json({
    ok: true,
    plan: { v: plan.v, md: plan.md },
    rounds: Object.keys(rounds).sort((a, b) => a - b).map((r) => ({
      round: Number(r),
      reviewers: rounds[r].sort((a, b) => (a.stage || '').localeCompare(b.stage || '') || a.reviewer - b.reviewer),
    })),
    research,
    disputes: (run.pipeline && run.pipeline.councilDisputes) || '',
  });
});
app.get('/api/runs/:id/council/reviews/:file', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const file = String(req.params.file || '');
  if (!/^(round-\d+(?:-[a-z0-9_-]+)?-reviewer-\d+|research-\d+|plan\.v\d+|brief)\.md$/i.test(file)) {
    return res.status(400).json({ error: 'bad file name' });    // 防 path traversal:只准白名單 pattern
  }
  const dir = COUNCIL_DIR(run.id);
  const full = path.join(dir, file);
  if (!full.startsWith(dir + path.sep)) return res.status(400).json({ error: 'path escape' });
  try { res.type('text/plain; charset=utf-8').send(fs.readFileSync(full, 'utf8')); }
  catch (_) { res.status(404).json({ error: 'not found' }); }
});

// ─── 任務一:Push gate endpoints（Telegram / dashboard 共用同一 run.pendingPush）───
app.post('/api/runs/:id/push', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const pp = run.pendingPush;
  if (!pp || !['awaiting', 'failed'].includes(pp.status)) {
    return res.status(400).json({ error: '冇待確認嘅 push（pendingPush 唔喺 awaiting/failed）' });
  }
  doGitPush(run);
  res.json({ ok: true, status: run.pendingPush.status });
});
app.post('/api/runs/:id/push/retarget', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const pp = run.pendingPush;
  if (!pp) return res.status(400).json({ error: '冇 pendingPush' });
  const body = req.body || {};
  if (body.branch !== undefined) {
    const b = String(body.branch || '').trim();
    if (!b || !/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..') || b.startsWith('-')) {
      return res.status(400).json({ error: 'branch 名唔合法' });
    }
    pp.branch = b;
  }
  if (body.projectIdx !== undefined) {
    const list = knownProjects();
    const idx = Number(body.projectIdx);
    if (!list[idx]) return res.status(400).json({ error: 'project index 無效' });
    pp.project = list[idx].path;
  } else if (body.project !== undefined) {
    try { pp.project = safeProjectPath(body.project); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  pp.status = 'awaiting';
  io.emit('push-gate', { runId: run.id, pendingPush: pp });
  io.emit('run-updated', publicRun(run));
  notifyPushGate(run);            // 重發帶最新 project/branch 嘅 gate
  scheduleSave();
  res.json({ ok: true, pendingPush: pp });
});
app.post('/api/runs/:id/push/decline', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  const pp = run.pendingPush;
  if (!pp) return res.status(400).json({ error: '冇 pendingPush' });
  pp.status = 'declined';
  pp.decidedAt = new Date().toISOString();
  addArtifact(run, { type: 'note', title: '✋ 已取消 push', content: `${path.basename(pp.project || '')} / ${pp.branch} 唔 push。` });
  io.emit('push-gate', { runId: run.id, pendingPush: pp });
  io.emit('run-updated', publicRun(run));
  scheduleSave();
  res.json({ ok: true });
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
app.post('/api/runs/:id/council/start', async (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  if (!lockRun(run.id)) return res.status(409).json({ error: '呢個 run 啱啱有動作處理緊,等一兩秒先再試' });
  // console 開議會時揀咗「通知邊個」→ 綁定成個 flow 嘅通知去嗰個 user（唔再硬跌 owner）。
  const tgUser0 = (req.body || {}).tgUser;
  if (tgUser0) {
    const cid = resolveTgChat(tgUser0);
    if (cid) { run.tgChatId = cid; run.tgUser = tgUser0; }
    run.ownerUser = normalizeUserLabel(run.ownerUser === 'owner' ? tgUser0 : run.ownerUser, tgUser0);
    run.notifyUser = normalizeUserLabel(tgUser0, run.ownerUser);
  }
  run.createdFrom = run.createdFrom || 'dashboard';
  const brief = run.missionBrief;
  // taskBrief 優先序:已定稿 brief > run.taskBrief > 直接用 chat 對話(免一定要先定稿)
  let taskBrief = run.taskBrief || (brief && brief.draftPlanMd) || '';
  if (!taskBrief.trim() && Array.isArray(run.chatThread) && run.chatThread.length) {
    taskBrief = '## 用戶 review 目標 / prompt(由 chat 對話收集)\n\n' +
      run.chatThread.map((m) => `【${m.role === 'user' ? '用戶' : '幕僚'}】${m.content}`).join('\n\n');
  }
  if (!taskBrief.trim()) return res.status(400).json({ error: '未有 brief / 對話,請先喺 chat 寫低你想 review 乜' });
  const body = req.body || {};
  const councilMode = normalizeCouncilMode(body.councilMode);
  const per = body.perAgentModels || {};
  // 預設 model 組合,可由前端逐個覆寫；balanced/deep 會自動補齊額外 reviewer。
  const perAgentModels = defaultCouncilModelMap(councilMode, per);
  const wantPath = (brief && brief.projectPath) || run.chatProjectPath;
  if (wantPath) { try { run.projectPath = safeProjectPath(wantPath); } catch (_) {} }
  try {
    await ensureMissionTargetDraft(run, { taskBrief, cli: 'claude', model: 'sonnet' });
    const startOptions = { staged: true, deliveryMode: 'council', councilMode, perAgentModels, taskBrief };
    const queued = maybeQueueRunStart(run, startOptions);
    if (queued) return res.json({ ok: true, ...queued, run });
    const pipeline = startPipeline(run, startOptions);
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
    runQueued: runQueuePending.length,
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

// 中途停止一個 run:先 set p.stopped(advancePipeline / stage guard 會 bail,唔再前進),
// 再 SIGTERM 晒佢所有 running agent 嘅 child(close handler 自己 cleanup)。
app.post('/api/runs/:id/stop', (req, res) => {
  const run = findRunOr404(req.params.id, res);
  if (!run) return;
  if (run.pipeline) run.pipeline.stopped = true;
  let killed = 0;
  for (const agent of (run.agents || [])) {
    const child = liveJobs.get(agent.id);
    if (child) { try { child.kill('SIGTERM'); killed += 1; } catch (_) {} }
  }
  run.status = 'stopped';
  addArtifact(run, { type: 'note', title: '⏹ 已停止 (Stop)', content: `手動停止:殺咗 ${killed} 個 running agent,pipeline 暫停前進。` });
  scheduleSave();
  io.emit('run-updated', publicRun(run));
  pumpRunQueue(run.projectPath);
  res.json({ ok: true, killed });
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
  notifyRunComplete(run, 'synthesis');
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

// SWARM_BIND=127.0.0.1 on the VPS: nginx fronts the dashboard (HTTPS + gate) and
// itself binds the public IP:3010 for the legacy-bookmark 301 — node must stay
// off the public interface or the two listeners collide (EADDRINUSE crash-loop).
const BIND_HOST = process.env.SWARM_BIND || '0.0.0.0';
server.listen(PORT, BIND_HOST, () => {
  console.log(`Swarm V3 dashboard server on http://${BIND_HOST}:${PORT}`);
  console.log(`[store] ${store.runs.length} saved runs; current=${store.currentRunId || 'none'}`);
  if (telegram.tgEnabled()) {
    require('./lib/telegram-bot').startBot({
      apiBase: `http://127.0.0.1:${PORT}`,
      chatId: process.env.TG_CHAT_ID,
      ownerUsers: (process.env.TG_OWNER_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
      allowedUsers: (process.env.TG_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
      log: (m) => console.log('[tg-bot]', m),
    });
  }
});
