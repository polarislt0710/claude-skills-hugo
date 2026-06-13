(() => {
  'use strict';

  const API = '/automation/api';
  const SESSION_KEY = 'automation-session-id';

  function getSessionId() {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  const state = {
    sessionId: getSessionId(),
    spec: null,
    schedule: {
      mode: 'daily',
      daily:   { hours: [9] },
      weekly:  { weekdays: [1, 3, 5], hours: [9] },
      monthly: { days: [1, 15], hours: [9] },
      yearly:  { months: [1], days: [1], hours: [9] },
      timezone: 'Asia/Hong_Kong',
    },
    saving: false,
    sending: false,
    abortController: null,
  };

  // ─── HELPERS ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderMarkdownLite(text) {
    // Strip spec blocks (rendered separately in spec card)
    text = text.replace(/```spec\s*[\s\S]*?```/g, '<div class="spec-pill">📋 Spec 生成 →</div>');
    // Code blocks
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    // Inline code
    text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return text;
  }

  // ─── CHAT ─────────────────────────────────────────────────────────────
  const chatMessages = $('#chat-messages');
  const chatInput = $('#chat-input');
  const sendBtn = $('#btn-send');
  const chatStatus = $('#chat-status');

  function addMessage(role, content, isHtml = false) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const body = document.createElement('div');
    body.className = 'msg-body';
    if (isHtml) {
      body.innerHTML = content;
    } else {
      body.textContent = content;
    }
    wrap.appendChild(body);
    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return wrap;
  }

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text || state.sending) return;          // hard guard against double-fire
    state.sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳';
    setCancelVisible(true);

    addMessage('user', text);
    chatInput.value = '';
    chatStatus.textContent = 'AI 諗緊… (撳「停」可取消)';
    const thinking = addMessage('ai', '⋯', false);
    thinking.classList.add('thinking');

    const controller = new AbortController();
    state.abortController = controller;

    try {
      const r = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, message: text }),
        signal: controller.signal,
      });
      const data = await r.json();
      thinking.remove();
      if (!r.ok) {
        addMessage('ai', '⚠ ' + (data.error || 'error'));
      } else {
        addMessage('ai', renderMarkdownLite(data.message), true);
        if (data.spec) {
          state.spec = data.spec;
          renderSpec(data.spec);
          updateSaveButton();
        } else if (data.spec_error) {
          chatStatus.textContent = 'Spec parse error: ' + data.spec_error;
        }
      }
    } catch (e) {
      thinking.remove();
      if (e.name === 'AbortError') {
        addMessage('ai', '⏹ 已取消（提示：server 嘅 claude -p subprocess 會繼續跑直至完成或 timeout，下次 send 時答覆會排喺後面）');
      } else {
        addMessage('ai', '⚠ 網絡錯誤：' + e.message);
      }
    } finally {
      state.sending = false;
      state.abortController = null;
      sendBtn.disabled = false;
      sendBtn.textContent = '發送';
      setCancelVisible(false);
      chatStatus.textContent = '';
      chatInput.focus();
    }
  }

  function setCancelVisible(visible) {
    const btn = $('#btn-cancel');
    if (btn) btn.style.display = visible ? 'inline-flex' : 'none';
  }

  sendBtn.addEventListener('click', sendChat);

  const cancelBtn = $('#btn-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (state.abortController) state.abortController.abort();
    });
  }

  chatInput.addEventListener('keydown', (e) => {
    // Block IME composition Enter (Chinese / Japanese / Korean input)
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });

  $('#btn-new').addEventListener('click', async () => {
    if (!confirm('新一個 automation？而家對話會清（之前嗰個已自動 save，撳「Sessions」可以揾返）。')) return;
    sessionStorage.removeItem(SESSION_KEY);
    location.reload();
  });

  // ─── HISTORY + SESSIONS ───────────────────────────────────────────────
  async function loadHistory() {
    try {
      const r = await fetch(API + '/history/' + encodeURIComponent(state.sessionId));
      if (!r.ok) return;
      const data = await r.json();
      if (!data.history || data.history.length === 0) return;

      // Wipe greeting and replay
      chatMessages.innerHTML = '';
      for (const turn of data.history) {
        if (turn.role === 'user') {
          addMessage('user', turn.content);
        } else {
          addMessage('ai', renderMarkdownLite(turn.content), true);
        }
      }
      // Re-extract spec from last assistant message that contains one
      for (let i = data.history.length - 1; i >= 0; i--) {
        const t = data.history[i];
        if (t.role !== 'assistant') continue;
        const m = t.content.match(/```spec\s*\n([\s\S]*?)\n```/);
        if (m) {
          try {
            const spec = JSON.parse(m[1].trim());
            state.spec = spec;
            renderSpec(spec);
            updateSaveButton();
            break;
          } catch {}
        }
      }
      chatStatus.textContent = '✓ 載入返 ' + (data.history.length / 2 | 0) + ' 個 turn';
      setTimeout(() => { chatStatus.textContent = ''; }, 3000);
    } catch (e) {
      console.warn('loadHistory failed:', e);
    }
  }

  function fmtRelTime(ts) {
    if (!ts) return '';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return Math.round(diff) + 's ago';
    if (diff < 3600) return Math.round(diff / 60) + 'm ago';
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
    return Math.round(diff / 86400) + 'd ago';
  }

  async function openSessionsPanel() {
    const overlay = document.createElement('div');
    overlay.className = 'sessions-overlay';
    overlay.innerHTML = `
      <div class="sessions-modal">
        <div class="sessions-header">
          <span>🗂 Sessions (近 50 條)</span>
          <button class="ghost small" id="sessions-close">✕</button>
        </div>
        <div class="sessions-list" id="sessions-list">
          <div class="placeholder">Loading…</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    $('#sessions-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    try {
      const r = await fetch(API + '/sessions');
      const data = await r.json();
      const list = $('#sessions-list');
      if (!data.sessions || data.sessions.length === 0) {
        list.innerHTML = '<div class="placeholder">未有任何過往 session。</div>';
        return;
      }
      list.innerHTML = data.sessions
        .map(
          (s) => `
            <div class="session-row${s.id === state.sessionId ? ' current' : ''}" data-id="${escapeHtml(s.id)}">
              <div class="session-preview">${escapeHtml(s.preview || '(empty)')}${s.id === state.sessionId ? ' <span class="badge on">current</span>' : ''}</div>
              <div class="session-meta">
                <span class="mono small">${escapeHtml(s.id)}</span>
                <span class="muted small">${s.turns} turns · ${fmtRelTime(s.updatedAt)}</span>
              </div>
              <div class="session-actions">
                <button class="small" data-load="${escapeHtml(s.id)}">↩ 載入</button>
                <button class="small" data-del-sess="${escapeHtml(s.id)}">✕</button>
              </div>
            </div>`
        )
        .join('');
      list.querySelectorAll('[data-load]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.load;
          sessionStorage.setItem(SESSION_KEY, id);
          location.reload();
        });
      });
      list.querySelectorAll('[data-del-sess]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('刪呢個 session？')) return;
          await fetch(API + '/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: btn.dataset.delSess }),
          });
          btn.closest('.session-row').remove();
        });
      });
    } catch (e) {
      $('#sessions-list').innerHTML = '<div class="placeholder">⚠ ' + escapeHtml(e.message) + '</div>';
    }
  }

  const btnSessions = $('#btn-sessions');
  if (btnSessions) btnSessions.addEventListener('click', openSessionsPanel);

  // ─── SPEC RENDER ──────────────────────────────────────────────────────
  function renderSpec(spec) {
    $('#spec-status').textContent = '✓ locked';
    $('#spec-status').style.color = 'var(--green)';
    const body = $('#spec-body');
    const stepsHtml = (spec.steps || [])
      .map(
        (s) =>
          `<li><div class="step-name">${escapeHtml(s.id ? s.id + '. ' : '')}${escapeHtml(s.name || '')}</div>${
            s.cli ? `<code>${escapeHtml(s.cli)}</code>` : ''
          }${s.notes ? `<div class="muted small" style="margin-top:3px">${escapeHtml(s.notes)}</div>` : ''}</li>`
      )
      .join('');
    const hitlHtml = (spec.hitl_points || [])
      .map(
        (h) =>
          `<span class="spec-tag warn">HITL after step ${escapeHtml(h.after_step || '?')}: ${escapeHtml(h.type || '')}${
            h.description ? ' — ' + escapeHtml(h.description) : ''
          }</span>`
      )
      .join('');
    const secretsHtml = (spec.required_secrets || []).map((s) => `<span class="spec-tag">${escapeHtml(s)}</span>`).join('');

    body.innerHTML = `
      <div class="spec-field">
        <div class="spec-field-label">name</div>
        <div class="spec-field-value mono">${escapeHtml(spec.name || '(no name)')}</div>
      </div>
      <div class="spec-field">
        <div class="spec-field-label">description</div>
        <div class="spec-field-value">${escapeHtml(spec.description || '')}</div>
      </div>
      ${stepsHtml ? `<div class="spec-field"><div class="spec-field-label">steps</div><ul class="spec-steps">${stepsHtml}</ul></div>` : ''}
      ${hitlHtml ? `<div class="spec-field"><div class="spec-field-label">HITL points</div><div>${hitlHtml}</div></div>` : ''}
      ${secretsHtml ? `<div class="spec-field"><div class="spec-field-label">required secrets</div><div>${secretsHtml}</div></div>` : ''}
      ${spec.shell_script ? `<div class="spec-field"><div class="spec-field-label">shell script</div><div class="spec-script">${escapeHtml(spec.shell_script)}</div></div>` : ''}
    `;
  }

  // ─── SCHEDULE PICKER ──────────────────────────────────────────────────
  const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function buildGrid(container, items, getKey, getLabel, isSelected, onToggle) {
    container.innerHTML = '';
    items.forEach((it) => {
      const cell = document.createElement('div');
      cell.className = 'cell' + (isSelected(it) ? ' selected' : '');
      cell.textContent = getLabel(it);
      cell.addEventListener('click', () => {
        onToggle(it);
        cell.classList.toggle('selected');
        updatePreview();
      });
      container.appendChild(cell);
    });
  }

  function rebuildGrids() {
    // Weekly
    buildGrid(
      $('#weekday-grid'),
      [0, 1, 2, 3, 4, 5, 6],
      (i) => i,
      (i) => WEEKDAY_LABELS[i],
      (i) => state.schedule.weekly.weekdays.includes(i),
      (i) => {
        const arr = state.schedule.weekly.weekdays;
        const idx = arr.indexOf(i);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(i);
      }
    );
    // Monthly days
    const monthDays = Array.from({ length: 31 }, (_, i) => i + 1);
    buildGrid(
      $('#month-day-grid'),
      monthDays,
      (d) => d,
      (d) => String(d),
      (d) => state.schedule.monthly.days.includes(d),
      (d) => {
        const arr = state.schedule.monthly.days;
        const idx = arr.indexOf(d);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(d);
      }
    );
    // Yearly months
    buildGrid(
      $('#year-month-grid'),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      (m) => m,
      (m) => MONTH_LABELS[m - 1],
      (m) => state.schedule.yearly.months.includes(m),
      (m) => {
        const arr = state.schedule.yearly.months;
        const idx = arr.indexOf(m);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(m);
      }
    );
    // Yearly days
    buildGrid(
      $('#year-day-grid'),
      monthDays,
      (d) => d,
      (d) => String(d),
      (d) => state.schedule.yearly.days.includes(d),
      (d) => {
        const arr = state.schedule.yearly.days;
        const idx = arr.indexOf(d);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(d);
      }
    );
  }

  function rebuildTimeChips() {
    const modes = ['daily', 'weekly', 'monthly', 'yearly'];
    modes.forEach((mode) => {
      const container = $('#' + mode + '-times');
      container.innerHTML = '';
      state.schedule[mode].hours.forEach((h, idx) => {
        const chip = document.createElement('span');
        chip.className = 'time-chip';
        chip.innerHTML = `${String(h).padStart(2, '0')}:00 <span class="x">✕</span>`;
        chip.title = '撳走';
        chip.addEventListener('click', () => {
          state.schedule[mode].hours.splice(idx, 1);
          rebuildTimeChips();
          updatePreview();
        });
        container.appendChild(chip);
      });
    });
  }

  function setupTimeAdders() {
    ['daily', 'weekly', 'monthly', 'yearly'].forEach((mode) => {
      $('#' + mode + '-time-add').addEventListener('click', () => {
        const input = $('#' + mode + '-time-input');
        const val = input.value;
        if (!val) return;
        const h = parseInt(val.split(':')[0], 10);
        if (Number.isNaN(h)) return;
        const arr = state.schedule[mode].hours;
        if (!arr.includes(h)) {
          arr.push(h);
          arr.sort((a, b) => a - b);
          rebuildTimeChips();
          updatePreview();
        }
      });
    });
  }

  // Mode tab switching
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      state.schedule.mode = mode;
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.mode-panel').forEach((p) => p.classList.toggle('active', p.dataset.mode === mode));
      updatePreview();
    });
  });

  $('#tz-select').addEventListener('change', (e) => {
    state.schedule.timezone = e.target.value;
    updatePreview();
  });

  // ─── PREVIEW + SAVE ───────────────────────────────────────────────────
  function buildSchedulePayload() {
    const m = state.schedule.mode;
    const payload = { mode: m, timezone: state.schedule.timezone, minutes: [0] };
    if (m === 'daily') {
      payload.hours = state.schedule.daily.hours;
    } else if (m === 'weekly') {
      payload.hours = state.schedule.weekly.hours;
      payload.weekdays = state.schedule.weekly.weekdays;
    } else if (m === 'monthly') {
      payload.hours = state.schedule.monthly.hours;
      payload.days = state.schedule.monthly.days;
    } else if (m === 'yearly') {
      payload.hours = state.schedule.yearly.hours;
      payload.days = state.schedule.yearly.days;
      payload.months = state.schedule.yearly.months;
    }
    return payload;
  }

  function cronPreview(p) {
    const fmt = (a, max) => (!a || a.length === 0 || a.length === max ? '*' : a.join(','));
    return [fmt(p.minutes, 60), fmt(p.hours, 24), fmt(p.days, 31), fmt(p.months, 12), fmt(p.weekdays, 7)].join(' ');
  }

  function validSchedule(p) {
    if (!p.hours || p.hours.length === 0) return false;
    if (p.mode === 'weekly' && (!p.weekdays || p.weekdays.length === 0)) return false;
    if (p.mode === 'monthly' && (!p.days || p.days.length === 0)) return false;
    if (p.mode === 'yearly' && ((!p.days || p.days.length === 0) || (!p.months || p.months.length === 0))) return false;
    return true;
  }

  function updatePreview() {
    const p = buildSchedulePayload();
    const ok = validSchedule(p);
    $('#sched-preview').textContent = ok ? cronPreview(p) + ' (' + p.timezone + ')' : '⚠ 揀齊先';
    updateSaveButton();
  }

  function updateSaveButton() {
    const p = buildSchedulePayload();
    const canSave = !!state.spec && validSchedule(p) && !state.saving;
    $('#btn-save').disabled = !canSave;
  }

  $('#btn-save').addEventListener('click', async () => {
    if (!state.spec) return;
    const p = buildSchedulePayload();
    if (!validSchedule(p)) return;

    state.saving = true;
    updateSaveButton();
    $('#save-status').textContent = '寫緊…';

    try {
      const r = await fetch(API + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: state.spec.name,
          description: state.spec.description,
          shell_script: state.spec.shell_script,
          schedule: p,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        $('#save-status').textContent = '⚠ ' + (data.error || 'failed');
        $('#save-status').style.color = 'var(--red)';
      } else {
        $('#save-status').textContent = '✓ 已寫入 (id ' + data.id + ')';
        $('#save-status').style.color = 'var(--green)';
        loadJobs();
      }
    } catch (e) {
      $('#save-status').textContent = '⚠ ' + e.message;
      $('#save-status').style.color = 'var(--red)';
    } finally {
      state.saving = false;
      updateSaveButton();
    }
  });

  // ─── JOBS LIST ────────────────────────────────────────────────────────
  async function loadJobs() {
    const body = $('#jobs-body');
    body.innerHTML = '<div class="placeholder">Loading…</div>';
    try {
      const r = await fetch(API + '/jobs');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      if (data._warning) {
        body.innerHTML = '<div class="placeholder">⚠ ' + escapeHtml(data._warning) + '</div>';
        return;
      }
      if (!data.jobs.length) {
        body.innerHTML = '<div class="placeholder">未有任何 automation。喺上面同 AI 設計一條，跟住寫入 Cronicle。</div>';
        return;
      }
      body.innerHTML = data.jobs
        .map(
          (j) => `
            <div class="job-row">
              <div>
                <div class="job-title">${escapeHtml(j.title)}</div>
                ${j.notes ? `<div class="muted small">${escapeHtml(j.notes)}</div>` : ''}
              </div>
              <div class="mono">${escapeHtml(j.cron_preview || '')}<br><span class="small">${escapeHtml(j.timezone || '')}</span></div>
              <div>${j.enabled ? '<span class="badge on">on</span>' : '<span class="badge off">off</span>'}</div>
              <div class="job-actions">
                <button class="small" data-run="${escapeHtml(j.id)}">▶ run</button>
                <button class="small" data-del="${escapeHtml(j.id)}">✕</button>
              </div>
            </div>`
        )
        .join('');
      body.querySelectorAll('[data-run]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '…';
          try {
            const r2 = await fetch(API + '/jobs/' + btn.dataset.run + '/run', { method: 'POST' });
            if (!r2.ok) throw new Error((await r2.json()).error || 'failed');
            btn.textContent = '✓';
          } catch (e) {
            btn.textContent = '⚠';
            alert(e.message);
          } finally {
            setTimeout(() => { btn.disabled = false; btn.textContent = '▶ run'; }, 1500);
          }
        });
      });
      body.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('刪呢條 automation？')) return;
          await fetch(API + '/jobs/' + btn.dataset.del, { method: 'DELETE' });
          loadJobs();
        });
      });
    } catch (e) {
      body.innerHTML = '<div class="placeholder">⚠ ' + escapeHtml(e.message) + '</div>';
    }
  }

  $('#btn-refresh-jobs').addEventListener('click', loadJobs);

  // ─── INIT ─────────────────────────────────────────────────────────────
  rebuildGrids();
  rebuildTimeChips();
  setupTimeAdders();
  updatePreview();
  loadJobs();
  loadHistory();          // restore previous chat for this session_id
  chatInput.focus();
})();
