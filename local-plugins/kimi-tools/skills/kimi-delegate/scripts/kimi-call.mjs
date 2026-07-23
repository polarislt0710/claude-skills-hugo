#!/usr/bin/env node
// kimi-call.mjs — one-shot Kimi (k3-thinking via proxy) caller with auto-reconnect.
// Credentials: ~/.kimi_secrets (KIMI_API_URL / KIMI_API_KEY / KIMI_MODEL), never logged.
// Designed for Hugo's proxy quirks: slow responses, frequent disconnects, thinking model
// (reasoning consumes completion tokens before content appears).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRETS = join(homedir(), '.kimi_secrets');

function loadSecrets() {
  let raw;
  try { raw = readFileSync(SECRETS, 'utf8'); }
  catch { fail(1, `搵唔到 ${SECRETS} — 請 Hugo 補返（KIMI_API_URL / KIMI_API_KEY / KIMI_MODEL 三行）。`); }
  const v = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) v[m[1]] = m[2].trim();
  }
  if (!v.KIMI_API_URL || !v.KIMI_API_KEY) fail(1, `${SECRETS} 缺 KIMI_API_URL 或 KIMI_API_KEY。`);
  return v;
}

function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

function parseArgs(argv) {
  const opt = { maxTokens: 8000, timeoutMs: 300000, retries: 3, temperature: null, system: null, stdin: false, json: false, showReasoning: false, prompt: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-tokens') opt.maxTokens = Number(argv[++i]);
    else if (a === '--timeout-ms') opt.timeoutMs = Number(argv[++i]);
    else if (a === '--retries') opt.retries = Number(argv[++i]);
    else if (a === '--temperature') opt.temperature = Number(argv[++i]);
    else if (a === '--system') opt.system = argv[++i];
    else if (a === '--stdin') opt.stdin = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--show-reasoning') opt.showReasoning = true;
    else rest.push(a);
  }
  opt.prompt = rest.join(' ').trim();
  return opt;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(secrets, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(`${secrets.KIMI_API_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.KIMI_API_KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`invalid JSON from proxy: ${text.slice(0, 200)}`); }
    return data;
  } finally { clearTimeout(timer); }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const secrets = loadSecrets();
  let userContent = opt.prompt;
  if (opt.stdin) {
    const piped = await readStdin();
    userContent = userContent ? `${userContent}\n\n${piped}` : piped;
  }
  if (!userContent.trim()) fail(1, '冇 prompt。用法：kimi-call.mjs [--system S] [--max-tokens N] [--stdin] "任務"');

  const messages = [];
  if (opt.system) messages.push({ role: 'system', content: opt.system });
  messages.push({ role: 'user', content: userContent });
  const body = { model: secrets.KIMI_MODEL || 'kimi-k3-thinking', messages, max_tokens: opt.maxTokens };
  if (opt.temperature != null && Number.isFinite(opt.temperature)) body.temperature = opt.temperature;

  let lastErr = null;
  for (let attempt = 0; attempt <= opt.retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));
      process.stderr.write(`[kimi] 斷咗/失敗（${String(lastErr && lastErr.message || lastErr).slice(0, 120)}）— ${backoff / 1000}s 後重駁（第 ${attempt}/${opt.retries} 次）\n`);
      await sleep(backoff);
    }
    try {
      const data = await callOnce(secrets, body, opt.timeoutMs);
      const choice = data.choices && data.choices[0];
      const msg = choice && choice.message;
      const content = (msg && msg.content || '').trim();
      const reasoning = (msg && msg.reasoning_content || '').trim();
      const finish = choice && choice.finish_reason;
      if (opt.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
      if (!content && finish === 'length') {
        lastErr = new Error(`empty content, finish=length — thinking 食晒 ${opt.maxTokens} tokens，請加大 --max-tokens`);
        if (attempt < opt.retries) { body.max_tokens = Math.min(body.max_tokens * 2, 32000); continue; }
        fail(2, String(lastErr.message));
      }
      if (opt.showReasoning && reasoning) process.stdout.write(`--- reasoning ---\n${reasoning}\n--- answer ---\n`);
      process.stdout.write((content || '(空回應)') + '\n');
      if (data.usage) process.stderr.write(`[kimi] tokens: ${data.usage.total_tokens} (prompt ${data.usage.prompt_tokens} + completion ${data.usage.completion_tokens}) · backend: ${data.model || 'unknown'}\n`);
      return;
    } catch (e) { lastErr = e; }
  }
  fail(2, `Kimi 重試 ${opt.retries} 次都失敗：${String(lastErr && lastErr.message || lastErr).slice(0, 300)}`);
}

main().catch((e) => fail(2, String(e && e.message || e)));
