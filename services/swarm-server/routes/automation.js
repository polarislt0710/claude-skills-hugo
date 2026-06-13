const express = require('express');
const fs = require('fs');
const path = require('path');
const { callClaude } = require('../lib/claude-cli');
const cronicle = require('../lib/cronicle-client');
const { toCronicleTiming, toCronPreview } = require('../lib/schedule-to-cronicle');

const router = express.Router();

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'automation-designer-system.md'),
  'utf8'
);

const MAX_HISTORY_TURNS = 30;
const sessions = new Map();

// ─── Persistence ──────────────────────────────────────────────────────
// Sessions saved to disk so swarm-server restart doesn't lose chats.
const SESSION_DIR = path.join(__dirname, '..', 'data', 'automation-sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}

function sessionFile(id) {
  return path.join(SESSION_DIR, id.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
}

function loadSessionsFromDisk() {
  try {
    const files = fs.readdirSync(SESSION_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8');
        const data = JSON.parse(raw);
        if (data && data.id) sessions.set(data.id, data);
      } catch (e) {
        console.warn('[automation] skip bad session file', f, e.message);
      }
    }
    console.log('[automation] loaded', sessions.size, 'session(s) from disk');
  } catch (e) {
    console.warn('[automation] loadSessionsFromDisk failed:', e.message);
  }
}

function saveSession(session) {
  try {
    fs.writeFile(sessionFile(session.id), JSON.stringify(session), () => {});
  } catch {}
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, history: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(id, s);
  }
  return s;
}

loadSessionsFromDisk();

function buildPrompt(history, userMessage) {
  const lines = [SYSTEM_PROMPT.trim(), '', '---', '', '# Conversation', ''];
  for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
    lines.push(turn.role === 'user' ? `Hugo: ${turn.content}` : `You: ${turn.content}`);
    lines.push('');
  }
  lines.push(`Hugo: ${userMessage}`);
  lines.push('');
  lines.push('Respond now as the Automation Designer. Follow the output protocol exactly.');
  return lines.join('\n');
}

function extractSpec(text) {
  const match = text.match(/```spec\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  const raw = match[1].trim();
  try {
    return { ok: true, spec: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, parseError: e.message, raw };
  }
}

router.post('/api/chat', async (req, res) => {
  const { session_id, message } = req.body || {};
  if (!session_id || !message) {
    return res.status(400).json({ error: 'session_id and message required' });
  }

  const session = getSession(session_id);
  const prompt = buildPrompt(session.history, message);

  try {
    const response = await callClaude(prompt);
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: response });
    session.updatedAt = Date.now();
    saveSession(session);
    const specResult = extractSpec(response);
    res.json({
      session_id,
      message: response,
      spec: specResult && specResult.ok ? specResult.spec : null,
      spec_error: specResult && !specResult.ok ? specResult.parseError : null,
    });
  } catch (e) {
    console.error('[automation/chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/reset', (req, res) => {
  const { session_id } = req.body || {};
  if (session_id) {
    sessions.delete(session_id);
    try { fs.unlinkSync(sessionFile(session_id)); } catch {}
  }
  res.json({ ok: true });
});

router.get('/api/history/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  res.json({ id: req.params.id, history: s ? s.history : [], createdAt: s ? s.createdAt : null });
});

router.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.values())
    .map((s) => {
      const firstUser = s.history.find((t) => t.role === 'user');
      return {
        id: s.id,
        createdAt: s.createdAt || 0,
        updatedAt: s.updatedAt || s.createdAt || 0,
        turns: s.history.length,
        preview: firstUser ? firstUser.content.slice(0, 80) : '(empty)',
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
  res.json({ sessions: list });
});

router.post('/api/save', async (req, res) => {
  if (!cronicle.hasKey()) {
    return res.status(500).json({ error: 'CRONICLE_API_KEY not set in ~/services/swarm-server/.env' });
  }
  const { name, description, shell_script, schedule, category, notify_fail } = req.body || {};
  if (!name || !shell_script || !schedule) {
    return res.status(400).json({ error: 'name, shell_script, schedule required' });
  }

  let timing;
  try {
    timing = toCronicleTiming(schedule);
  } catch (e) {
    return res.status(400).json({ error: `bad schedule: ${e.message}` });
  }

  const event = {
    title: name,
    enabled: 1,
    category: category || 'general',
    target: 'main',
    plugin: 'shellplug',
    params: { script: shell_script },
    timing,
    timezone: schedule.timezone || 'Asia/Hong_Kong',
    notify_fail: notify_fail || 'polarislt0710@gmail.com',
    notes: description || '',
  };

  try {
    const result = await cronicle.createEvent(event);
    res.json({ ok: true, id: result.id, cron_preview: toCronPreview(timing) });
  } catch (e) {
    console.error('[automation/save]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/jobs', async (req, res) => {
  if (!cronicle.hasKey()) return res.json({ jobs: [], _warning: 'CRONICLE_API_KEY not set' });
  try {
    const result = await cronicle.listEvents();
    const jobs = (result.rows || result.events || []).map((r) => ({
      id: r.id,
      title: r.title,
      enabled: r.enabled,
      category: r.category,
      timing: r.timing,
      timezone: r.timezone,
      notes: r.notes,
      cron_preview: r.timing ? toCronPreview(r.timing) : '',
    }));
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/jobs/:id/run', async (req, res) => {
  try {
    const result = await cronicle.runEvent(req.params.id);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/jobs/:id', async (req, res) => {
  try {
    await cronicle.deleteEvent(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cronicle_key_set: cronicle.hasKey(),
    cronicle_url: process.env.CRONICLE_BASE_URL || 'http://127.0.0.1:3012',
    sessions: sessions.size,
  });
});

module.exports = router;
