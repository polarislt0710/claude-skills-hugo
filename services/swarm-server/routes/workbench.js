// Swarm Workbench（溝通工作台）router — threads / 檔案上載 / URL 抓取 / report 編輯 /
// Followup Copilot（提案 → confirm）/ autopilot。
//
// Factory：server.js 注入 deps（store 係 let 所以要 getter；其餘 thunk 包住）。
// Threads persist 喺 DATA_DIR/workbench/threads/ 逐檔一 JSON（automation-sessions 前例）—
// 特登唔入主 store：loadStore 只認 {version,currentRunId,runs}，塞入去 restart 會靜靜丟失。
// Run-scoped 嘢（workbenchFiles / followupProposal / copilot / autopilot / artifact.revisions）
// 落 run object 經 scheduleSave 行主 store。
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const dns = require('dns');

const MAX_THREADS = 40;
const MAX_MSGS = 80;
const MAX_MSG_CHARS = 12000;
const MAX_FILES_THREAD = 40;
const MAX_FILES_RUN = 20;
const MAX_REVISIONS = 3;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;

module.exports = function createWorkbench(deps) {
  const {
    io, DATA_DIR, getStore, scheduleSave, truncate, id,
    findRunOr404, addArtifact, publicRun,
    writeCouncilPlan, readLatestPlan, generateNextSteps,
    startFollowupAction, tgNotify, tgEsc, MAX_LOG_CHARS,
  } = deps;

  const router = express.Router();
  const THREAD_DIR = path.join(DATA_DIR, 'workbench', 'threads');
  const UPLOAD_ROOT = path.join(DATA_DIR, 'workbench-uploads');
  try { fs.mkdirSync(THREAD_DIR, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

  // ─── Threads（Map + 逐檔 persist，boot 時載入、壞檔 skip）───
  const threads = new Map();
  (function loadThreads() {
    try {
      for (const f of fs.readdirSync(THREAD_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const t = JSON.parse(fs.readFileSync(path.join(THREAD_DIR, f), 'utf8'));
          if (t && t.id) threads.set(t.id, t);
        } catch (e) { console.warn('[workbench] skip bad thread file', f, e.message); }
      }
      console.log(`[workbench] loaded ${threads.size} thread(s)`);
    } catch (e) { console.warn('[workbench] loadThreads:', e.message); }
  })();
  const threadFile = (tid) => path.join(THREAD_DIR, `${String(tid).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  const saveThread = (t) => {
    t.updatedAt = new Date().toISOString();
    try { fs.writeFile(threadFile(t.id), JSON.stringify(t), () => {}); } catch (_) {}
  };
  const threadSummary = (t) => ({
    id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt,
    msgCount: (t.messages || []).length, fileCount: (t.files || []).length,
  });

  router.get('/threads', (req, res) => {
    const list = [...threads.values()].map(threadSummary)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ ok: true, threads: list });
  });

  router.post('/threads', (req, res) => {
    if (threads.size >= MAX_THREADS) return res.status(409).json({ error: `對話上限 ${MAX_THREADS} 個 — 刪走啲舊嘅先` });
    const now = new Date().toISOString();
    const t = { id: id('th'), title: String((req.body || {}).title || '新對話').slice(0, 80), createdAt: now, updatedAt: now, messages: [], files: [] };
    threads.set(t.id, t);
    saveThread(t);
    res.json({ ok: true, thread: t });
  });

  router.get('/threads/:id', (req, res) => {
    const t = threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'thread 唔存在' });
    res.json({ ok: true, thread: t });
  });

  router.patch('/threads/:id', (req, res) => {
    const t = threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'thread 唔存在' });
    const title = String((req.body || {}).title || '').trim();
    if (!title) return res.status(400).json({ error: '要俾 title' });
    t.title = title.slice(0, 80);
    saveThread(t);
    res.json({ ok: true, thread: threadSummary(t) });
  });

  router.delete('/threads/:id', (req, res) => {
    const t = threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'thread 唔存在' });
    threads.delete(t.id);
    // uploads 特登留低 — run context 可能仲引用緊啲絕對路徑
    try { fs.unlinkSync(threadFile(t.id)); } catch (_) {}
    res.json({ ok: true });
  });

  router.post('/threads/:id/messages', (req, res) => {
    const t = threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'thread 唔存在' });
    const body = req.body || {};
    const role = String(body.role || '');
    if (!['user', 'assistant'].includes(role)) return res.status(400).json({ error: 'role 要係 user / assistant' });
    const msg = {
      id: id('wm'),
      role,
      content: String(body.content || '').slice(0, MAX_MSG_CHARS),
      model: body.model ? String(body.model).slice(0, 60) : undefined,
      action: body.action && body.action.type ? { type: String(body.action.type).slice(0, 20), arg: String(body.action.arg || '').slice(0, 3000) } : undefined,
      files: Array.isArray(body.files) ? body.files.map((f) => String(f).slice(0, 120)).slice(0, 8) : undefined,
      ts: new Date().toISOString(),
    };
    t.messages = t.messages || [];
    t.messages.push(msg);
    while (t.messages.length > MAX_MSGS) t.messages.shift();
    saveThread(t);
    res.json({ ok: true, message: msg });
  });

  // ─── 檔案上載（raw body — express.json 係 Content-Type gated，互不干擾）───
  const safeName = (raw) => {
    let n = path.basename(String(raw || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    if (!n || n === '.' || n === '..') n = 'file';
    return n;
  };
  // svg/json/csv 一律 text/plain 送返 — 防 same-origin XSS（svg 內嵌 script）。
  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf',
    csv: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
    json: 'text/plain; charset=utf-8', svg: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  };
  const mimeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

  router.post('/upload', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
    const threadId = req.query.threadId ? String(req.query.threadId) : null;
    const runId = req.query.runId ? String(req.query.runId) : null;
    if (!!threadId === !!runId) return res.status(400).json({ error: '要指定 threadId 或 runId（二揀一）' });
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: '冇檔案內容（要 raw body POST）' });
    let thread = null; let run = null;
    if (threadId) {
      thread = threads.get(threadId);
      if (!thread) return res.status(404).json({ error: 'thread 唔存在' });
      if ((thread.files || []).length >= MAX_FILES_THREAD) return res.status(409).json({ error: `一個對話最多 ${MAX_FILES_THREAD} 個檔` });
    } else {
      run = (getStore().runs || []).find((r) => r.id === runId);
      if (!run) return res.status(404).json({ error: 'run 唔存在' });
      run.workbenchFiles = Array.isArray(run.workbenchFiles) ? run.workbenchFiles : [];
      if (run.workbenchFiles.length >= MAX_FILES_RUN) return res.status(409).json({ error: `一個 run 最多 ${MAX_FILES_RUN} 個檔` });
    }
    const dirKey = threadId ? threadId.replace(/[^a-zA-Z0-9_-]/g, '_') : `run-${runId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const dir = path.join(UPLOAD_ROOT, dirKey);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const name = safeName(req.query.name);
    const abs = path.join(dir, `${Date.now()}-${name}`);
    try { fs.writeFileSync(abs, bytes); } catch (e) { return res.status(500).json({ error: `寫檔失敗:${e.message}` }); }
    const entry = { name, size: bytes.length, mime: mimeOf(name), path: abs, ts: new Date().toISOString() };
    if (thread) { thread.files = thread.files || []; thread.files.push(entry); saveThread(thread); }
    else { run.workbenchFiles.push(entry); run.updatedAt = entry.ts; scheduleSave(); }
    io.emit('workbench-file-added', { threadId, runId, file: entry });
    res.json({ ok: true, file: entry });
  });

  router.get('/file', (req, res) => {
    let real;
    try { real = fs.realpathSync(String(req.query.path || '')); } catch (_) { return res.status(404).json({ error: '檔案唔存在' }); }
    let rootReal;
    try { rootReal = fs.realpathSync(UPLOAD_ROOT); } catch (_) { return res.status(500).json({ error: 'uploads dir 唔存在' }); }
    if (!real.startsWith(rootReal + path.sep)) return res.status(403).json({ error: '只可以攞 workbench-uploads 入面嘅檔' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mimeOf(real));
    fs.createReadStream(real).on('error', () => res.status(500).end()).pipe(res);
  });

  // ─── URL 抓取（SSRF-guarded：DNS 解析後 IP 過 private/本機 filter，redirect 每跳重驗）───
  const LOCAL_ADDRS = new Set();
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const a of ifaces || []) LOCAL_ADDRS.add(a.address);
    }
  } catch (_) {}
  function isPrivateIp(ip) {
    if (!ip) return true;
    if (ip.includes(':')) {
      const low = ip.toLowerCase();
      if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
      return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
    }
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  function fetchUrl(rawUrl, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(rawUrl); } catch (_) { return reject(new Error('URL 無效')); }
      if (!/^https?:$/.test(u.protocol)) return reject(new Error('只支援 http / https'));
      if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return reject(new Error('內部位址唔俾抓（SSRF guard）'));
      dns.lookup(u.hostname, (err, ip) => {
        if (err) return reject(new Error(`DNS 解析失敗:${err.message}`));
        if (isPrivateIp(ip) || LOCAL_ADDRS.has(ip)) return reject(new Error('內部/私有位址唔俾抓（SSRF guard）'));
        const mod = u.protocol === 'https:' ? https : http;
        const r2 = mod.get(u, { timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'swarm-workbench/1.0', Accept: 'text/html,text/plain,application/json,*/*' } }, (r) => {
          if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
            r.resume();
            if (redirectsLeft <= 0) return reject(new Error('redirect 太多'));
            let next;
            try { next = new URL(r.headers.location, u).toString(); } catch (_) { return reject(new Error('redirect 目標無效')); }
            return resolve(fetchUrl(next, redirectsLeft - 1));
          }
          if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode}`)); }
          let size = 0; const chunks = [];
          r.on('data', (c) => {
            size += c.length;
            if (size > FETCH_MAX_BYTES) { r2.destroy(); reject(new Error('內容超過 2MB')); return; }
            chunks.push(c);
          });
          r.on('end', () => resolve({ url: u.toString(), contentType: String(r.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
          r.on('error', reject);
        });
        r2.on('timeout', () => { r2.destroy(); reject(new Error('timeout（15s）')); });
        r2.on('error', reject);
      });
    });
  }
  function stripHtml(html) {
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }

  router.post('/fetch-url', async (req, res) => {
    const body = req.body || {};
    const rawUrl = String(body.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: '要俾 url' });
    const threadId = body.threadId ? String(body.threadId) : null;
    const runId = body.runId ? String(body.runId) : null;
    if (!!threadId === !!runId) return res.status(400).json({ error: '要指定 threadId 或 runId（二揀一）' });
    let thread = null; let run = null;
    if (threadId) {
      thread = threads.get(threadId);
      if (!thread) return res.status(404).json({ error: 'thread 唔存在' });
    } else {
      run = (getStore().runs || []).find((r) => r.id === runId);
      if (!run) return res.status(404).json({ error: 'run 唔存在' });
      run.workbenchFiles = Array.isArray(run.workbenchFiles) ? run.workbenchFiles : [];
    }
    let fetched;
    try { fetched = await fetchUrl(rawUrl); } catch (e) { return res.status(400).json({ error: `抓取失敗:${e.message}` }); }
    const isHtml = /html/i.test(fetched.contentType) || /^\s*<(!doctype|html)/i.test(fetched.body);
    const text = isHtml ? stripHtml(fetched.body) : fetched.body;
    let host = 'page';
    try { host = new URL(fetched.url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_'); } catch (_) {}
    const dirKey = threadId ? threadId.replace(/[^a-zA-Z0-9_-]/g, '_') : `run-${runId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const dir = path.join(UPLOAD_ROOT, dirKey);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const name = safeName(`fetched-${host}.md`);
    const abs = path.join(dir, `${Date.now()}-${name}`);
    const doc = `# 抓取自 ${fetched.url}\n（${new Date().toISOString()} · ${fetched.contentType || 'unknown type'}）\n\n${text}`;
    try { fs.writeFileSync(abs, doc); } catch (e) { return res.status(500).json({ error: `寫檔失敗:${e.message}` }); }
    const entry = { name, size: Buffer.byteLength(doc, 'utf8'), mime: 'text/plain; charset=utf-8', path: abs, ts: new Date().toISOString(), sourceUrl: fetched.url };
    if (thread) { thread.files = thread.files || []; thread.files.push(entry); saveThread(thread); }
    else { run.workbenchFiles.push(entry); run.updatedAt = entry.ts; scheduleSave(); }
    io.emit('workbench-file-added', { threadId, runId, file: entry });
    res.json({ ok: true, file: entry, chars: text.length });
  });

  // ─── Report 編輯 ───
  router.patch('/runs/:id/artifacts/:artifactId', (req, res) => {
    const run = findRunOr404(req.params.id, res);
    if (!run) return;
    const art = (run.artifacts || []).find((a) => a.id === req.params.artifactId);
    if (!art) return res.status(404).json({ error: 'artifact 唔存在' });
    const body = req.body || {};
    const hasTitle = body.title !== undefined;
    const hasContent = body.content !== undefined;
    if (!hasTitle && !hasContent) return res.status(400).json({ error: '要俾 title 或 content' });
    art.revisions = Array.isArray(art.revisions) ? art.revisions : [];
    art.revisions.push({ title: art.title, content: art.content, editedAt: new Date().toISOString(), by: 'workbench' });
    while (art.revisions.length > MAX_REVISIONS) art.revisions.shift();
    if (hasTitle) art.title = String(body.title).slice(0, 200);
    if (hasContent) art.content = truncate(String(body.content), MAX_LOG_CHARS);
    art.editedAt = new Date().toISOString();
    art.editedBy = 'workbench';
    run.updatedAt = art.editedAt;
    scheduleSave();
    io.emit('artifact-updated', { runId: run.id, artifact: art });
    res.json({ ok: true, artifact: art });
  });

  router.post('/runs/:id/council-plan', (req, res) => {
    const run = findRunOr404(req.params.id, res);
    if (!run) return;
    const p = run.pipeline;
    if (!p) return res.status(400).json({ error: '呢個 run 冇 pipeline' });
    const latest = readLatestPlan(run) || { v: 0 };
    const base = Math.max(Number(p.councilPlanVersion || 0), Number(latest.v || 0));
    if (base < 1) return res.status(400).json({ error: '未有議會 plan 可以改（要議會出咗 v1 先）' });
    const cur = (p.stages || [])[p.current];
    if (cur && cur.status === 'running' && ['consensus', 'moderator'].includes(String(cur.kind))) {
      return res.status(409).json({ error: '議會收斂緊 — 等佢出咗呢個 round 先改' });
    }
    const md = String((req.body || {}).md || '').trim();
    if (!md) return res.status(400).json({ error: '要俾 plan 內容 (md)' });
    const note = String((req.body || {}).note || '').slice(0, 500);
    const v = base + 1;
    const stamped = `${truncate(md, MAX_LOG_CHARS)}\n\n> ✍️ 手改 v${v} via Workbench${note ? `：${note}` : ''}`;
    writeCouncilPlan(run, v, stamped);
    p.councilPlanVersion = v;
    addArtifact(run, { type: 'council-plan', title: `📜 Plan v${v}（手改）`, content: truncate(stamped, 4000) });
    scheduleSave();
    io.emit('run-updated', publicRun(run));
    res.json({ ok: true, version: v });
  });

  // ─── Followup Copilot：提案 confirm / dismiss + autopilot 開關 ───
  router.post('/runs/:id/proposal/confirm', (req, res) => {
    const run = findRunOr404(req.params.id, res);
    if (!run) return;
    const prop = run.followupProposal;
    if (!prop || prop.status !== 'pending') return res.status(400).json({ error: '冇待確認嘅跟進提案' });
    const body = req.body || {};
    const instruction = String(body.instruction || prop.draft || '').trim(); // 可以帶「傾過先」改完嘅版本
    const r = startFollowupAction(run, { instruction, review: true, cli: body.cli, model: body.model });
    if (r.status !== 200) return res.status(r.status).json(r.payload);
    prop.status = 'confirmed';
    prop.confirmedAt = new Date().toISOString();
    run.copilot = run.copilot || { roundsLeft: 3 };
    run.copilot.roundsLeft = Math.max(0, (run.copilot.roundsLeft != null ? run.copilot.roundsLeft : 3) - 1);
    scheduleSave();
    io.emit('followup-proposal', { runId: run.id, proposal: run.followupProposal });
    res.json({ ok: true, ...r.payload, roundsLeft: run.copilot.roundsLeft });
  });

  router.post('/runs/:id/proposal/dismiss', (req, res) => {
    const run = findRunOr404(req.params.id, res);
    if (!run) return;
    const prop = run.followupProposal;
    if (!prop || prop.status !== 'pending') return res.status(400).json({ error: '冇待處理嘅跟進提案' });
    prop.status = 'dismissed';
    prop.dismissedAt = new Date().toISOString();
    scheduleSave();
    io.emit('followup-proposal', { runId: run.id, proposal: run.followupProposal });
    res.json({ ok: true });
  });

  router.post('/runs/:id/autopilot', (req, res) => {
    const run = findRunOr404(req.params.id, res);
    if (!run) return;
    const body = req.body || {};
    // copilotRounds：對話式提案嘅剩餘輪數，可以由 UI / AI 建議調（0-5）。
    if (body.copilotRounds !== undefined) {
      run.copilot = run.copilot || {};
      run.copilot.roundsLeft = Math.min(5, Math.max(0, Number(body.copilotRounds) || 0));
    }
    if (body.enabled !== undefined) {
      const enabled = !!body.enabled;
      const maxRounds = Math.min(3, Math.max(1, Number(body.maxRounds || 3)));
      if (enabled && !(run.pipeline && String(run.pipeline.mode) === 'code')) {
        return res.status(400).json({ error: 'autopilot 只支援 code run（mission / 已落實嘅 council）' });
      }
      run.autopilot = {
        enabled,
        maxRounds,
        roundsUsed: enabled ? 0 : ((run.autopilot && run.autopilot.roundsUsed) || 0),
        failStreak: 0,
        lastFiredForSeq: null,
        stopped: !enabled,
        stopReason: enabled ? null : 'manual',
        updatedAt: new Date().toISOString(),
      };
      addArtifact(run, {
        type: 'note',
        title: enabled ? `🤖 Autopilot 開（≤${maxRounds} 輪）` : '🤖 Autopilot 關',
        content: enabled ? '完成後自動揀安全建議開跟進（followup+review+verify）;council / execute / push 照舊留人手。' : '',
      });
      io.emit('autopilot-status', { runId: run.id, autopilot: run.autopilot });
    }
    scheduleSave();
    res.json({ ok: true, autopilot: run.autopilot || null, copilot: run.copilot || null });
  });

  router.get('/health', (req, res) => res.json({ ok: true, threads: threads.size, uploadsDir: UPLOAD_ROOT }));

  // ─── Copilot / autopilot 狀態機（由 server.js advancePipeline 完成塊 hook 入）───
  // 永不 throw / reject — pipeline 完成流程唔可以俾 workbench 炸。
  function pickSafeAction(ns, verifyOk) {
    const gaps = (ns && ns.gaps) || [];
    const sugs = (ns && ns.suggestions) || [];
    const pool = verifyOk ? [...sugs, ...gaps] : [...gaps, ...sugs];
    // 安全集：只自動化 mission 類建議（轉做同 run followup）。council / execute / revise /
    // approve 全部係人手決策（御准文化），永遠唔自動。
    return pool.find((it) => it && it.action && it.action.type === 'mission' && it.action.arg) || null;
  }
  function proposalDraft(pick) {
    return [pick.title, '', pick.rationale || pick.detail || '', '', pick.action.arg]
      .join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3500);
  }

  async function copilotPropose(run, verifyOk) {
    run.copilot = run.copilot || { roundsLeft: 3 };
    const seq = run.pipelineSeq || 0;
    if (run.copilot.lastProposalForSeq === seq) return; // 同一條 pipeline 唔提兩次
    run.copilot.lastProposalForSeq = seq;
    if (run.copilot.roundsLeft <= 0) {
      addArtifact(run, { type: 'note', title: '🤝 Copilot：跟進輪數用晒', content: '想繼續：喺 Workbench 較返輪數（autopilot 設定入面 copilotRounds）。' });
      scheduleSave();
      return;
    }
    const ns = await generateNextSteps(run).catch(() => null);
    const pick = ns ? pickSafeAction(ns, verifyOk) : null;
    if (!pick) {
      addArtifact(run, { type: 'note', title: '🤝 Copilot：今輪冇可自動跟進嘅建議', content: '下一步建議屬 council / execute 類 — 要你人手決定。' });
      scheduleSave();
      io.emit('followup-proposal', { runId: run.id, proposal: null });
      return;
    }
    run.followupProposal = {
      id: id('prop'),
      title: String(pick.title || '').slice(0, 160),
      source: pick.severity ? 'gap' : 'suggestion',
      draft: proposalDraft(pick),
      roundsLeft: run.copilot.roundsLeft,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    scheduleSave();
    addArtifact(run, { type: 'note', title: `🤝 Copilot 跟進提案（剩 ${run.copilot.roundsLeft} 輪）`, content: run.followupProposal.draft });
    io.emit('followup-proposal', { runId: run.id, proposal: run.followupProposal });
    tgNotify(`🤝 *Copilot 跟進提案* · ${tgEsc(run.topic)}\n\n${tgEsc(run.followupProposal.title)}\n\n去 Workbench 撳 ✅ 照做 / ✍️ 傾過先；Telegram 都可以 reply 完成通知直接打指示。`, null, run.tgChatId);
  }

  async function autopilotStep(run, verifyOk) {
    const ap = run.autopilot;
    const seq = run.pipelineSeq || 0;
    if (ap.lastFiredForSeq === seq) return; // dedupe 同一條 pipeline
    const stop = (reason) => {
      ap.enabled = false; ap.stopped = true; ap.stopReason = reason; ap.updatedAt = new Date().toISOString();
      scheduleSave();
      addArtifact(run, { type: 'note', title: `🤖 Autopilot 停：${reason}`, content: `roundsUsed=${ap.roundsUsed || 0}/${ap.maxRounds || 3}` });
      io.emit('autopilot-status', { runId: run.id, autopilot: ap });
      tgNotify(`🤖 *Autopilot 停*（${reason}）· ${tgEsc(run.topic)}`, null, run.tgChatId);
    };
    ap.failStreak = verifyOk ? 0 : (ap.failStreak || 0) + 1;
    if (ap.failStreak >= 2) return stop('verify_fail_streak');
    if ((ap.roundsUsed || 0) >= (ap.maxRounds || 3)) return stop('rounds_exhausted');
    if (run.pendingPush && run.pendingPush.status === 'pushing') return stop('push_in_progress');
    const ns = await generateNextSteps(run).catch(() => null);
    const pick = ns ? pickSafeAction(ns, verifyOk) : null;
    if (!pick) return stop('no_safe_action');
    ap.lastFiredForSeq = seq; // 響 fire 之前記低今次完成嘅 seq
    const instruction = `[autopilot 第${(ap.roundsUsed || 0) + 1}輪] ${proposalDraft(pick)}`.slice(0, 3800);
    let r = startFollowupAction(run, { instruction, review: true });
    if (!r || r.status !== 200) {
      await new Promise((rs) => setTimeout(rs, 5000)); // lockRun TTL 2.5s — 等陣再試一次
      r = startFollowupAction(run, { instruction, review: true });
    }
    if (!r || r.status !== 200) return stop('action_error');
    ap.roundsUsed = (ap.roundsUsed || 0) + 1;
    ap.updatedAt = new Date().toISOString();
    scheduleSave();
    io.emit('autopilot-status', { runId: run.id, autopilot: ap });
    tgNotify(`🤖 *Autopilot 第${ap.roundsUsed}輪開波* · ${tgEsc(run.topic)}\n${tgEsc(pick.title)}`, null, run.tgChatId);
  }

  async function onPipelineComplete(run, verifyOk) {
    try {
      if (!run || !run.pipeline || String(run.pipeline.mode) !== 'code') return;
      if (run.autopilot && run.autopilot.enabled) return await autopilotStep(run, verifyOk);
      return await copilotPropose(run, verifyOk);
    } catch (e) {
      console.warn('[workbench] onPipelineComplete:', e && e.message);
    }
  }

  return { router, onPipelineComplete };
};
