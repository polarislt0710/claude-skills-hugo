// lib/perplexity-research.js — Perplexity research 核心（CommonJS，swarm-server + MCP server 共用）
// ─────────────────────────────────────────────────────────────────
// B 模式：swarm-server 喺 council「開始拗」收集三模角度後，直接 call runResearch 一次（集中）。
// MCP server（mcp/perplexity-research.mjs）亦 import 呢個 lib，避免兩份邏輯 drift。
//
// runResearch(query, angles, opts) → { ok, capped?, text?, citations?[], used, budget, estCost?, model, error? }
//   opts（全部可由 env fallback）：apiKey / runId / budget / model / maxTokens / logDir
//   budget：每個 runId（用 logDir 嘅 calls.jsonl 行數）全局 cap，超咗回 { ok:false, capped:true }。

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = [
  '你係三模議會嘅 research 助理。三模議會開會傾完之後，會傳俾你一條 query 加上佢哋夾出嚟、想你逐個覆蓋嘅角度（angles）。',
  '你嘅工作：上網搵最新、準確嘅資料，嚴格按住佢哋指定嘅角度逐個深入。',
  '要求：',
  '- 如果有提供 angles：每個角度獨立一節，用該角度做小標題，逐個落力搵料；唔好自把自為另開議會冇提嘅大方向（補充細節就 OK）。',
  '- 如果冇提供 angles：先自己判斷最相關嘅 4-6 個面向，再逐個寫。',
  '- 目標 3000-5000 字（繁體中文）；盡量充實，唔夠字唔緊要但唔好灌水交差。',
  '- 每個關鍵事實後面附 citation（URL 或來源名）。',
  '- 最前面寫一段 50 字內 TL;DR，之後結構化、用標題分段。',
  '- 唔好亂作；唔確定就明講「資料有限」，唔好當真。',
].join('\n');

function buildUserMsg(query, angles) {
  let u = `核心查詢：${query}`;
  if (Array.isArray(angles) && angles.length) {
    u += '\n\n議會夾出、要你逐個覆蓋嘅角度：\n' + angles.map((a, i) => `${i + 1}. ${String(a).trim()}`).join('\n');
  }
  return u;
}

// 回 display string array（含 title — url），俾 caller 自己 join。
function fmtCitations(data) {
  const c = (data && (data.citations || data.search_results)) || [];
  if (!Array.isArray(c) || !c.length) return [];
  return c.slice(0, 20)
    .map((x) => (typeof x === 'string' ? x : `${x.title || ''}${x.url ? ` — ${x.url}` : ''}`.trim()))
    .filter(Boolean);
}

function usedCount(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => {
      if (!l.trim()) return false;
      try { return !JSON.parse(l).error; } catch (_) { return false; }
    }).length;
  } catch (_) { return 0; }
}

async function runResearch(query, angles, opts = {}) {
  const apiKey = opts.apiKey || process.env.PERPLEXITY_API_KEY || '';
  const runId = opts.runId || process.env.COUNCIL_RUN_ID || 'adhoc';
  const budget = opts.budget != null ? opts.budget : (parseInt(process.env.PPLX_BUDGET || '5', 10) || 5);
  const model = opts.model || process.env.PPLX_MODEL || 'sonar';
  const maxTokens = opts.maxTokens || parseInt(process.env.PPLX_MAX_TOKENS || '8000', 10) || 8000;
  const logDir = opts.logDir || process.env.PPLX_LOG_DIR || path.join('/tmp', `pplx-${runId}`);
  const logFile = path.join(logDir, 'perplexity-calls.jsonl');
  const cleanAngles = Array.isArray(angles) ? angles.map((a) => String(a || '').trim()).filter(Boolean) : [];

  if (!apiKey) return { ok: false, error: 'PERPLEXITY_API_KEY 未設定', model, budget, used: 0 };
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '冇提供 query', model, budget, used: 0 };

  const used = usedCount(logFile);
  if (used >= budget) return { ok: false, capped: true, used, budget, model, error: `已用滿 ${used}/${budget}` };

  const log = (rec) => { try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch (_) {} };

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMsg(q, cleanAngles) }],
      }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Perplexity API ${res.status}: ${t.slice(0, 300)}`); }
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '（空白回覆）';
    const usage = data.usage || {};
    const inT = usage.prompt_tokens || 0, outT = usage.completion_tokens || 0;
    const estCost = ((inT + outT) / 1e6) * 1 + 0.005; // sonar base 粗估
    log({ ts: new Date().toISOString(), model, query: q, angles: cleanAngles, in: inT, out: outT, estUsd: Number(estCost.toFixed(4)) });
    return { ok: true, text, citations: fmtCitations(data), used: used + 1, budget, estCost, model };
  } catch (e) {
    log({ ts: new Date().toISOString(), model, query: q, angles: cleanAngles, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e), model, budget, used };
  }
}

module.exports = { runResearch, buildUserMsg, fmtCitations, SYSTEM_PROMPT };
