#!/usr/bin/env node
// Perplexity Research — 薄 proxy MCP（stdio JSON-RPC 2.0）
// ─────────────────────────────────────────────────────────────────
// 核心邏輯喺 ../lib/perplexity-research.js（同 swarm-server 共用，唔會 drift）。呢個檔淨係 MCP 殼。
// 用途：CLI 手動 / 將來「每模自己 call」(A 模式)。B 模式（集中）swarm-server 直接 call lib，唔經呢度。
//
// Env：PERPLEXITY_API_KEY(必須) / COUNCIL_RUN_ID / PPLX_BUDGET(5) / PPLX_MODEL(sonar) / PPLX_MAX_TOKENS(8000) / PPLX_LOG_DIR

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runResearch } = require('../lib/perplexity-research.js');

const BUDGET = parseInt(process.env.PPLX_BUDGET || '5', 10) || 5;

const TOOL = {
  name: 'research',
  description:
    '上網做深度 research（Perplexity）。淨係喺議會需要最新／外部事實先能繼續嗰陣先用 —— ' +
    '例如某科目或考卷嘅結構、課程大綱、評核準則、政策，或者任何你 training 之後先出現嘅嘢。' +
    '用法：先喺議會夾清楚「要查咩」同「想覆蓋邊幾個角度」，再將佢哋作為 angles 一齊傳入，' +
    'Perplexity 會逐個角度深入。唔需要查證嘅嘢唔好 call，慳 quota。' +
    `本議會全局最多 ${BUDGET} 次，call 之前諗清楚最值得問嘅一條。`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '議會要查嘅核心問題（越具體越好）' },
      angles: {
        type: 'array',
        items: { type: 'string' },
        description: '議會開會後夾出嚟、想 Perplexity 逐個覆蓋嘅角度／子問題，每個一句。研究會嚴格按呢啲角度分節去搵。',
      },
    },
    required: ['query'],
  },
};

async function handleResearch(args) {
  const r = await runResearch(args && args.query, args && args.angles, {});
  if (!r.ok) {
    const msg = r.capped
      ? `❌ 本議會 research 已用滿 ${r.used}/${r.budget} 次，唔再上網。請用手上已有資料同判斷繼續。`
      : `❌ research ${r.error && r.error.includes('未設定') ? '無法使用' : '失敗'}：${r.error}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
  const cites = (r.citations && r.citations.length)
    ? '\n\n──────── 來源 ────────\n' + r.citations.map((u, i) => `[${i + 1}] ${u}`).join('\n') : '';
  const footer = `\n\n_[research ${r.used}/${r.budget} · ${r.model} · ~$${r.estCost.toFixed(3)}]_`;
  return { content: [{ type: 'text', text: r.text + cites + footer }] };
}

// ─── JSON-RPC 2.0 over stdio（newline-delimited）───
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'perplexity-research', version: '1.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notification，冇 reply
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    if (!params || params.name !== 'research') return replyErr(id, -32602, `未知 tool：${params && params.name}`);
    return reply(id, await handleResearch(params.arguments || {}));
  }
  if (method === 'ping') return reply(id, {});
  if (id !== undefined) return replyErr(id, -32601, `未支援 method：${method}`);
}

let buf = '';
let pending = 0;          // in-flight request 數;stdin EOF 後要等佢哋完成先 exit
let stdinEnded = false;
function maybeExit() { if (stdinEnded && pending === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    pending++;
    Promise.resolve(handle(msg))
      .catch((e) => { if (msg && msg.id !== undefined) replyErr(msg.id, -32603, String(e.message || e)); })
      .finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
