(() => {
  'use strict';
  const API = '/mission/api';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const state = {
    plans: [],
    batchAnalysis: null,
    batches: [],
    guidelines: [],
    models: [],
    activeMissionId: null,
    activeMission: null,
    activePhase: 'preflight',
    phaseLogs: { preflight: '', coding: '', refill: '', review: '' },
    phaseStatus: { preflight: 'queued', coding: 'queued', refill: 'queued', review: 'queued' },
    lastProgress: null,
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtRelTime(ts) {
    if (!ts) return '';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return Math.round(diff) + 's ago';
    if (diff < 3600) return Math.round(diff / 60) + 'm ago';
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
    return Math.round(diff / 86400) + 'd ago';
  }
  function resumeLabel(mission) {
    const cp = mission && mission.resumeCheckpoint;
    if (!cp) return '繼續呢一步';
    if (cp.stage === 'preflight') return '重跑 Context Scout';
    if (cp.stage === 'planner') return '重跑 Planner';
    if (cp.stage === 'summary') return '繼續 Final Summary';
    const bits = [];
    if (cp.subPhaseId) bits.push(cp.subPhaseId);
    if (cp.iteration !== undefined) bits.push('iter ' + cp.iteration);
    if (cp.phase) bits.push(cp.phase);
    return bits.length ? '繼續：' + bits.join(' · ') : '繼續呢一步';
  }
  function canResume(mission) {
    return !!mission && mission.autoOrchestrate && ['paused_for_human', 'error'].includes(mission.status);
  }
  function updateResumeButton(mission) {
    const btn = $('#btn-resume');
    if (!btn) return;
    const visible = canResume(mission);
    btn.style.display = visible ? 'inline-flex' : 'none';
    btn.disabled = false;
    btn.textContent = visible ? '▶ ' + resumeLabel(mission) : '▶ 繼續呢一步';
    btn.title = visible ? '重跑卡住嗰一步，成功後自動接住下一步' : '';
  }

  function phaseBucket(phase) {
    if (phase === 'preflight' || phase === 'planner') return 'preflight';
    if (phase === 'refill') return 'refill';
    if (phase === 'review' || phase === 'review-after-refill' || phase === 'final-summary') return 'review';
    return 'coding';
  }

  function ensurePhaseLog(phase) {
    const bucket = phaseBucket(phase);
    if (state.phaseLogs[bucket] === undefined) state.phaseLogs[bucket] = '';
    if (state.phaseStatus[bucket] === undefined) state.phaseStatus[bucket] = 'queued';
    return bucket;
  }

  function formatNumber(n) {
    const value = Number(n || 0);
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return Math.round(value / 100) / 10 + 'k';
    return String(value || '--');
  }

  const DASHBOARD_ONLY_AGENT_KEYS = new Set(['observability-engineer', 'cost-analyst']);

  function fallbackPromptActiveKeys(m, activeStage) {
    if (!m || m.status === 'done') return [];
    if (activeStage === 'preflight' || m.status === 'preflight') return ['context-scout'];
    if (activeStage === 'planner' || m.status === 'planning') return ['mission-director', 'goal-planner'];
    if (activeStage === 'review' || activeStage === 'review-after-refill') return ['reviewer'];
    if (activeStage === 'refill') return [];
    if (activeStage === 'final-summary') return ['docs-writer'];
    return ['coder'];
  }

  function promptActiveKeys(m, progress, activeStage) {
    if (progress && Array.isArray(progress.promptRoleKeys)) return progress.promptRoleKeys;
    if (m && Array.isArray(m.promptActiveRoleKeys) && m.promptActiveRoleKeys.length) return m.promptActiveRoleKeys;
    return fallbackPromptActiveKeys(m, activeStage);
  }

  function promptModeForAgent(agent, activeKeySet) {
    if (activeKeySet.has(agent.key)) return 'prompt-active';
    if (agent.key === 'context-scout') return 'preflight-only';
    if (agent.dashboardOnly || DASHBOARD_ONLY_AGENT_KEYS.has(agent.key)) return 'dashboard-only';
    return 'standby';
  }

  // ─── Socket.io ────────────────────────────────────────────────────────
  const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

  socket.on('mission:phase-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    const bucket = ensurePhaseLog(e.phase);
    state.phaseStatus[bucket] = 'running';
    appendLog(bucket, `\n──── ▶ phase=${e.phase} model=${e.model} started ────\n`, 'info');
    setActivePhase(bucket);
    renderPhaseDots();
    setMissionStatus('running');
    renderMissionOverview(state.activeMission, e);
  });

  socket.on('mission:line', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog(ensurePhaseLog(e.phase), e.line + '\n', null);
  });

  socket.on('mission:err', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog(ensurePhaseLog(e.phase), '[stderr] ' + e.chunk, 'err');
  });

  socket.on('mission:phase-fallback', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog(ensurePhaseLog(e.phase), `\n──── ↳ fallback ${e.fromModel} → ${e.toModel} ────\n`, 'info');
  });

  socket.on('mission:phase-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    const bucket = ensurePhaseLog(e.phase);
    state.phaseStatus[bucket] = e.exitCode === 0 ? 'done' : 'error';
    appendLog(bucket, `\n──── ✓ phase=${e.phase} fileCount=${e.fileCount || 0} duration=${(e.durationMs/1000).toFixed(1)}s ────\n`, 'info');
    renderPhaseDots();
    renderMissionOverview(state.activeMission, e);
  });

  // v3 — Auto-orchestrator events
  socket.on('mission:preflight-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.phaseStatus.preflight = 'running';
    appendLog('preflight', `\n──── ⌕ Context Scout preflight started model=${e.model} ────\n`, 'info');
    setActivePhase('preflight');
    setMissionStatus('preflight');
    renderPhaseDots();
    renderMissionOverview(state.activeMission, { stage: 'preflight', promptRoleKeys: e.promptRoleKeys || [] });
  });
  socket.on('mission:preflight-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.phaseStatus.preflight = 'done';
    appendLog('preflight', `\n──── ✓ Context map ready ${(e.durationMs / 1000).toFixed(1)}s ────\n`, 'info');
    appendLog('preflight', `context-map.md: ${e.pathMd}\ncontext-map.json: ${e.pathJson}\n`, 'info');
    renderPhaseDots();
    refreshMissionState();
  });
  socket.on('mission:planner-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('preflight', `\n──── 🧠 Planner 開始拆 sub-phase ────\n`, 'info');
    setMissionStatus('planning');
  });
  socket.on('mission:planner-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('preflight', `\n──── ✓ Planner 出咗 ${e.count} 個 sub-phase ────\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:subphase-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.activeSubPhaseId = e.subPhaseId;
    appendLog('coding', `\n══════ Sub-phase ${e.subPhaseId} 開始: ${e.title} ══════\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:iteration-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    const emoji = e.verdict === 'PASS' ? '✓' : e.verdict === 'WARN' ? '⚠' : '✗';
    const tail = e.afterRefill ? ' after refill' : '';
    appendLog('review', `\n──── ${emoji} Iteration ${e.iteration}${tail} 完成: ${e.verdict} ────\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:subphase-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n══════ Sub-phase ${e.subPhaseId} 完成: ${e.verdict} ══════\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:subphase-paused', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n‼ Sub-phase ${e.subPhaseId} 用咗 ${e.iterations} 次 iteration 仍未 pass — PAUSED ‼\n`, 'err');
    setMissionStatus('paused_for_human');
    refreshMissionState();
  });
  socket.on('mission:summary-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n══════ 🧾 Final summary 寫緊… ══════\n`, 'info');
    setMissionStatus('summarizing');
  });

  socket.on('mission:progress', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.lastProgress = e;
    $('#progress-strip').style.display = 'block';
    const min = Math.floor(e.elapsedMs / 60000);
    const sec = Math.floor((e.elapsedMs % 60000) / 1000);
    $('#progress-elapsed').textContent = `${min}m ${sec}s`;
    // parse CPU from cpuInfo (1st line: "PID ETIME TIME %CPU %MEM")
    let cpu = '--';
    if (e.cpuInfo) {
      const parts = e.cpuInfo.split('\n')[0].trim().split(/\s+/);
      if (parts.length >= 4) cpu = parts[3] + '%';
    }
    $('#progress-cpu').textContent = cpu + ' CPU';
    const commitsEl = $('#progress-commits');
    commitsEl.textContent = `${e.commitsMade} commit${e.commitsMade === 1 ? '' : 's'}` + (e.latestCommit ? ` · ${e.latestCommit.slice(0, 60)}` : '');
    commitsEl.classList.toggle('has-commits', e.commitsMade > 0);
    const modEl = $('#progress-modified');
    modEl.textContent = `${e.workingTreeModified} modified`;
    modEl.classList.toggle('has-changes', e.workingTreeModified > 0);
    const recent = e.recentFiles && e.recentFiles.length
      ? e.recentFiles.slice(0, 3).join(', ')
      : '(thinking — Read/API roundtrips)';
    $('#progress-recent').textContent = recent;
    // Show stage context (sub-phase / iteration / phase)
    if (e.subPhaseId !== undefined || e.stage) {
      const ctx = [];
      if (e.subPhaseId) ctx.push(`sub-${e.subPhaseId}`);
      if (e.iteration !== undefined) ctx.push(`iter ${e.iteration}`);
      if (e.stage) ctx.push(e.stage);
      $('#progress-elapsed').textContent = `[${ctx.join(' · ')}]  ${$('#progress-elapsed').textContent}`;
    }
    renderMissionOverview(state.activeMission, e);
  });

  socket.on('mission:warning-fix', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n──── ⚠ WARN 仲未清，開第 ${e.nextIteration} 次 focused fix ────\n`, 'info');
    refreshMissionState();
  });

  socket.on('mission:done', (e) => {
    if (e.id !== state.activeMissionId) return;
    setMissionStatus('done');
    updateResumeButton(null);
    $('#log-footer').style.display = 'flex';
    loadMissions();
  });

  socket.on('mission:error', (e) => {
    if (e.id !== state.activeMissionId) return;
    const phase = e.phase ? ensurePhaseLog(e.phase) : state.activePhase;
    state.phaseStatus[phase] = 'error';
    appendLog(phase, `\n!! ERROR: ${e.error}\n`, 'err');
    setMissionStatus('error');
    renderPhaseDots();
    refreshMissionState();
    loadMissions();
  });

  socket.on('mission:batch-update', () => {
    loadBatches();
    loadMissions();
  });

  // ─── Parallel (wave) events ───────────────────────────────────────────
  socket.on('mission:parallel-plan', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.parallelPlan = e;
    const lines = (e.waves || []).map((w, i) => `  Wave ${i + 1}: ${w.join(', ')}`).join('\n');
    appendLog('coding', `\n⚡ 並行計劃 — ${(e.waves || []).length} 波 (每波最多 ${e.maxConcurrency} 條並行)\n${lines}\n`, 'info');
    if (e.warnings && e.warnings.length) {
      appendLog('coding', `  ⚠ planner warnings: ${e.warnings.join('; ')}\n`, 'info');
    }
    refreshMissionState();
  });
  socket.on('mission:wave-start', (e) => {
    if (e.id !== state.activeMissionId) return;
    state.currentWave = e.wave;
    appendLog('coding', `\n══════ ⚡ Wave ${e.wave}/${e.total} 並行開始: ${(e.subPhaseIds || []).join(', ')} ══════\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:wave-end', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n══════ ✓ Wave ${e.wave} 全部 merge 返主 branch ══════\n`, 'info');
    refreshMissionState();
  });
  socket.on('mission:wave-conflict', (e) => {
    if (e.id !== state.activeMissionId) return;
    appendLog('review', `\n⚠ Sub-phase ${e.subPhaseId} merge 撞 file (${(e.conflictFiles || []).join(', ')}) — 降級順序 rebuild\n`, 'err');
    refreshMissionState();
  });

  // ─── Setup form ───────────────────────────────────────────────────────
  async function loadPlans() {
    const r = await fetch(API + '/handoffs');
    const data = await r.json();
    state.plans = data.files;
    $('#handoff-dir-hint').textContent = data.dir;
    const sel = $('#plan-select');
    if (state.plans.length === 0) {
      sel.innerHTML = '<option value="">(handoffs folder 空 — 喺 ~/handoffs/ 寫個 plan 先)</option>';
      renderBatchPlanList();
      return;
    }
    sel.innerHTML = state.plans
      .map((p) => `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)} · ${fmtRelTime(p.mtime)}</option>`)
      .join('');
    renderBatchPlanList();
    // Auto-load preview of newest
    onPlanChange();
  }

  async function onPlanChange() {
    const planPath = $('#plan-select').value;
    if (!planPath) return;
    const plan = state.plans.find((p) => p.path === planPath);
    if (!plan) return;
    try {
      // We can't fetch arbitrary VPS files; show preview via dedicated endpoint? For now show metadata.
      $('#plan-preview').textContent = `📄 ${plan.name}\n   path: ${plan.path}\n   size: ${plan.size} bytes\n   modified: ${new Date(plan.mtime).toLocaleString()}\n\n(完整內容會喺 mission 開始時讀)`;
    } catch (e) {
      $('#plan-preview').textContent = '(preview 失敗)';
    }
  }

  function selectedBatchPlanPaths() {
    return $$('[data-batch-plan]:checked').map((el) => el.value);
  }

  function renderBatchPlanList() {
    const body = $('#batch-plan-list');
    if (!body) return;
    if (state.plans.length === 0) {
      body.innerHTML = '<div class="placeholder">未有 handoff plan。</div>';
      return;
    }
    body.innerHTML = state.plans.slice(0, 20).map((p, idx) => `
      <label class="batch-plan-row">
        <input type="checkbox" data-batch-plan value="${escapeHtml(p.path)}" ${idx < 3 ? 'checked' : ''} />
        <span class="batch-plan-copy">
          <b>${escapeHtml(p.name)}</b>
          <em>${escapeHtml(fmtRelTime(p.mtime))} · ${escapeHtml(String(p.size))}b</em>
        </span>
      </label>
    `).join('');
    body.querySelectorAll('[data-batch-plan]').forEach((box) => {
      box.addEventListener('change', () => {
        state.batchAnalysis = null;
        renderBatchAnalysis(null);
      });
    });
  }

  function modelPayload() {
    return {
      planner: $('#model-planner').value,
      coding: $('#model-coding').value,
      refill: $('#model-refill').value,
      review: $('#model-review').value,
      finalSummary: $('#model-finalSummary').value,
    };
  }

  function renderBatchAnalysis(payload) {
    const body = $('#batch-analysis');
    const confirm = $('#btn-confirm-batch');
    if (!body || !confirm) return;
    if (!payload || !payload.analysis) {
      confirm.disabled = true;
      body.innerHTML = '<div class="placeholder">揀 2 個或以上 plan 之後分析。</div>';
      return;
    }
    const { analysis, dirtyStatus } = payload;
    confirm.disabled = false;
    const collisionFiles = new Set((analysis.collisions || []).map((c) => c.file));
    const dirtyHtml = dirtyStatus && dirtyStatus.error
      ? `<div class="batch-warning">Repo preflight 暫時讀唔到：${escapeHtml(dirtyStatus.error)}</div>`
      : dirtyStatus && dirtyStatus.dirty
        ? `<div class="batch-warning">Dirty repo：${escapeHtml(String(dirtyStatus.files.length))} 個現有改動。Queue 會照跑，但會保守處理。</div>`
        : '<div class="batch-ok">Repo preflight 冇見到 dirty working tree。</div>';
    const collisionHtml = (analysis.collisions || []).length
      ? `<div class="batch-warning">預測撞 file：${analysis.collisions.map((c) => `<code>${escapeHtml(c.file)}</code>`).join(' ')}</div>`
      : '<div class="batch-ok">預測冇 overlapping file。</div>';
    const itemsHtml = (analysis.items || []).map((item) => {
      const files = (item.predictedFiles || []).slice(0, 8);
      return `
        <div class="batch-analysis-row ${item.collisionGroup ? 'has-collision' : ''}">
          <div class="batch-order">${escapeHtml(String(item.order || '-'))}</div>
          <div class="batch-analysis-main">
            <b>${escapeHtml(item.title || item.fileName || item.planPath)}</b>
            <span>${escapeHtml(item.reason || '照安全 queue 執行')}</span>
            <div class="batch-file-list">
              ${files.length ? files.map((file) => `<code class="${collisionFiles.has(file) ? 'hot' : ''}">${escapeHtml(file)}</code>`).join('') : '<em class="muted small">未預測到特定 file</em>'}
            </div>
          </div>
          <span class="collision-pill ${item.collisionGroup ? 'hot' : ''}">${escapeHtml(item.collisionGroup || 'clear')}</span>
        </div>
      `;
    }).join('');
    body.innerHTML = `
      ${dirtyHtml}
      ${collisionHtml}
      <div class="batch-note">${escapeHtml(analysis.planner || 'planner')} · ${escapeHtml(analysis.note || '')}</div>
      <div class="batch-analysis-list">${itemsHtml}</div>
    `;
  }

  async function analyzeBatch() {
    const planPaths = selectedBatchPlanPaths();
    if (planPaths.length < 2) { alert('至少揀 2 個 plan 先做到 batch analysis'); return; }
    const btn = $('#btn-analyze-batch');
    btn.disabled = true;
    $('#batch-status').textContent = '分析緊… Sonnet 會望一望依賴同撞 file';
    try {
      const r = await fetch(API + '/batches/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_paths: planPaths,
          target_project: $('#target-project').value.trim(),
          planner_model: 'sonnet',
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'analysis failed');
      state.batchAnalysis = data;
      renderBatchAnalysis(data);
      $('#batch-status').textContent = '✓ Analysis ready';
    } catch (e) {
      $('#batch-status').textContent = '⚠ ' + e.message;
      $('#batch-status').style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
    }
  }

  async function confirmBatch() {
    if (!state.batchAnalysis || !state.batchAnalysis.analysis) return;
    const btn = $('#btn-confirm-batch');
    btn.disabled = true;
    $('#batch-status').textContent = '排隊中…';
    try {
      const r = await fetch(API + '/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis: state.batchAnalysis.analysis,
          target_project: $('#target-project').value.trim(),
          models: modelPayload(),
          auto_orchestrate: $('#auto-orchestrate').checked,
          smart_route: $('#smart-route').checked,
          warning_policy: $('#warning-policy').value,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'queue failed');
      $('#batch-status').textContent = '✓ Batch ' + data.id + ' 已入 queue';
      state.batchAnalysis = null;
      renderBatchAnalysis(null);
      loadBatches();
      loadMissions();
      const first = data.batch && data.batch.items && data.batch.items[0];
      if (first && first.linkedMissionId) activateMission(first.linkedMissionId, null);
    } catch (e) {
      $('#batch-status').textContent = '⚠ ' + e.message;
      $('#batch-status').style.color = 'var(--red)';
      btn.disabled = false;
    }
  }

  function renderBatches() {
    const body = $('#batch-queue-list');
    if (!body) return;
    if (!state.batches.length) {
      body.innerHTML = '<div class="placeholder">未有 batch queue。</div>';
      return;
    }
    body.innerHTML = state.batches.slice(0, 5).map((batch) => {
      const active = (batch.items || []).find((item) => item.id === batch.activeItemId)
        || (batch.items || []).find((item) => item.status === 'running');
      const done = (batch.items || []).filter((item) => item.status === 'done').length;
      const total = (batch.items || []).length;
      const blocked = ['paused', 'failed'].includes(batch.status);
      return `
        <div class="batch-queue-row">
          <div class="batch-queue-main">
            <b>${escapeHtml(batch.id)}</b>
            <span>${done}/${total} done · ${active ? escapeHtml(active.title || active.fileName) : escapeHtml(batch.pauseReason || batch.note || 'waiting')}</span>
          </div>
          <span class="status-pill ${escapeHtml(batch.status)}">${escapeHtml(batch.status)}</span>
          <button class="ghost small" data-batch-toggle="${escapeHtml(batch.id)}" data-action="${blocked ? 'resume' : 'pause'}">${blocked ? '▶' : '⏸'}</button>
        </div>
      `;
    }).join('');
    body.querySelectorAll('[data-batch-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const id = btn.dataset.batchToggle;
        await fetch(API + `/batches/${id}/${action}`, { method: 'POST' });
        loadBatches();
      });
    });
  }

  async function loadBatches() {
    try {
      const r = await fetch(API + '/batches');
      const data = await r.json();
      state.batches = data.batches || [];
      renderBatches();
    } catch {}
  }

  async function loadGuidelines() {
    const r = await fetch(API + '/guidelines');
    const data = await r.json();
    state.guidelines = data.files;
    const body = $('#guidelines-list');
    if (state.guidelines.length === 0) {
      body.innerHTML = '<div class="placeholder">(empty — 喺 ~/guidelines/ 加 *.md)</div>';
      return;
    }
    body.innerHTML = state.guidelines
      .map((g) => `<div class="guideline-row">✓ <span class="mono small">${escapeHtml(g.name)}</span> <span class="muted small">${g.size}b</span></div>`)
      .join('');
  }

  async function loadModels() {
    const r = await fetch(API + '/models');
    const data = await r.json();
    state.models = data.models;
    const defaults = { coding: 'gpt-5.5', refill: 'opus', review: 'opus', planner: 'gpt-5.5', finalSummary: 'opus' };
    for (const phase of ['planner', 'coding', 'refill', 'review', 'finalSummary']) {
      const sel = $('#model-' + phase);
      if (!sel) continue;
      sel.innerHTML = state.models
        .map((m) => `<option value="${m}"${m === defaults[phase] ? ' selected' : ''}>${m}</option>`)
        .join('');
    }
  }

  $('#btn-refresh-plans').addEventListener('click', loadPlans);
  $('#plan-select').addEventListener('change', onPlanChange);
  $('#btn-analyze-batch').addEventListener('click', analyzeBatch);
  $('#btn-confirm-batch').addEventListener('click', confirmBatch);
  $('#btn-refresh-batches').addEventListener('click', loadBatches);

  $('#btn-create').addEventListener('click', async () => {
    const planPath = $('#plan-select').value;
    if (!planPath) { alert('揀個 plan 先'); return; }
    const targetProject = $('#target-project').value.trim();
    const title = $('#title-input').value.trim();
    const autoOrchestrate = $('#auto-orchestrate').checked;
    const smartRoute = $('#smart-route').checked;
    const warningPolicy = $('#warning-policy').value;
    const models = {
      planner: $('#model-planner').value,
      coding: $('#model-coding').value,
      refill: $('#model-refill').value,
      review: $('#model-review').value,
      finalSummary: $('#model-finalSummary').value,
    };
    $('#btn-create').disabled = true;
    $('#create-status').textContent = '建緊…';

    try {
      const r = await fetch(API + '/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_path: planPath,
          target_project: targetProject,
          title: title || null,
          models,
          auto_orchestrate: autoOrchestrate,
          smart_route: smartRoute,
          warning_policy: warningPolicy,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      $('#create-status').textContent = '✓ Mission ' + data.id + ' 創立';
      activateMission(data.id, data.mission);
      loadMissions();
    } catch (e) {
      $('#create-status').textContent = '⚠ ' + e.message;
      $('#create-status').style.color = 'var(--red)';
    } finally {
      $('#btn-create').disabled = false;
    }
  });

  // ─── Active mission + log stream ──────────────────────────────────────
  async function refreshMissionState() {
    if (!state.activeMissionId) return;
    try {
      const r = await fetch(API + '/missions/' + state.activeMissionId);
      if (!r.ok) return;
      const m = await r.json();
      state.activeMission = m;
      syncPhaseStatusFromMission(m);
      setMissionStatus(m.status);
      updateResumeButton(m);
      renderSubPhaseBar(m);
      renderPhaseDots();
      renderMissionOverview(m, state.lastProgress);
    } catch {}
  }

  function renderMissionOverview(m, progress) {
    const panel = $('#mission-overview');
    if (!panel) return;
    const intelligence = m && m.intelligence;
    if (!intelligence || !intelligence.complexity) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    const complexity = intelligence.complexity;
    const route = intelligence.route || {};
    const budget = intelligence.tokenBudget || {};
    const roster = Array.isArray(intelligence.roster) ? intelligence.roster : [];
    $('#complexity-score').textContent = complexity.score || '--';
    $('#complexity-band').textContent = complexity.band || 'unknown';
    $('#complexity-orb').className = 'complexity-orb ' + (complexity.band || 'standard');

    const models = m.models || (route && route.models) || {};
    $('#route-line').textContent = [
      `Scout ${models.contextScout || models.planner || '-'}`,
      `Planner ${models.planner || '-'}`,
      `Code ${models.coding || '-'}`,
      `Review ${models.review || '-'}`,
      `Refill ${models.refill || '-'}`,
    ].join(' · ');
    $('#route-note').textContent = `${route.strategy || 'manual'} · warning gate: ${m.warningPolicy || 'strict'}`;
    $('#budget-tokens').textContent = formatNumber(budget.estimatedTokens);
    $('#budget-note').textContent = budget.savingsPct !== undefined
      ? `估計慳 ${budget.savingsPct}% · 約 ${budget.expandedUsage || 1}x Cloud CLI 用量空間`
      : '等待 budget';

    const activeStage = (progress && (progress.stage || progress.phase)) || m.status;
    const activeKeys = promptActiveKeys(m, progress, activeStage);
    const activeKeySet = new Set(activeKeys);
    const done = m.status === 'done';
    const error = ['error', 'paused_for_human'].includes(m.status);

    $('#agent-count').textContent = `${roster.length} roles · ${activeKeys.length} prompt-active now`;
    $('#agent-board').innerHTML = roster.map((agent) => {
      const mode = promptModeForAgent(agent, activeKeySet);
      let status = 'queued';
      if (done) status = 'done';
      else if (error && (agent.group === 'review' || agent.group === 'risk')) status = 'blocked';
      else if (mode === 'prompt-active') status = 'running';
      else if (mode === 'dashboard-only' && ['preflight', 'planning', 'executing', 'summarizing'].includes(m.status)) status = 'watching';

      const step = status === 'running'
        ? (activeStage ? `處理 ${activeStage}` : '工作中')
        : status === 'watching'
          ? '監控中'
          : status === 'done'
            ? '完成'
            : status === 'blocked'
              ? '等你接手'
              : mode === 'dashboard-only'
                ? '只顯示狀態'
                : mode === 'preflight-only'
                  ? '等 preflight'
                  : agent.currentStep || '待命';
      return `
        <div class="agent-tile ${status} ${mode}" title="${escapeHtml((agent.group || '') + ' · ' + (agent.prompt || ''))}">
          <span class="agent-icon">${escapeHtml(agent.icon || '·')}</span>
          <div class="agent-copy">
            <b>${escapeHtml(agent.name)}</b>
            <span>${escapeHtml(step)} · ${escapeHtml(agent.model || '-')}</span>
          </div>
          <em>${escapeHtml(mode)}</em>
        </div>
      `;
    }).join('');
  }

  function syncPhaseStatusFromMission(m) {
    if (!m) return;
    state.phaseStatus.preflight = m.contextScout
      ? (m.status === 'planning' ? 'running' : 'done')
      : (m.status === 'preflight' ? 'running' : 'queued');
    if (m.currentPhase) {
      state.phaseStatus[phaseBucket(m.currentPhase)] = 'running';
    }
  }

  function renderSubPhaseBar(m) {
    const bar = $('#subphase-bar');
    if (!m.autoOrchestrate || !m.subPhases || m.subPhases.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'block';
    const pass = m.subPhases.filter((sp) => sp.finalVerdict === 'PASS').length;
    const warn = m.subPhases.filter((sp) => sp.finalVerdict === 'WARN').length;
    const fail = m.subPhases.filter((sp) => sp.finalVerdict === 'FAIL').length;
    // Map each sub-phase id → its wave number when running in parallel.
    const waves = (m.parallel && m.parallel.enabled && Array.isArray(m.parallel.waves)) ? m.parallel.waves : null;
    const waveOf = {};
    if (waves) waves.forEach((w, wi) => w.forEach((id) => { waveOf[id] = wi + 1; }));
    const parallelTag = waves ? ` · ⚡${waves.length} 波並行` : '';
    $('#subphase-summary').textContent = `${pass}✓ ${warn}⚠ ${fail}✗ / ${m.subPhases.length}${parallelTag}`;
    $('#subphase-list').innerHTML = m.subPhases.map((sp, i) => {
      const isCurrent = m.currentSubPhaseIdx === i;
      const verdict = sp.finalVerdict || sp.status || 'queued';
      const waveLabel = waveOf[sp.id] ? `<span class="sp-wave">W${waveOf[sp.id]}</span> · ` : '';
      return `
        <div class="subphase-row${isCurrent ? ' current' : ''}" data-idx="${i}">
          <span class="sp-id">${escapeHtml(sp.id)}</span>
          <span class="sp-title" title="${escapeHtml(sp.summary || sp.title)}">${escapeHtml(sp.title)}</span>
          <span class="sp-iter">${waveLabel}iter ${sp.iterations.length}</span>
          <span class="sp-verdict ${verdict}">${verdict}</span>
        </div>
      `;
    }).join('');
  }

  function activateMission(id, missionOrNull) {
    if (state.activeMissionId) {
      socket.emit('mission:leave', `mission-${state.activeMissionId}`);
    }
    state.activeMissionId = id;
    state.activeMission = missionOrNull || null;
    state.phaseLogs = { preflight: '', coding: '', refill: '', review: '' };
    state.phaseStatus = { preflight: 'queued', coding: 'queued', refill: 'queued', review: 'queued' };
    state.activePhase = 'preflight';
    state.lastProgress = null;
    socket.emit('mission:join', `mission-${id}`);
    $('#active-mission-title').textContent = missionOrNull ? missionOrNull.title : ('Mission ' + id);
    $('#log-stream').innerHTML = '';
    $('#log-footer').style.display = 'none';
    $('#progress-strip').style.display = 'none';
    renderPhaseDots();
    setActivePhase('preflight');
    setMissionStatus('queued');
    renderMissionOverview(missionOrNull, null);

    // Load existing state if mission has prior phases
    fetch(API + '/missions/' + id).then((r) => r.json()).then((m) => {
      if (m.phases) {
        for (const ph of Object.keys(m.phases)) {
          state.phaseStatus[ph] = (m.phases[ph].exitCode === 0) ? 'done' : 'error';
        }
      }
      syncPhaseStatusFromMission(m);
      state.activeMission = m;
      renderPhaseDots();
      setMissionStatus(m.status);
      updateResumeButton(m);
      renderSubPhaseBar(m);
      renderMissionOverview(m, state.lastProgress);
      // load transcripts
      for (const ph of ['preflight', 'coding', 'refill', 'review']) {
        if (ph === 'preflight' || (m.phases && m.phases[ph])) {
          fetch(API + `/missions/${id}/transcript/${ph}`)
            .then((r) => (r.ok ? r.text() : ''))
            .then((txt) => { state.phaseLogs[ph] = txt; if (state.activePhase === ph) renderActiveLog(); });
        }
      }
    });
  }

  function appendLog(phase, text, kind) {
    if (kind === 'err') text = `<span class="err-line">${escapeHtml(text)}</span>`;
    else if (kind === 'info') text = `<span class="info-line">${escapeHtml(text)}</span>`;
    else text = escapeHtml(text);
    state.phaseLogs[phase] += text;
    if (state.activePhase === phase) {
      const stream = $('#log-stream');
      const wasAtBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 30;
      stream.insertAdjacentHTML('beforeend', text);
      if (wasAtBottom) stream.scrollTop = stream.scrollHeight;
    }
  }

  function renderActiveLog() {
    const stream = $('#log-stream');
    if (!state.phaseLogs[state.activePhase]) {
      stream.innerHTML = '<div class="placeholder">(尚未開始)</div>';
      return;
    }
    stream.innerHTML = state.phaseLogs[state.activePhase];
    stream.scrollTop = stream.scrollHeight;
  }

  function setActivePhase(phase) {
    state.activePhase = phase;
    $$('.phase-tab').forEach((t) => t.classList.toggle('active', t.dataset.phase === phase));
    renderActiveLog();
  }

  function renderPhaseDots() {
    $$('.phase-tab').forEach((tab) => {
      const ph = tab.dataset.phase;
      const dot = tab.querySelector('.phase-dot');
      dot.className = 'phase-dot ' + (state.phaseStatus[ph] || 'queued');
    });
  }

  function setMissionStatus(status) {
    const pill = $('#active-mission-status');
    pill.className = 'status-pill ' + (status || 'idle');
    pill.textContent = status || 'idle';
  }

  $$('.phase-tab').forEach((tab) => tab.addEventListener('click', () => setActivePhase(tab.dataset.phase)));

  $('#btn-resume').addEventListener('click', async () => {
    if (!state.activeMissionId || !canResume(state.activeMission)) return;
    const btn = $('#btn-resume');
    btn.disabled = true;
    btn.textContent = '▶ 接續中…';
    try {
      const r = await fetch(API + `/missions/${state.activeMissionId}/resume`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'resume failed');
      appendLog(state.activePhase, `\n──── ▶ Resume requested: ${resumeLabel({ resumeCheckpoint: data.checkpoint })} ────\n`, 'info');
      setMissionStatus('queued');
      loadMissions();
      refreshMissionState();
    } catch (e) {
      alert('Resume failed: ' + e.message);
      updateResumeButton(state.activeMission);
    }
  });

  // ─── Missions list ────────────────────────────────────────────────────
  async function loadMissions() {
    const r = await fetch(API + '/missions');
    const data = await r.json();
    const body = $('#missions-body');
    if (!data.missions.length) {
      body.innerHTML = '<div class="placeholder">未有 mission。撳左邊「Run Mission」開始。</div>';
      return;
    }
    body.innerHTML = data.missions
      .map((m) => {
        const cx = m.intelligence && m.intelligence.complexity;
        const route = m.intelligence && m.intelligence.route;
        const smart = cx ? `${cx.score}/100 ${cx.band} · ${route ? route.strategy : 'manual'}` : 'legacy mission';
        return `
        <div class="mission-row${m.id === state.activeMissionId ? ' active' : ''}" data-id="${escapeHtml(m.id)}">
          <div>
            <div class="mission-title">${escapeHtml(m.title || m.id)}</div>
            <div class="muted small">${escapeHtml(m.id)} · ${fmtRelTime(m.updatedAt)} · ${escapeHtml(smart)}</div>
          </div>
          <div><span class="status-pill ${m.status}">${m.status}</span></div>
          <div class="mission-progress" data-id="${escapeHtml(m.id)}"></div>
          <div class="mission-actions">
            <button class="small" data-view="${escapeHtml(m.id)}">📡 view</button>
            <button class="small" data-rerun="${escapeHtml(m.id)}">↻</button>
            <button class="small" data-del="${escapeHtml(m.id)}">✕</button>
          </div>
        </div>`;
      })
      .join('');
    // Inject phase dots for each row based on m.phases (we don't have phases in summary, fall back to current/status)
    body.querySelectorAll('.mission-row').forEach((row) => {
      const id = row.dataset.id;
      const mission = data.missions.find((m) => m.id === id);
      const dotsEl = row.querySelector('.mission-progress');
      const phases = ['preflight', 'coding', 'refill', 'review'];
      dotsEl.innerHTML = phases.map((ph) => {
        let cls = 'queued';
        const activeBucket = ['preflight', 'planning'].includes(mission.status) ? 'preflight' : phaseBucket(mission.currentPhase);
        if (activeBucket === ph && ['preflight', 'running', 'executing', 'planning', 'summarizing'].includes(mission.status)) cls = 'running';
        else if (mission.status === 'done') cls = 'done';
        else if (['error', 'paused_for_human'].includes(mission.status) && phaseBucket(mission.currentPhase) === ph) cls = 'error';
        return `<span class="phase-dot ${cls}" title="${ph}"></span>`;
      }).join('');
    });
    body.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      activateMission(btn.dataset.view, data.missions.find((m) => m.id === btn.dataset.view));
    }));
    body.querySelectorAll('[data-rerun]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.activeMissionId = btn.dataset.rerun;
      openRerunModal();
    }));
    body.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('刪呢個 mission？')) return;
      await fetch(API + '/missions/' + btn.dataset.del, { method: 'DELETE' });
      loadMissions();
    }));
    body.querySelectorAll('.mission-row').forEach((row) => row.addEventListener('click', () => {
      activateMission(row.dataset.id, data.missions.find((m) => m.id === row.dataset.id));
    }));
  }
  $('#btn-refresh-missions').addEventListener('click', loadMissions);

  // ─── Findings modal ───────────────────────────────────────────────────
  $('#btn-view-findings').addEventListener('click', async () => {
    if (!state.activeMissionId) return;
    const r = await fetch(API + `/missions/${state.activeMissionId}/findings`);
    if (!r.ok) { alert('未有 findings'); return; }
    $('#findings-body').textContent = await r.text();
    $('#findings-overlay').style.display = 'flex';
  });

  const btnSummary = $('#btn-view-summary');
  if (btnSummary) btnSummary.addEventListener('click', async () => {
    if (!state.activeMissionId) return;
    // Fetch final-summary.md by path from mission state
    const r = await fetch(API + '/missions/' + state.activeMissionId);
    if (!r.ok) { alert('讀唔到 mission state'); return; }
    const m = await r.json();
    if (!m.finalSummary || !m.finalSummary.path) { alert('Final summary 仲未生成'); return; }
    // path is on VPS, fetch via dedicated endpoint:
    const r2 = await fetch(API + '/missions/' + state.activeMissionId + '/summary');
    if (!r2.ok) { alert('Summary 讀取失敗'); return; }
    $('#findings-body').textContent = await r2.text();
    $('#findings-overlay').style.display = 'flex';
  });
  $('#findings-close').addEventListener('click', () => $('#findings-overlay').style.display = 'none');
  $('#findings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'findings-overlay') e.target.style.display = 'none';
  });

  // ─── Rerun modal ──────────────────────────────────────────────────────
  function openRerunModal() {
    $('#rerun-overlay').style.display = 'flex';
  }
  $('#btn-rerun').addEventListener('click', openRerunModal);
  $('#rerun-close').addEventListener('click', () => $('#rerun-overlay').style.display = 'none');
  $('#rerun-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'rerun-overlay') e.target.style.display = 'none';
  });
  $$('.rerun-choice').forEach((btn) => btn.addEventListener('click', async () => {
    const phase = btn.dataset.phase;
    $('#rerun-overlay').style.display = 'none';
    if (!state.activeMissionId) return;
    state.phaseStatus[phase] = 'queued';
    renderPhaseDots();
    const r = await fetch(API + `/missions/${state.activeMissionId}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_phase: phase }),
    });
    if (!r.ok) alert('Rerun failed: ' + (await r.json()).error);
  }));

  // ─── INIT ─────────────────────────────────────────────────────────────
  loadPlans();
  loadGuidelines();
  loadModels();
  loadBatches();
  loadMissions();
})();
